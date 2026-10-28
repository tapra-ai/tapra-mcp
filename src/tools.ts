import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TapraError, type Tapra } from '@tapra/sdk';
import { z } from 'zod';
import { config, maskedKey, resolveInput, resolveOutput, resolveOutputDir } from './config.js';
import { decodeWav, encodeWav, extractWav16k, ffmpeg, hasFfmpeg, hasFfmpegFilter, makeTempDir, mixAt, probe, removeDir, requireFfmpeg, type MonoAudio } from './media.js';
import { encodeAudio, extensionFor, formatSchema, needsFfmpeg, type AudioFormat } from './formats.js';
import { inline, LOCAL_WRITE, maxCost, PAID, progressFrom, READ_ONLY, run, type Progress } from './toolkit.js';
import { buildCues, parseSubtitles, splitScript, toSrt, toTxt, toVtt, type Cue, type CueStyle } from './subtitles.js';
import { clock, cutSamples, SPEAKER_COLORS, speakersHtml, speakerStats, type SpeakerInfo } from './speakers.js';
import {
  checkBudget,
  client,
  describeError,
  estimate,
  formatTnd,
  getAccount,
  getApiUrl,
  getPrices,
  requestOptions,
  requireApiKey,
  Spend,
  transcribeMedia,
  type MergedTranscript
} from './tapra.js';
import {
  CLONING_UNAVAILABLE,
  DEFAULT_VOICE_ID,
  effectsMenu,
  SPEECH_MODELS,
  stripEffectTags,
  unknownEffectTags,
  VOICE_IDS,
  VOICES,
  voiceById,
  voiceMenu
} from './voices.js';

// ---------------------------------------------------------------------------
// Speech synthesis shared by text_to_speech and create_voiceover
// ---------------------------------------------------------------------------

const voiceShape = {
  voice: z
    .enum(VOICE_IDS)
    .default(DEFAULT_VOICE_ID)
    .describe(`Tapra voice: ${voiceMenu()}. Voice cloning is not available.`),
  quality: z
    .enum(['full', 'flash'])
    .default('full')
    .describe('"full" = best quality; "flash" = same voices, about 5x faster and cheaper.'),
  speed: z.number().min(0.7).max(1.3).optional().describe('Speaking rate, 0.7-1.3. Default 1.0.'),
  convert_arabizi: z
    .boolean()
    .default(true)
    .describe('Convert Arabizi (e.g. "3aslema") to Arabic script before speaking, as Voice Studio does.')
};

type VoiceArgs = {
  voice: string;
  quality: 'full' | 'flash';
  speed?: number;
  convert_arabizi: boolean;
};

/**
 * Calls /v1/audio/speech with a named voice. The generated SDK predates the `voice`
 * field, so this goes through the SDK's raw fetch (same auth, retries, base URL).
 */
async function synthesize(text: string, args: VoiceArgs, durationSeconds?: number): Promise<Tapra.Speech> {
  const voice = voiceById(args.voice);
  const unknown = unknownEffectTags(text);
  if (unknown.length) {
    throw new Error(`Unknown effect tag${unknown.length > 1 ? 's' : ''}: ${unknown.map((t) => `[${t}]`).join(', ')}. Available: ${effectsMenu()}.`);
  }
  const form = new FormData();
  form.append('model', SPEECH_MODELS[args.quality]);
  form.append('input', text);
  form.append('voice', voice.id);
  if (voice.instruct) form.append('instruct', voice.instruct);
  form.append('convert_arabizi', String(args.convert_arabizi));
  // Tunisian pronunciation for loanwords and Arabizi (the API default is French).
  form.append('pronunciation_style', 'tunisian');
  if (args.speed) form.append('speed', String(args.speed));
  if (durationSeconds) form.append('duration', String(Math.min(120, Math.max(0.2, durationSeconds))));
  form.append('response_format', 'json');
  const opts = requestOptions();
  const res = await client.fetch(
    '/v1/audio/speech',
    { method: 'POST', body: form, headers: { 'Idempotency-Key': opts.idempotencyKey } },
    { timeoutInSeconds: opts.timeoutInSeconds, maxRetries: opts.maxRetries }
  );
  const body = (await res.json().catch(() => null)) as (Tapra.Speech & { detail?: unknown }) | null;
  if (!res.ok || !body?.audio) {
    const detail = body as { error?: { message?: string }; detail?: unknown } | null;
    throw new TapraError({
      message: detail?.error?.message ?? (typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`),
      statusCode: res.status,
      body
    });
  }
  return body;
}

async function ttsEstimate(characters: number, quality: 'full' | 'flash', requests = 1): Promise<number | null> {
  let multiplier = 1;
  if (quality === 'flash') {
    try {
      multiplier = (await getPrices()).ttsFlashMultiplier;
    } catch {
      // Estimate stays unadjusted when the price list is unreachable.
    }
  }
  // Each request has its own minimum charge, so estimate per line.
  const per = await estimate('tts', Math.ceil(characters / requests), multiplier);
  return per === null ? null : per * requests;
}

const EFFECT_TAGS = effectsMenu();

/** Writes generated WAV bytes to `out` in the requested format. */
async function saveAudio(wav: Buffer, format: AudioFormat, out: string): Promise<void> {
  if (format === 'wav') {
    fs.writeFileSync(out, wav);
    return;
  }
  const tmp = makeTempDir('fmt');
  try {
    const src = path.join(tmp, 'speech.wav');
    fs.writeFileSync(src, wav);
    await encodeAudio(src, format, out);
  } finally {
    removeDir(tmp);
  }
}

// ---------------------------------------------------------------------------
// Transcript output
// ---------------------------------------------------------------------------

const TEXT_FORMATS = ['txt', 'srt', 'vtt'] as const;
type TextFormat = (typeof TEXT_FORMATS)[number];

const formatsSchema = z
  .array(z.enum(TEXT_FORMATS))
  .min(1)
  .default([...TEXT_FORMATS])
  .describe('Files to write. Default: all three (txt, srt, vtt). A .json with full timings is always written too.');

const COLOR_WORDS: Record<string, string> = {
  '#F4AE52': 'amber',
  '#6EC6FF': 'sky blue',
  '#8BE28B': 'green',
  '#FF8FB1': 'pink',
  '#C3A6FF': 'violet',
  '#FFE066': 'yellow',
  '#7FE0D4': 'teal',
  '#FFB38A': 'peach',
  '#B5C0D0': 'slate',
  '#E9A0FF': 'orchid'
};
const NAMED_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(COLOR_WORDS).map(([hex, word]) => [word.replace(' ', ''), hex])),
  red: '#FF6B6B',
  orange: '#FF9F43',
  blue: '#5DADE2',
  purple: '#B388FF',
  white: '#FFFFFF',
  cyan: '#7FE0D4',
  gold: '#FFD166'
};

function colorWord(hex: string): string {
  return COLOR_WORDS[hex.toUpperCase()] ?? hex;
}

function parseColor(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  if (/^#[0-9a-f]{6}$/.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toUpperCase();
  const named = NAMED_COLORS[v];
  if (!named) throw new Error(`Unknown color "${value}". Use #RRGGBB or one of: ${Object.keys(NAMED_COLORS).join(', ')}.`);
  return named;
}

/** What a transcript folder's .json holds, so name_speakers can redo the files later. */
interface SavedTranscript {
  source: string;
  text: string;
  language: string;
  duration: number;
  segments: Tapra.Segment[];
  words: Tapra.Word[];
  speaker_turns: Tapra.SpeakerTurn[];
  speakers?: SpeakerInfo[];
  max_chars_per_subtitle?: number;
}

interface Bundle {
  dir: string;
  files: string[];
  lines: string[];
  cues: Cue[];
  style: CueStyle | undefined;
  speakers: SpeakerInfo[];
  preview: string;
}

/**
 * Writes the transcript in every requested format plus a .json and, when
 * speakers were labelled, a speaker page (speakers.html) with a clip of each voice.
 */
async function writeBundle(
  data: SavedTranscript,
  opts: { dir: string; stem: string; formats: readonly TextFormat[]; maxChars: number; style?: CueStyle; samplesFrom?: SpeakerInfo[] }
): Promise<Bundle> {
  const multi = new Set(data.speaker_turns.map((t) => t.speaker)).size > 1;
  const cues = buildCues(data.segments, data.words, multi ? data.speaker_turns : undefined, opts.maxChars);
  let speakers: SpeakerInfo[] = [];
  let style: CueStyle | undefined;
  if (data.speaker_turns.length) {
    const order = [...new Set([...data.speaker_turns].sort((a, b) => a.start_ms - b.start_ms).map((t) => t.speaker))];
    style = Object.fromEntries(
      order.map((id, i) => [id, { name: opts.style?.[id]?.name ?? id, color: opts.style?.[id]?.color ?? SPEAKER_COLORS[i % SPEAKER_COLORS.length]! }])
    );
    // Stats need every cue's text, so build unlabelled cues when there is only one speaker.
    speakers = speakerStats(data.speaker_turns, cues, style);
  }

  const files: string[] = [];
  const write = (ext: string, body: string) => {
    const file = resolveOutput(path.join(opts.dir, `${opts.stem}.${ext}`), opts.stem, ext);
    fs.writeFileSync(file, body, 'utf8');
    files.push(file);
    return file;
  };
  const cueStyle = multi ? style : undefined;
  for (const f of opts.formats) {
    write(f, f === 'srt' ? toSrt(cues, cueStyle) : f === 'vtt' ? toVtt(cues, cueStyle) : toTxt(cues, data.text, cueStyle));
  }

  const lines: string[] = [];
  if (speakers.length) {
    if (opts.samplesFrom) {
      const reuse = new Map(opts.samplesFrom.map((s) => [s.id, s.sample.file]));
      for (const s of speakers) {
        const file = reuse.get(s.id);
        if (file && fs.existsSync(file)) s.sample.file = file;
      }
    } else if (fs.existsSync(data.source) && (await hasFfmpeg())) {
      await cutSamples(data.source, speakers, path.join(opts.dir, 'samples'));
    }
    const page = resolveOutput(path.join(opts.dir, opts.samplesFrom ? 'speakers_named.html' : 'speakers.html'), 'speakers', 'html');
    fs.writeFileSync(page, speakersHtml(path.basename(data.source), data.duration, speakers, data.speaker_turns, opts.dir), 'utf8');
    files.push(page);
    lines.push(`${speakers.length} speaker${speakers.length === 1 ? '' : 's'} detected:`);
    for (const s of speakers) {
      const sample = s.sample.file ? `, sample ${path.relative(opts.dir, s.sample.file)}` : '';
      const quote = s.sample.text ? ` — "${s.sample.text.slice(0, 90)}${s.sample.text.length > 90 ? '…' : ''}"` : '';
      lines.push(
        `  ${s.name}${s.name !== s.id ? ` (${s.id})` : ''}, ${colorWord(s.color)}: ${clock(s.talk_seconds)} talking (${Math.round(s.share * 100)}%), ` +
          `${s.turns} turn${s.turns === 1 ? '' : 's'}, first at ${clock(s.first_heard)}${sample}${quote}`
      );
      if (s.sample.file && !opts.samplesFrom) files.push(s.sample.file);
    }
    lines.push(`Speaker page: ${page} (timeline and a clip of each voice; open it in a browser).`);
  }
  write('json', JSON.stringify({ ...data, speakers, max_chars_per_subtitle: opts.maxChars }, null, 2));
  return { dir: opts.dir, files, lines, cues, style: cueStyle, speakers, preview: toTxt(cues, data.text, cueStyle) };
}

function namingPrompt(b: Bundle, jsonPath: string): string[] {
  if (b.speakers.length < 2) return [];
  return [
    '',
    'NEXT STEP: tell the user how many speakers were found and ask whether to name them (they can listen to the ' +
      'clips on the speaker page). Each name keeps its own subtitle color, and they may pick colors. ' +
      `Then call name_speakers with transcript_path "${jsonPath}" and names like {"S1": "Host"}. ` +
      'Giving two labels the same name merges them into one speaker. Naming is free.'
  ];
}

function bundleSummary(t: MergedTranscript, b: Bundle, extra: string[] = []): string {
  const json = b.files.find((f) => f.endsWith('.json'))!;
  const shown = b.files.filter((f) => /\.(txt|srt|vtt)$/.test(f)).map((f) => path.basename(f));
  return [
    `Transcribed ${t.duration.toFixed(1)} s (${t.language || 'auto'})${t.chunks > 1 ? ` in ${t.chunks} chunks` : ''}.`,
    t.spend.summary(),
    `Folder: ${b.dir}`,
    `  ${shown.join(', ')} + ${path.basename(json)} (full timings, used by find_in_transcript and name_speakers)`,
    ...extra,
    ...b.lines,
    ...t.warnings.map((w) => `Note: ${w}`),
    ...namingPrompt(b, json),
    '',
    inline(b.preview)
  ].join('\n');
}

function toSaved(source: string, t: MergedTranscript): SavedTranscript {
  return { source, text: t.text, language: t.language, duration: t.duration, segments: t.segments, words: t.words, speaker_turns: t.turns };
}

/** Renders `video` with the bundle's subtitles drawn in (speaker colors kept). Returns a summary line. */
async function burn(video: string, b: Bundle, dir: string, stem: string, font: string): Promise<string> {
  if (!b.cues.length) return 'No speech found, so no subtitled video was made.';
  const info = await probe(video);
  if (!info.hasVideo) return 'The source has no picture, so no subtitled video was made.';
  if (!(await hasFfmpegFilter('subtitles'))) {
    return (
      "No subtitled video: this ffmpeg has no 'subtitles' filter (it was built without libass). " +
      'Install a full build (Homebrew: brew install ffmpeg-full; Windows: winget install Gyan.FFmpeg) ' +
      'or set TAPRA_FFMPEG_PATH to one. The subtitle files above are ready to use.'
    );
  }
  const videoOut = resolveOutput(path.join(dir, `${stem}_subtitled.mp4`), stem, 'mp4');
  const tmp = makeTempDir('burn');
  try {
    // Run from the temp folder so the subtitles filter gets a bare file name (no path escaping).
    fs.writeFileSync(path.join(tmp, 'subs.srt'), toSrt(b.cues, b.style), 'utf8');
    const style = `FontName=${font.replace(/[',:\\]/g, '')},FontSize=18,Outline=1,Shadow=0,MarginV=24`;
    await ffmpeg(
      ['-i', video, '-vf', `subtitles=filename=subs.srt:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', videoOut],
      tmp
    );
  } finally {
    removeDir(tmp);
  }
  b.files.push(videoOut);
  return `Subtitled video: ${videoOut}`;
}

function baseName(p: string): string {
  return path.basename(p, path.extname(p)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'media';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  server.registerTool(
    'tapra_status',
    {
      title: 'Tapra status',
      description:
        'Check the Tapra connection: API health, available models, current prices, output folder, and whether ffmpeg is installed. Free. Call this first when a tool fails.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    () =>
      run(async () => {
        const api = await getApiUrl();
        const lines = [
          `API: ${api.url} (from ${api.source})`,
          `Website: ${config.siteUrl}`,
          `API key: ${maskedKey()}`,
          `Output mode: ${config.outputMode}${config.outputMode === 'files' ? '' : ` (files up to ${Math.round(config.maxInlineBytes / 1048576)} MB returned inline)`}`,
          `Output folder: ${config.outputDir}${config.outputMode === 'resources' ? ' (temporary)' : ''}`,
          `Input folder (files must be inside): ${config.basePath}`,
          `Voices: ${VOICES.map((v) => v.id).join(', ')} (cloning not available)`,
          `ffmpeg: ${(await hasFfmpeg()) ? 'available' : 'NOT found (video tools, chunking and cost estimates for audio need it)'}`,
          `Max cost per call: ${config.maxCostTnd ? formatTnd(config.maxCostTnd) : 'no limit set'}`
        ];
        try {
          const health = await client.fetch('/health', { method: 'GET' }, { timeoutInSeconds: 15, maxRetries: 0 });
          lines.push(`Health: HTTP ${health.status} ${(await health.text()).slice(0, 300)}`);
        } catch (err) {
          lines.push(`Health: unreachable (${describeError(err)})`);
        }
        if (config.apiKey) {
          try {
            const account = await getAccount();
            lines.push(`Balance: ${formatTnd(account.balanceTnd)} (key "${account.key.name}", ${account.key.prefix})`);
          } catch (err) {
            lines.push(`Balance: ${describeError(err)}`);
          }
        }
        try {
          const models = await client.models.list({ timeoutInSeconds: 15, maxRetries: 0 });
          lines.push(`Models: ${models.data.map((m) => m.id).join(', ')}`);
        } catch (err) {
          lines.push(`Models: ${describeError(err)}`);
        }
        try {
          const prices = await getPrices();
          lines.push(`Prices (version ${prices.version}):`);
          for (const [name, p] of Object.entries(prices.services)) {
            const unit = p.unit === 'audio_ms' ? 'minute of audio' : `${p.unitsPerChargeUnit} characters`;
            lines.push(`  ${name} (${p.model}): ${formatTnd(p.tndPerUnit)} per ${unit}`);
          }
        } catch {
          lines.push('Prices: price list unreachable.');
        }
        return lines.join('\n');
      })
  );

  server.registerTool(
    'list_voices',
    {
      title: 'Tapra voices',
      description:
        'List the Tapra voices for text_to_speech and create_voiceover, with a description of each. Free. ' +
        'Also answers questions about voice cloning, which is not currently available.',
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false }
    },
    () =>
      run(async () =>
        [
          ...VOICES.map((v) => `${v.name} (voice: "${v.id}", ${v.gender}${v.id === DEFAULT_VOICE_ID ? ', default' : ''}): ${v.description}`),
          '',
          'Quality: "full" (best) or "flash" (same voices, about 5x faster, cheaper).',
          CLONING_UNAVAILABLE
        ].join('\n')
      )
  );

  server.registerTool(
    'get_balance',
    {
      title: 'Balance and usage',
      description: 'Show the Tapra balance (TND), total spent, and the 10 most recent charges for this API key. Free.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    () =>
      run(async () => {
        const a = await getAccount();
        const lines = [
          `Balance: ${formatTnd(a.balanceTnd)}`,
          `Total spent: ${formatTnd(a.totalSpentTnd)}`,
          `Key: "${a.key.name}" (${a.key.prefix}), scopes: ${a.key.scopes.join(', ')}`
        ];
        if (a.recentUsage.length) {
          lines.push('', 'Recent charges:');
          for (const u of a.recentUsage) {
            const qty = u.unit === 'audio_ms' ? `${(u.quantity / 1000).toFixed(1)} s` : `${u.quantity} chars`;
            lines.push(`  ${u.createdAt.slice(0, 19).replace('T', ' ')}  ${u.service.padEnd(9)} ${qty.padStart(12)}  ${formatTnd(u.costTnd)}`);
          }
        }
        lines.push('', 'Top up at https://tapra.tn/dashboard.');
        return lines.join('\n');
      })
  );

  server.registerTool(
    'speech_to_text',
    {
      title: 'Transcribe audio',
      description:
        'Transcribe an audio or video file with Tapra, which handles Tunisian Derja mixed with French and English. ' +
        'One call writes a folder with the transcript as txt, srt and vtt (plus a .json with full timings). ' +
        'Speakers are labelled by default (no extra charge): the result says how many were detected, with talk time, ' +
        'a quote and an audio clip of each, and a speakers.html page. When there are several speakers, ask the user ' +
        'whether to name them, then call name_speakers. Long files are split into chunks automatically. Costs money per minute of audio.',
      inputSchema: {
        input_path: z.string().describe('Path to the audio or video file.'),
        formats: formatsSchema,
        diarize: z.boolean().default(true).describe('Find who speaks when (no extra charge). Set false for a single speaker.'),
        language: z.string().optional().describe('Language hint. Usually leave unset: code-switching is auto-detected.'),
        prompt: z.string().optional().describe('Names, brands or jargon likely to appear, to help recognition.'),
        max_chars_per_subtitle: z.number().int().min(20).max(200).default(84).describe('Longest subtitle line in srt/vtt, in characters.'),
        output_dir: z.string().optional().describe('Folder to write into. Defaults to a new folder in the output folder.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args, extra) =>
      run(async () => {
        const input = resolveInput(args.input_path, 'media', { allowOutputs: true });
        const t = await transcribeMedia(input, {
          diarize: args.diarize,
          onProgress: progressFrom(extra),
          wordTimestamps: true,
          ...(args.language ? { language: args.language } : {}),
          ...(args.prompt ? { prompt: args.prompt } : {}),
          ...(args.max_cost_tnd ? { maxCostTnd: args.max_cost_tnd } : {})
        });
        const stem = baseName(input);
        const dir = resolveOutputDir(args.output_dir, `${stem}_transcript`);
        const b = await writeBundle(toSaved(input, t), { dir, stem, formats: args.formats, maxChars: args.max_chars_per_subtitle });
        return { text: bundleSummary(t, b), files: b.files };
      })
  );

  server.registerTool(
    'transcribe_video',
    {
      title: 'Transcribe video to subtitles',
      description:
        'Make subtitles for a video: extracts the audio, transcribes Derja/French/English, and writes srt, vtt and txt in one go, ' +
        'timed for reading. Speakers are labelled and colored by default (no extra charge), with a speaker report and a clip of each voice; ' +
        'when there are several, ask the user whether to name them, then call name_speakers. ' +
        'Set burn_subtitles to also render a copy of the video with the subtitles drawn in. Needs ffmpeg. Costs money per minute.',
      inputSchema: {
        input_path: z.string().describe('Path to the video file (mp4, mov, mkv, webm...).'),
        formats: formatsSchema,
        diarize: z.boolean().default(true).describe('Label and color each speaker (no extra charge). Set false for a single speaker.'),
        language: z.string().optional(),
        prompt: z.string().optional().describe('Names or jargon likely to appear.'),
        max_chars_per_subtitle: z.number().int().min(20).max(200).default(84).describe('Longest subtitle, in characters.'),
        burn_subtitles: z.boolean().default(false).describe('Also render an MP4 with the subtitles drawn on the picture (speaker colors kept).'),
        subtitle_font: z
          .string()
          .default('Tahoma')
          .describe('Font for burned subtitles. Must support Arabic; Tahoma and Segoe UI do (Arial drops the لا ligature).'),
        output_dir: z.string().optional().describe('Folder to write into. Defaults to a new folder in the output folder.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args, extra) =>
      run(async () => {
        await requireFfmpeg('Video transcription');
        const input = resolveInput(args.input_path, 'media', { allowOutputs: true });
        const info = await probe(input);
        if (!info.hasAudio) throw new Error('This video has no audio track.');
        const t = await transcribeMedia(input, {
          diarize: args.diarize,
          onProgress: progressFrom(extra),
          wordTimestamps: true,
          ...(args.language ? { language: args.language } : {}),
          ...(args.prompt ? { prompt: args.prompt } : {}),
          ...(args.max_cost_tnd ? { maxCostTnd: args.max_cost_tnd } : {})
        });
        const stem = baseName(input);
        const dir = resolveOutputDir(args.output_dir, `${stem}_subtitles`);
        const b = await writeBundle(toSaved(input, t), { dir, stem, formats: args.formats, maxChars: args.max_chars_per_subtitle });
        const notes = [`Subtitles: ${b.cues.length} cues.`];
        if (args.burn_subtitles) notes.push(await burn(input, b, dir, stem, args.subtitle_font));
        return { text: bundleSummary(t, b, notes), files: b.files };
      })
  );

  server.registerTool(
    'name_speakers',
    {
      title: 'Name speakers',
      description:
        'Give the speakers found by speech_to_text or transcribe_video real names (and optionally colors), then rewrite the ' +
        'txt, srt and vtt with those names. Each speaker keeps one subtitle color (srt <font> colors, vtt voice styles). ' +
        'Labels given the same name are merged into one speaker. Free, works offline. Can also burn the named subtitles into the video.',
      inputSchema: {
        transcript_path: z.string().describe('The .json from the transcript folder (or the folder itself).'),
        names: z
          .record(z.string(), z.string().min(1).max(60))
          .describe('Speaker label to name, e.g. {"S1": "Riadh", "S2": "Host"}. Unlisted speakers keep their label.'),
        colors: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional label or name to color: #RRGGBB or a word (amber, skyblue, green, pink, violet, yellow, teal, peach, red, orange, blue, purple, white, gold).'),
        formats: formatsSchema,
        burn_subtitles: z.boolean().default(false).describe('Also render the source video with the named, colored subtitles drawn in.'),
        subtitle_font: z.string().default('Tahoma')
      },
      annotations: LOCAL_WRITE
    },
    (args) =>
      run(async () => {
        let jsonPath = args.transcript_path;
        const asDir = path.resolve(config.outputDir, jsonPath);
        if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
          const found = fs
            .readdirSync(asDir)
            .filter((f) => f.endsWith('.json') && !f.includes('_named'))
            .sort();
          if (!found.length) throw new Error(`No transcript .json in ${asDir}.`);
          jsonPath = path.join(asDir, found[0]!);
        }
        const file = resolveInput(jsonPath, 'transcript', { allowOutputs: true });
        if (path.extname(file).toLowerCase() !== '.json') throw new Error('Give the .json from the transcript folder.');
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedTranscript;
        if (!data.speaker_turns?.length) throw new Error('This transcript has no speaker labels. Transcribe again with diarize: true.');
        const ids = [...new Set([...data.speaker_turns].sort((a, b) => a.start_ms - b.start_ms).map((t) => t.speaker))];
        const unknown = Object.keys(args.names).filter((k) => !ids.includes(k));
        if (unknown.length) throw new Error(`No speaker ${unknown.join(', ')} in this transcript. Speakers: ${ids.join(', ')}.`);

        // Same name means one speaker: later labels fold into the first one with that name.
        const mergedInto = new Map<string, string>();
        const owner = new Map<string, string>();
        for (const id of ids) {
          const key = args.names[id]?.trim().toLowerCase();
          if (!key) continue;
          if (owner.has(key)) mergedInto.set(id, owner.get(key)!);
          else owner.set(key, id);
        }
        const turns = data.speaker_turns.map((t) => ({ ...t, speaker: mergedInto.get(t.speaker) ?? t.speaker }));
        const before = new Map((data.speakers ?? []).map((s) => [s.id, s.color]));
        const style: CueStyle = {};
        for (const [i, id] of ids.filter((id) => !mergedInto.has(id)).entries()) {
          const name = args.names[id]?.trim() || id;
          const pick = args.colors?.[id] ?? args.colors?.[name];
          style[id] = { name, color: pick ? parseColor(pick) : (before.get(id) ?? SPEAKER_COLORS[i % SPEAKER_COLORS.length]!) };
        }

        const dir = path.dirname(file);
        const stem = `${path.basename(file, '.json')}_named`;
        const b = await writeBundle(
          { ...data, speaker_turns: turns },
          { dir, stem, formats: args.formats, maxChars: data.max_chars_per_subtitle ?? 84, style, samplesFrom: data.speakers ?? [] }
        );
        const notes = mergedInto.size ? [`Merged: ${[...mergedInto].map(([a, into]) => `${a} into ${into}`).join(', ')}.`] : [];
        if (args.burn_subtitles) {
          await requireFfmpeg('Burning subtitles');
          if (!fs.existsSync(data.source)) throw new Error(`The source video is gone: ${data.source}.`);
          notes.push(await burn(data.source, b, dir, stem, args.subtitle_font));
        }
        const shown = b.files.filter((f) => /\.(txt|srt|vtt)$/.test(f)).map((f) => path.basename(f));
        return {
          text: [`Named subtitles in ${dir}:`, `  ${shown.join(', ')}`, ...notes, ...b.lines, '', inline(b.preview)].join('\n'),
          files: b.files
        };
      })
  );

  server.registerTool(
    'diarize_audio',
    {
      title: 'Who spoke when',
      description: 'Find speaker turns in an audio or video file (no transcript). Returns each turn with its speaker and times. Costs money per minute.',
      inputSchema: {
        input_path: z.string().describe('Path to the audio or video file.'),
        output_path: z.string().optional().describe('Save the turns as JSON here.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args) =>
      run(async () => {
        requireApiKey();
        const input = resolveInput(args.input_path, 'media', { allowOutputs: true });
        let upload = input;
        let tmp: string | undefined;
        try {
          if (await hasFfmpeg()) {
            const info = await probe(input);
            checkBudget(await estimate('offline', (info.durationSeconds ?? 0) * 1000), args.max_cost_tnd, 'Speaker labelling');
            tmp = makeTempDir('diar');
            upload = path.join(tmp, 'audio.wav');
            await extractWav16k(input, upload);
          }
          const res = await client.diarization.create({ file: { path: upload, filename: path.basename(upload) } }, requestOptions());
          const spend = new Spend();
          spend.add(res.usage);
          const out = resolveOutput(args.output_path, `${baseName(input)}_speakers`, 'json');
          fs.writeFileSync(out, JSON.stringify(res, null, 2), 'utf8');
          const fmt = (ms: number) => (ms / 1000).toFixed(1);
          const turns = res.turns.map((t) => `${fmt(t.start_ms)}-${fmt(t.end_ms)} s  ${t.speaker}`);
          return {
            text: [
              `${res.speakers.length} speakers, ${res.turns.length} turns over ${res.duration.toFixed(1)} s.`,
              spend.summary(),
              `Saved to: ${out}`,
              '',
              inline(turns.join('\n'))
            ].join('\n'),
            files: [out]
          };
        } finally {
          if (tmp) removeDir(tmp);
        }
      })
  );

  server.registerTool(
    'text_to_speech',
    {
      title: 'Text to speech',
      description:
        'Speak text in Tunisian Derja (Arabic script or Arabizi), French, English, or a mix with one of the Tapra voices, ' +
        `with Tunisian pronunciation. Voices: ${voiceMenu()}. ` +
        `Add non-verbal effects inline with tags (not billed): ${effectsMenu()}. Example: "[euh] ma na3rafch, [breath] khalli nchouf". ` +
        'Saves the audio in the chosen format (wav by default, 18 other formats). ' +
        'Voice cloning and custom voice design are not currently available: if the user asks to clone a voice, say so ' +
        'and offer these voices. Costs money per character. For long scripts or narration timed to a video, use create_voiceover.',
      inputSchema: {
        text: z.string().min(1).max(2000).describe('What to say. May include effect tags like [euh], [hmm], [breath].'),
        ...voiceShape,
        duration_seconds: z.number().min(0.2).max(120).optional().describe('Force the clip to last this long.'),
        format: formatSchema,
        output_path: z.string().optional().describe('Where to save. Relative paths go in the output folder; the extension follows the format.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args) =>
      run(async () => {
        requireApiKey();
        if (needsFfmpeg(args.format)) await requireFfmpeg(`The ${args.format} format`);
        checkBudget(await ttsEstimate(stripEffectTags(args.text).length, args.quality), args.max_cost_tnd, 'This speech');
        const res = await synthesize(args.text, args, args.duration_seconds);
        const out = resolveOutput(args.output_path, 'speech', extensionFor(args.format));
        await saveAudio(Buffer.from(res.audio, 'base64'), args.format, out);
        const spend = new Spend();
        spend.add(res.usage);
        return {
          text: [
            `Saved ${res.duration.toFixed(2)} s of audio (${args.format}) to: ${out}`,
            spend.summary(),
            `Voice: ${voiceById(args.voice).name} (${args.quality === 'flash' ? 'Flash' : 'full quality'})`,
            res.spoken_text && res.spoken_text !== res.text ? `Spoken as: ${res.spoken_text}` : ''
          ]
            .filter(Boolean)
            .join('\n'),
          files: [out]
        };
      })
  );

  server.registerTool(
    'create_voiceover',
    {
      title: 'Create a voiceover',
      description:
        'Turn a script or a subtitle file into one narration track for video work. Each line is spoken with the same Tapra voice ' +
        `(${voiceMenu()}; voice cloning is not available) and ` +
        'placed on a timeline: at its subtitle time (from srt_path) or one after another (from script or lines). ' +
        `Lines may use effect tags (${EFFECT_TAGS}). ` +
        'Writes a folder with the voiceover track (wav or another format), one WAV clip per line, and manifest.json ' +
        '(text + start/end per clip) that video generation tools can follow. Optionally lays the voiceover onto a video. ' +
        'Reports progress per line. Costs money per character.',
      inputSchema: {
        script: z.string().optional().describe('Plain narration text. Split into lines at line breaks and long sentences.'),
        lines: z.array(z.string().min(1)).optional().describe('Narration already split into lines, spoken in order.'),
        srt_path: z.string().optional().describe('SRT/VTT file: each subtitle is spoken at its own time (dubbing).'),
        ...voiceShape,
        timing: z
          .enum(['fit', 'natural'])
          .default('fit')
          .describe('With srt_path: "fit" stretches or squeezes each line to its subtitle slot; "natural" keeps natural length.'),
        gap_seconds: z.number().min(0).max(10).default(0.4).describe('Pause between lines when there are no timings.'),
        format: formatSchema,
        video_path: z.string().optional().describe('Also produce a copy of this video with the voiceover as its sound.'),
        original_audio_volume: z
          .number()
          .min(0)
          .max(1)
          .default(0)
          .describe('With video_path: keep the original sound under the voiceover at this volume (0 = replace it).'),
        output_dir: z.string().optional().describe('Folder to write into. Defaults to a new folder in the output folder.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args, extra) =>
      run(async () => {
        requireApiKey();
        const progress = progressFrom(extra);
        const sources = [args.script, args.lines, args.srt_path].filter((v) => v !== undefined);
        if (sources.length !== 1) throw new Error('Give exactly one of script, lines, or srt_path.');
        if (needsFfmpeg(args.format)) await requireFfmpeg(`The ${args.format} format`);

        let items: { text: string; start?: number; end?: number }[];
        if (args.srt_path) {
          const cues = parseSubtitles(fs.readFileSync(resolveInput(args.srt_path, 'subtitles', { allowOutputs: true }), 'utf8'));
          items = cues.map((c) => ({ text: c.text.replace(/^\[[^\]]+\]\s*/, ''), start: c.start, end: c.end }));
        } else {
          items = (args.lines ?? splitScript(args.script ?? '')).map((text) => ({ text: text.trim() })).filter((i) => i.text);
        }
        if (!items.length) throw new Error('Nothing to say: the script is empty.');
        const timed = items.every((i) => i.start !== undefined);
        for (const item of items) {
          const unknown = unknownEffectTags(item.text);
          if (unknown.length) throw new Error(`Unknown effect tag [${unknown[0]}] in "${item.text}". Available: ${EFFECT_TAGS}.`);
        }

        const chars = items.reduce((n, i) => n + stripEffectTags(i.text).length, 0);
        checkBudget(await ttsEstimate(chars, args.quality, items.length), args.max_cost_tnd, `A ${items.length}-line voiceover`);

        let video: string | undefined;
        let videoDuration = 0;
        let videoHasAudio = false;
        if (args.video_path) {
          await requireFfmpeg('Adding a voiceover to a video');
          video = resolveInput(args.video_path, 'media', { allowOutputs: true });
          const info = await probe(video);
          videoDuration = info.durationSeconds ?? 0;
          videoHasAudio = info.hasAudio;
        }

        const outDir = resolveOutputDir(args.output_dir, 'voiceover');
        const clipsDir = path.join(outDir, 'clips');
        fs.mkdirSync(clipsDir, { recursive: true });
        const spend = new Spend();
        const placed: { audio: MonoAudio; startSeconds: number }[] = [];
        const manifest: { index: number; text: string; start: number; end: number; clip: string }[] = [];
        const warnings: string[] = [];
        let cursor = 0;
        const total = items.length + 1 + (video ? 1 : 0);

        for (const [i, item] of items.entries()) {
          progress(i, total, `Speaking line ${i + 1} of ${items.length}`);
          const slot = timed && item.end! > item.start! ? item.end! - item.start! : undefined;
          let res: Tapra.Speech;
          try {
            res = await synthesize(item.text, args, timed && args.timing === 'fit' ? slot : undefined);
          } catch (err) {
            throw new Error(
              `Stopped at line ${i + 1} of ${items.length}: ${describeError(err)} ` +
                `${spend.summary()} Clips made so far are in ${clipsDir}.`
            );
          }
          spend.add(res.usage);
          const bytes = Buffer.from(res.audio, 'base64');
          const clipName = `${String(i + 1).padStart(3, '0')}.wav`;
          fs.writeFileSync(path.join(clipsDir, clipName), bytes);
          const audio = decodeWav(bytes);
          const length = audio.samples.length / audio.sampleRate;
          const start = timed ? item.start! : cursor;
          if (timed && slot !== undefined && length > slot + 0.25) {
            const next = items[i + 1]?.start;
            if (next !== undefined && start + length > next) {
              warnings.push(`Line ${i + 1} runs ${(start + length - next).toFixed(1)} s into the next line.`);
            }
          }
          placed.push({ audio, startSeconds: start });
          manifest.push({ index: i + 1, text: item.text, start: +start.toFixed(3), end: +(start + length).toFixed(3), clip: `clips/${clipName}` });
          cursor = start + length + args.gap_seconds;
        }

        progress(items.length, total, 'Mixing the voiceover track');
        const sampleRate = placed[0]!.audio.sampleRate;
        const mixed = mixAt(placed, sampleRate, videoDuration);
        const tmp = makeTempDir('vo');
        try {
          const mixWav = path.join(tmp, 'voiceover.wav');
          fs.writeFileSync(mixWav, encodeWav(mixed));
          const trackName = `voiceover.${extensionFor(args.format)}`;
          const trackPath = path.join(outDir, trackName);
          await encodeAudio(mixWav, args.format, trackPath);
          const totalSeconds = mixed.samples.length / sampleRate;
          const manifestPath = path.join(outDir, 'manifest.json');
          fs.writeFileSync(
            manifestPath,
            JSON.stringify(
              {
                audio: trackName,
                format: args.format,
                sample_rate: sampleRate,
                duration: +totalSeconds.toFixed(3),
                timing: timed ? (args.timing === 'fit' ? 'fit-to-subtitles' : 'subtitle-start') : 'sequential',
                voice: { id: args.voice, name: voiceById(args.voice).name, model: SPEECH_MODELS[args.quality] },
                segments: manifest
              },
              null,
              2
            ),
            'utf8'
          );

          const lines = [
            `Voiceover: ${items.length} lines, ${totalSeconds.toFixed(1)} s.`,
            spend.summary(),
            `Folder: ${outDir}`,
            `  ${trackName}, manifest.json, clips/001.wav...`,
            `Voice: ${voiceById(args.voice).name}`
          ];
          const files = [trackPath, manifestPath];

          if (video) {
            progress(items.length + 1, total, 'Laying the voiceover onto the video');
            const ext = /\.(mp4|mov|m4v)$/i.test(video) ? 'mp4' : 'mkv';
            const videoOut = path.join(outDir, `${baseName(video)}_voiceover.${ext}`);
            const args2 = ['-i', video, '-i', mixWav];
            if (args.original_audio_volume > 0 && videoHasAudio) {
              args2.push(
                '-filter_complex',
                `[0:a]volume=${args.original_audio_volume}[bg];[bg][1:a]amix=inputs=2:duration=first:normalize=0[a]`,
                '-map',
                '0:v:0',
                '-map',
                '[a]'
              );
            } else {
              args2.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
            }
            args2.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', videoOut);
            await ffmpeg(args2);
            lines.push(`Video with voiceover: ${videoOut}`);
            files.push(videoOut);
          }
          progress(total, total, 'Done');
          lines.push(...warnings.map((w) => `Note: ${w}`));
          return { text: lines.join('\n'), files };
        } finally {
          removeDir(tmp);
        }
      })
  );

  server.registerTool(
    'translate',
    {
      title: 'Translate',
      description:
        'Translate between Tunisian Derja and English, French, or Modern Standard Arabic (in both directions). ' +
        'Call list_translation_languages for the exact target names. Costs money per character.',
      inputSchema: {
        text: z.string().min(1).max(20_000),
        target: z.string().describe('Target language, e.g. "Derja", "French", "English", "MSA".'),
        source: z.string().optional().describe('Source language. Usually auto-detected.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args) =>
      run(async () => {
        requireApiKey();
        checkBudget(await estimate('mt', args.text.length), args.max_cost_tnd, 'This translation');
        const res = await client.translations.create(
          { input: args.text, target: args.target, ...(args.source ? { source: args.source } : {}) },
          requestOptions()
        );
        const spend = new Spend();
        spend.add(res.usage);
        const from = res.source_language ? `${res.source_language} → ` : '';
        return `${res.translation}\n\n(${from}${res.target_language ?? res.target}. ${spend.summary()})`;
      })
  );

  server.registerTool(
    'list_translation_languages',
    {
      title: 'Translation languages',
      description: 'List the languages translate accepts as source and target. Free.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    () =>
      run(async () => {
        requireApiKey();
        const res = await client.translations.listLanguages({ timeoutInSeconds: 30 });
        return res.data.map((l) => `${l.label} (${l.code}${l.rtl ? ', right-to-left' : ''})`).join('\n');
      })
  );

  server.registerTool(
    'convert_script',
    {
      title: 'Arabizi ↔ Arabic',
      description:
        'Convert Tunisian text between Arabizi (Latin letters and digits, e.g. "3aslema, chna7welek?") and Arabic script, in either direction. Costs money per character.',
      inputSchema: {
        text: z.string().min(1).max(20_000),
        direction: z.enum(['arabizi_to_arabic', 'arabic_to_arabizi']),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args) =>
      run(async () => {
        requireApiKey();
        checkBudget(await estimate('converter', args.text.length), args.max_cost_tnd, 'This conversion');
        const res = await client.script.convert(
          { text: args.text, direction: args.direction === 'arabizi_to_arabic' ? 'ZI2AR' : 'AR2ZI' },
          requestOptions()
        );
        const spend = new Spend();
        spend.add(res.usage);
        return `${res.output}\n\n(${spend.summary()})`;
      })
  );
}
