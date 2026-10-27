import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TapraError, type Tapra } from '@tapra/sdk';
import { z } from 'zod';
import { config, maskedKey, resolveInput, resolveOutput, resolveOutputDir } from './config.js';
import { decodeWav, encodeWav, extractWav16k, ffmpeg, hasFfmpeg, makeTempDir, mixAt, probe, removeDir, requireFfmpeg, type MonoAudio } from './media.js';
import { encodeAudio, extensionFor, formatSchema, needsFfmpeg, type AudioFormat } from './formats.js';
import { inline, LOCAL_WRITE, maxCost, PAID, progressFrom, READ_ONLY, run, type Progress } from './toolkit.js';
import { buildCues, parseSubtitles, splitScript, toSrt, toTxt, toVtt, type Cue } from './subtitles.js';
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

type TranscriptFormat = 'txt' | 'srt' | 'vtt' | 'json';

function renderTranscript(t: MergedTranscript, format: TranscriptFormat, maxChars: number): { body: string; cues: Cue[] } {
  const cues = buildCues(t.segments, t.words, t.turns.length ? t.turns : undefined, maxChars);
  switch (format) {
    case 'srt':
      return { body: toSrt(cues), cues };
    case 'vtt':
      return { body: toVtt(cues), cues };
    case 'json':
      return {
        body: JSON.stringify(
          { text: t.text, language: t.language, duration: t.duration, segments: t.segments, words: t.words, speaker_turns: t.turns },
          null,
          2
        ),
        cues
      };
    default:
      return { body: toTxt(cues, t.text), cues };
  }
}

function transcriptSummary(t: MergedTranscript, savedTo: string | undefined, extra: string[] = []): string {
  const lines = [
    `Transcribed ${t.duration.toFixed(1)} s (${t.language || 'auto'})${t.chunks > 1 ? ` in ${t.chunks} chunks` : ''}.`,
    t.spend.summary(),
    ...(savedTo ? [`Saved to: ${savedTo}`] : []),
    ...extra,
    ...t.warnings.map((w) => `Note: ${w}`),
    '',
    inline(t.turns.length ? toTxt(buildCues(t.segments, t.words, t.turns, 84), t.text) : t.text)
  ];
  return lines.join('\n');
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
          lines.push(`  Voice clone: ${prices.ttsCloneMultiplier}x the speech rate`);
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
        'Returns the transcript and saves it as txt, srt, vtt or json. Long files are split into chunks automatically. ' +
        'Costs money per minute of audio.',
      inputSchema: {
        input_path: z.string().describe('Path to the audio or video file.'),
        format: z.enum(['txt', 'srt', 'vtt', 'json']).default('txt').describe('Saved file format.'),
        diarize: z.boolean().default(false).describe('Label who speaks when (no extra charge).'),
        language: z.string().optional().describe('Language hint. Usually leave unset: code-switching is auto-detected.'),
        prompt: z.string().optional().describe('Names, brands or jargon likely to appear, to help recognition.'),
        output_path: z.string().optional().describe('Where to save. Relative paths go in the output folder.'),
        save: z.boolean().default(true).describe('Save the transcript to a file.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args, extra) =>
      run(async () => {
        const input = resolveInput(args.input_path, 'media', { allowOutputs: true });
        const wantsTiming = args.format === 'srt' || args.format === 'vtt' || args.format === 'json';
        const t = await transcribeMedia(input, {
          diarize: args.diarize,
          onProgress: progressFrom(extra),
          wordTimestamps: wantsTiming,
          ...(args.language ? { language: args.language } : {}),
          ...(args.prompt ? { prompt: args.prompt } : {}),
          ...(args.max_cost_tnd ? { maxCostTnd: args.max_cost_tnd } : {})
        });
        let saved: string | undefined;
        if (args.save) {
          saved = resolveOutput(args.output_path, `${baseName(input)}_transcript`, args.format);
          fs.writeFileSync(saved, renderTranscript(t, args.format, 84).body, 'utf8');
        }
        return { text: transcriptSummary(t, saved), files: saved ? [saved] : [] };
      })
  );

  server.registerTool(
    'transcribe_video',
    {
      title: 'Transcribe video to subtitles',
      description:
        'Make subtitles for a video: extracts the audio, transcribes Derja/French/English, and writes an SRT or VTT file timed for reading. ' +
        'Set burn_subtitles to also render a copy of the video with the subtitles drawn in. Needs ffmpeg. Costs money per minute.',
      inputSchema: {
        input_path: z.string().describe('Path to the video file (mp4, mov, mkv, webm...).'),
        format: z.enum(['srt', 'vtt', 'txt', 'json']).default('srt'),
        diarize: z.boolean().default(false).describe('Prefix each subtitle with its speaker.'),
        language: z.string().optional(),
        prompt: z.string().optional().describe('Names or jargon likely to appear.'),
        max_chars_per_subtitle: z.number().int().min(20).max(200).default(84).describe('Longest subtitle, in characters.'),
        burn_subtitles: z.boolean().default(false).describe('Also render an MP4 with the subtitles drawn on the picture.'),
        subtitle_font: z
          .string()
          .default('Tahoma')
          .describe('Font for burned subtitles. Must support Arabic; Tahoma and Segoe UI do (Arial drops the لا ligature).'),
        output_path: z.string().optional().describe('Where to save the subtitle file.'),
        video_output_path: z.string().optional().describe('Where to save the subtitled video (with burn_subtitles).'),
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
        const name = baseName(input);
        const subtitlePath = resolveOutput(args.output_path, `${name}_subtitles`, args.format);
        const rendered = renderTranscript(t, args.format, args.max_chars_per_subtitle);
        fs.writeFileSync(subtitlePath, rendered.body, 'utf8');
        const notes = [`Subtitles: ${rendered.cues.length} cues.`];
        const files = [subtitlePath];

        if (args.burn_subtitles && !rendered.cues.length) {
          notes.push('No speech found, so no subtitled video was made.');
        } else if (args.burn_subtitles) {
          const videoOut = resolveOutput(args.video_output_path, `${name}_subtitled`, 'mp4');
          const tmp = makeTempDir('burn');
          try {
            // Run from the temp folder so the subtitles filter gets a bare file name (no path escaping).
            fs.writeFileSync(path.join(tmp, 'subs.srt'), toSrt(rendered.cues), 'utf8');
            const font = args.subtitle_font.replace(/[',:\\]/g, '');
            const style = `FontName=${font},FontSize=18,Outline=1,Shadow=0,MarginV=24`;
            await ffmpeg(
              ['-i', input, '-vf', `subtitles=subs.srt:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', videoOut],
              tmp
            );
          } finally {
            removeDir(tmp);
          }
          notes.push(`Subtitled video: ${videoOut}`);
          files.push(videoOut);
        }
        return { text: transcriptSummary(t, subtitlePath, notes), files };
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
