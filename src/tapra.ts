import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateCostTnd, fetchTapraPrices, TapraClient, TapraError, type Tapra, type TapraPrices } from '@tapra/sdk';
import { config, FALLBACK_API_URL } from './config.js';
import { extractWav16k, hasFfmpeg, makeTempDir, probe, removeDir } from './media.js';
import { linkSpeakers, renumberSpeakers } from './speakers.js';

// ---------------------------------------------------------------------------
// API address: TAPRA_API_URL, else whatever the website currently advertises,
// so moving the model host never needs a client update.
// ---------------------------------------------------------------------------

export interface ApiUrl {
  url: string;
  source: 'TAPRA_API_URL' | 'website' | 'fallback';
}

let apiUrlPromise: Promise<ApiUrl> | undefined;
let resolvedApiUrl: ApiUrl | undefined;

async function discoverApiUrl(): Promise<ApiUrl> {
  if (config.apiUrlOverride) return { url: config.apiUrlOverride, source: 'TAPRA_API_URL' };
  try {
    const res = await fetch(`${config.siteUrl}/api/openapi`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const spec = (await res.json()) as { servers?: { url?: string }[] };
      const url = spec.servers?.[0]?.url?.trim().replace(/\/+$/, '');
      if (url && /^https?:\/\//.test(url)) return { url, source: 'website' };
    }
  } catch {
    // Fall through to the fallback address.
  }
  return { url: FALLBACK_API_URL, source: 'fallback' };
}

export function getApiUrl(): Promise<ApiUrl> {
  apiUrlPromise ??= discoverApiUrl().then((r) => {
    resolvedApiUrl = r;
    // Retry discovery on the next call if the website was unreachable.
    if (r.source === 'fallback') apiUrlPromise = undefined;
    return r;
  });
  return apiUrlPromise;
}

export const client = new TapraClient({
  baseUrl: async () => (await getApiUrl()).url,
  ...(config.apiKey ? { apiKey: config.apiKey } : {})
});

/** Fresh idempotency key per logical request, so SDK retries never double-charge. */
export function requestOptions() {
  return { idempotencyKey: randomUUID(), timeoutInSeconds: config.timeoutSeconds, maxRetries: 2 };
}

export function requireApiKey(): void {
  if (!config.apiKey) {
    throw new Error('TAPRA_API_KEY is not set. Create a key at https://tapra.tn/dashboard and add it to the MCP server env.');
  }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

let pricesPromise: Promise<TapraPrices> | undefined;

export function getPrices(): Promise<TapraPrices> {
  pricesPromise ??= fetchTapraPrices({ baseUrl: config.siteUrl }).catch((err) => {
    pricesPromise = undefined;
    throw err;
  });
  return pricesPromise;
}

/** Estimated TND for a request, or null when the price list is unreachable. */
export async function estimate(service: string, quantity: number, multiplier = 1): Promise<number | null> {
  try {
    const prices = await getPrices();
    return estimateCostTnd(prices, service, quantity) * multiplier;
  } catch {
    return null;
  }
}

/** Throws when an estimate is over the caller's limit or TAPRA_MAX_COST_TND. */
export function checkBudget(estimateTnd: number | null, limitTnd: number | undefined, what: string): void {
  const limit = limitTnd ?? config.maxCostTnd;
  if (limit === undefined || estimateTnd === null) return;
  if (estimateTnd > limit) {
    throw new Error(
      `${what} is estimated at ${formatTnd(estimateTnd)}, above the ${formatTnd(limit)} limit. ` +
        'Raise max_cost_tnd (or TAPRA_MAX_COST_TND) to go ahead.'
    );
  }
}

export function formatTnd(tnd: number): string {
  return `${tnd.toFixed(3)} TND`;
}

export class Spend {
  costTnd = 0;
  balanceTnd: number | undefined;
  add(usage: Tapra.Usage | null | undefined): void {
    if (!usage) return;
    this.costTnd += usage.costTnd ?? 0;
    if (typeof usage.balanceTnd === 'number') this.balanceTnd = usage.balanceTnd;
  }
  summary(): string {
    const balance = this.balanceTnd !== undefined ? `, balance left ${formatTnd(this.balanceTnd)}` : '';
    return `Cost: ${formatTnd(this.costTnd)}${balance}.`;
  }
}

/** Ends a message with exactly one period. */
function sentence(message: string): string {
  const m = message.trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** Turns SDK and API errors into one readable line for the model. */
export function describeError(err: unknown): string {
  if (err instanceof TapraError) {
    const body = err.body as { error?: { type?: string; message?: string }; detail?: unknown } | undefined;
    const message = body?.error?.message ?? (typeof body?.detail === 'string' ? body.detail : undefined) ?? err.message;
    const hint =
      err.statusCode === 401
        ? ' Check TAPRA_API_KEY.'
        : err.statusCode === 402
          ? ' Top up your balance at https://tapra.tn/dashboard.'
          : err.statusCode === 413
            ? ' The file is too large; install ffmpeg so long media is split into chunks.'
            : '';
    return `Tapra API error${err.statusCode ? ` ${err.statusCode}` : ''}: ${sentence(message)}${hint}`;
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND') {
      const where = resolvedApiUrl ? `${resolvedApiUrl.url} (from ${resolvedApiUrl.source})` : 'the configured address';
      return `Could not reach the Tapra API at ${where}: ${cause.code}. Set TAPRA_API_URL to override it.`;
    }
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Transcription, split into chunks for long media
// ---------------------------------------------------------------------------

export interface TranscribeOptions {
  language?: string;
  diarize?: boolean;
  prompt?: string;
  wordTimestamps?: boolean;
  chunkMinutes?: number;
  maxCostTnd?: number;
  /** Called before each chunk is sent and once at the end. */
  onProgress?: (done: number, total: number, message: string) => void;
}

export interface MergedTranscript {
  text: string;
  language: string;
  duration: number;
  segments: Tapra.Segment[];
  words: Tapra.Word[];
  turns: Tapra.SpeakerTurn[];
  chunks: number;
  warnings: string[];
  spend: Spend;
}

const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Neighbouring chunks share this much audio. Words are taken from whichever chunk
 * has them away from its cut, and speakers are matched across chunks by who talks
 * in the shared part, so labels stay the same for the whole file.
 */
const CHUNK_OVERLAP_SECONDS = 30;

interface Piece {
  file: string;
  /** Where the extracted audio starts in the original. */
  offset: number;
  /** Keep items whose midpoint is in [keepFrom, keepTo). */
  keepFrom: number;
  keepTo: number;
}

export async function transcribeMedia(inputPath: string, opts: TranscribeOptions): Promise<MergedTranscript> {
  requireApiKey();
  const spend = new Spend();
  const warnings: string[] = [];
  const base = {
    timestamps: (opts.wordTimestamps ? 'word' : 'segment') as Tapra.TranscriptionRequest.Timestamps,
    ...(opts.diarize ? { diarize: true } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {})
  };

  const pieces: Piece[] = [];
  let tmp: string | undefined;
  try {
    if (await hasFfmpeg()) {
      const info = await probe(inputPath);
      if (!info.hasAudio) throw new Error(`No audio track found in ${inputPath}.`);
      const duration = info.durationSeconds ?? 0;
      const chunkSeconds = Math.max(60, (opts.chunkMinutes ?? 15) * 60);
      const chunked = duration > chunkSeconds + 30;
      const count = chunked ? Math.ceil(duration / chunkSeconds) : 1;
      const billed = duration + (count - 1) * CHUNK_OVERLAP_SECONDS;
      checkBudget(await estimate('offline', billed * 1000), opts.maxCostTnd, `Transcribing ${Math.round(duration)} s`);
      tmp = makeTempDir('stt');
      if (chunked) {
        const half = CHUNK_OVERLAP_SECONDS / 2;
        for (let i = 0; i < count; i++) {
          const nominal = i * chunkSeconds;
          const from = i === 0 ? 0 : nominal - CHUNK_OVERLAP_SECONDS;
          const to = Math.min(duration, nominal + chunkSeconds);
          const file = path.join(tmp, `chunk_${String(i).padStart(3, '0')}.wav`);
          await extractWav16k(inputPath, file, from, to - from);
          pieces.push({ file, offset: from, keepFrom: i === 0 ? -Infinity : nominal - half, keepTo: i === count - 1 ? Infinity : nominal + chunkSeconds - half });
        }
      } else {
        const file = path.join(tmp, 'audio.wav');
        await extractWav16k(inputPath, file);
        pieces.push({ file, offset: 0, keepFrom: -Infinity, keepTo: Infinity });
      }
    } else {
      const size = fs.statSync(inputPath).size;
      if (size > MAX_DIRECT_UPLOAD_BYTES) {
        throw new Error('File is over 100 MB. Install ffmpeg so the MCP server can compress and split it.');
      }
      warnings.push('ffmpeg not found: uploaded the file as-is (no cost estimate, no chunking).');
      pieces.push({ file: inputPath, offset: 0, keepFrom: -Infinity, keepTo: Infinity });
    }

    const merged: MergedTranscript = {
      text: '',
      language: '',
      duration: 0,
      segments: [],
      words: [],
      turns: [],
      chunks: pieces.length,
      warnings,
      spend
    };
    const texts: string[] = [];
    let speakerCount = 0;
    const nextId = () => `G${++speakerCount}`;
    // The previous chunk's turns before trimming, under the shared labels.
    let previous: Tapra.SpeakerTurn[] = [];
    for (const [i, piece] of pieces.entries()) {
      opts.onProgress?.(i, pieces.length, pieces.length > 1 ? `Transcribing chunk ${i + 1} of ${pieces.length}` : 'Transcribing');
      const res = await client.transcriptions.create(
        { ...base, file: { path: piece.file, filename: path.basename(piece.file) } },
        requestOptions()
      );
      spend.add(res.usage);
      merged.language ||= res.language;
      merged.duration = Math.max(merged.duration, piece.offset + res.duration);
      const keep = (a: number, b: number) => {
        const mid = (a + b) / 2;
        return mid >= piece.keepFrom && mid < piece.keepTo;
      };
      const chunkTexts: string[] = [];
      for (const s of res.segments) {
        const start = s.start + piece.offset;
        const end = s.end + piece.offset;
        if (!keep(start, end)) continue;
        merged.segments.push({ ...s, id: merged.segments.length, start, end });
        chunkTexts.push(s.text.trim());
      }
      texts.push(pieces.length > 1 ? chunkTexts.join(' ') : res.text.trim());
      for (const w of res.words ?? []) {
        const t0 = w.t0_ms + piece.offset * 1000;
        const t1 = w.t1_ms + piece.offset * 1000;
        if (keep(t0 / 1000, t1 / 1000)) merged.words.push({ ...w, t0_ms: t0, t1_ms: t1 });
      }
      const raw = (res.diarization?.turns ?? []).map((t) => ({ ...t, start_ms: t.start_ms + piece.offset * 1000, end_ms: t.end_ms + piece.offset * 1000 }));
      if (raw.length) {
        const shared: [number, number] = [piece.offset * 1000, (piece.offset + CHUNK_OVERLAP_SECONDS) * 1000];
        const map = i === 0 ? new Map<string, string>() : linkSpeakers(previous, raw, shared, nextId);
        for (const t of raw) if (!map.has(t.speaker)) map.set(t.speaker, nextId());
        previous = raw.map((t) => ({ ...t, speaker: map.get(t.speaker)! }));
        for (const t of raw) {
          const start = Math.max(t.start_ms, piece.keepFrom * 1000);
          const end = Math.min(t.end_ms, piece.keepTo * 1000);
          if (end > start) merged.turns.push({ ...t, speaker: map.get(t.speaker)!, start_ms: start, end_ms: end });
        }
      } else {
        previous = [];
      }
      if (res.diarization_error) warnings.push(`Speaker labelling failed: ${res.diarization_error}`);
    }
    merged.turns = renumberSpeakers(merged.turns);
    if (opts.diarize && pieces.length > 1 && merged.turns.length) {
      warnings.push(
        `Long audio was transcribed in ${pieces.length} overlapping chunks and speakers were matched across them. ` +
          'If one person shows up under two labels, give both the same name with name_speakers to merge them.'
      );
    }
    merged.text = texts.filter(Boolean).join(' ');
    opts.onProgress?.(pieces.length, pieces.length, 'Transcribed');
    return merged;
  } finally {
    if (tmp) removeDir(tmp);
  }
}

// ---------------------------------------------------------------------------
// Account (served by the website, free)
// ---------------------------------------------------------------------------

export interface Account {
  balanceTnd: number;
  totalSpentTnd: number;
  key: { name: string; prefix: string; scopes: string[] };
  recentUsage: { service: string; endpoint: string; quantity: number; unit: string; costTnd: number; createdAt: string }[];
}

export async function getAccount(): Promise<Account> {
  requireApiKey();
  const res = await fetch(`${config.siteUrl}/api/v1/account`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  const body = (await res.json().catch(() => null)) as (Account & { error?: { message?: string } }) | null;
  if (!res.ok || !body) {
    throw new Error(`Could not read the account (HTTP ${res.status}): ${sentence(body?.error?.message ?? 'no details')}`);
  }
  return body;
}
