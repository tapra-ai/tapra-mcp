import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, resolveInput, resolveOutput, similarity } from './config.js';
import { encodeAudio, extensionFor, formatSchema } from './formats.js';
import { decodeWav, ffmpeg, hasFfmpeg, makeTempDir, probe, removeDir, requireFfmpeg } from './media.js';
import { parseSubtitles, toSrt, toVtt, type Cue } from './subtitles.js';
import { checkBudget, client, describeError, estimate, requestOptions, requireApiKey, Spend } from './tapra.js';
import { inline, LOCAL_WRITE, maxCost, PAID, progressFrom, run } from './toolkit.js';

const LOCAL_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function clock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}

async function durationOf(file: string): Promise<number | null> {
  if (await hasFfmpeg()) return (await probe(file)).durationSeconds;
  if (path.extname(file).toLowerCase() === '.wav') {
    const a = decodeWav(fs.readFileSync(file));
    return a.samples.length / a.sampleRate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// play_audio
// ---------------------------------------------------------------------------

let playing: ChildProcess | undefined;

function works(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Picks a player: TAPRA_AUDIO_PLAYER, ffplay, then the system's own. */
function player(file: string): { name: string; cmd: string; args: string[] } {
  const custom = process.env.TAPRA_AUDIO_PLAYER?.trim();
  if (custom) return { name: path.basename(custom), cmd: custom, args: [file] };
  const ffplay =
    path.dirname(config.ffmpeg) !== '.' ? path.join(path.dirname(config.ffmpeg), `ffplay${process.platform === 'win32' ? '.exe' : ''}`) : 'ffplay';
  if (works(ffplay, ['-version'])) {
    return { name: 'ffplay', cmd: ffplay, args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] };
  }
  if (process.platform === 'darwin') return { name: 'afplay', cmd: 'afplay', args: [file] };
  if (process.platform === 'win32') {
    if (path.extname(file).toLowerCase() !== '.wav') {
      throw new Error('Without ffplay only WAV files can be played on Windows. Install ffmpeg (it includes ffplay).');
    }
    const escaped = file.replace(/'/g, "''");
    return {
      name: 'Windows SoundPlayer',
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`]
    };
  }
  for (const cmd of ['paplay', 'aplay']) if (works('which', [cmd])) return { name: cmd, cmd, args: [file] };
  throw new Error('No audio player found. Install ffmpeg (ffplay) or set TAPRA_AUDIO_PLAYER.');
}

function stopPlayback(): boolean {
  if (!playing || playing.exitCode !== null) return false;
  playing.kill();
  playing = undefined;
  return true;
}

// ---------------------------------------------------------------------------
// find_in_transcript
// ---------------------------------------------------------------------------

/** Lowercase, no accents or harakat, unified Arabic letter forms, no punctuation. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Timed {
  text: string;
  start: number;
  end: number;
}

function loadTranscript(file: string): { words: Timed[]; cues: Timed[] } {
  const raw = fs.readFileSync(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.json') {
    const j = JSON.parse(raw) as {
      words?: { text: string; t0_ms: number; t1_ms: number }[];
      segments?: { text: string; start: number; end: number }[];
    };
    return {
      words: (j.words ?? []).map((w) => ({ text: w.text, start: w.t0_ms / 1000, end: w.t1_ms / 1000 })),
      cues: (j.segments ?? []).map((s) => ({ text: s.text, start: s.start, end: s.end }))
    };
  }
  return { words: [], cues: parseSubtitles(raw) };
}

function tokenMatch(a: string, b: string, fuzzy: boolean): boolean {
  if (a === b) return true;
  return fuzzy && Math.min(a.length, b.length) >= 3 && similarity(a, b) >= 0.8;
}

export function searchTranscript(file: string, query: string, fuzzy: boolean, max: number): { hits: { start: number; end: number; context: string }[]; mode: string } {
  const { words, cues } = loadTranscript(file);
  const q = normalizeForSearch(query).split(' ').filter(Boolean);
  if (!q.length) throw new Error('The search text is empty.');
  const hits: { start: number; end: number; context: string }[] = [];
  if (words.length) {
    const norm = words.map((w) => normalizeForSearch(w.text));
    for (let i = 0; i + q.length <= words.length && hits.length < max; i++) {
      if (q.every((t, k) => tokenMatch(t, norm[i + k]!, fuzzy))) {
        const from = Math.max(0, i - 6);
        const to = Math.min(words.length, i + q.length + 6);
        const context = words
          .slice(from, to)
          .map((w, k) => (from + k >= i && from + k < i + q.length ? `**${w.text}**` : w.text))
          .join(' ');
        hits.push({ start: words[i]!.start, end: words[i + q.length - 1]!.end, context: `${from > 0 ? '… ' : ''}${context}${to < words.length ? ' …' : ''}` });
        i += q.length - 1;
      }
    }
    return { hits, mode: 'word timestamps' };
  }
  for (const c of cues) {
    if (hits.length >= max) break;
    const tokens = normalizeForSearch(c.text).split(' ');
    for (let i = 0; i + q.length <= tokens.length; i++) {
      if (q.every((t, k) => tokenMatch(t, tokens[i + k]!, fuzzy))) {
        hits.push({ start: c.start, end: c.end, context: c.text });
        break;
      }
    }
  }
  return { hits, mode: 'subtitle timings (no word timestamps in this file)' };
}

// ---------------------------------------------------------------------------
// translate_subtitles
// ---------------------------------------------------------------------------

const MARK = (n: number) => `⟦${n}⟧`;

/** Splits cues into batches of about `maxChars`, each sent as numbered lines. */
function batches(texts: string[], maxChars: number): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  let size = 0;
  texts.forEach((t, i) => {
    const len = t.length + 6;
    if (current.length && size + len > maxChars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += len;
  });
  if (current.length) out.push(current);
  return out;
}

/** Reads numbered lines back; null when any line is missing (the batch is then redone line by line). */
function unpack(translation: string, ids: number[]): Map<number, string> | null {
  const found = new Map<number, string>();
  for (const m of translation.matchAll(/⟦(\d+)⟧\s*([^⟦]*)/g)) found.set(Number(m[1]), m[2]!.replace(/\s+/g, ' ').trim());
  return ids.every((id) => found.get(id)) ? found : null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExtraTools(server: McpServer): void {
  server.registerTool(
    'play_audio',
    {
      title: 'Play audio',
      description:
        'Play an audio or video file on this computer\'s speakers (for example a clip you just generated). ' +
        'Returns right away while it plays; a new play stops the previous one. Set stop to just stop playback. Free.',
      inputSchema: {
        input_path: z
          .string()
          .optional()
          .describe('File to play: a path in the input or output folder, or a tapra://output/... resource.'),
        stop: z.boolean().default(false).describe('Stop whatever is playing instead.')
      },
      annotations: LOCAL_READ
    },
    (args) =>
      run(async () => {
        if (args.stop) return stopPlayback() ? 'Stopped playback.' : 'Nothing was playing.';
        if (!args.input_path) throw new Error('Give input_path, or stop: true.');
        const file = resolveInput(args.input_path, 'media', { allowOutputs: true });
        const p = player(file);
        stopPlayback();
        // Windows runs .cmd/.bat players only through a shell; quote everything for it.
        const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(p.cmd);
        const child = viaShell
          ? spawn([p.cmd, ...p.args].map((a) => `"${a.replace(/"/g, '')}"`).join(' '), { stdio: 'ignore', windowsHide: true, shell: true })
          : spawn(p.cmd, p.args, { stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        playing = child;
        const duration = await durationOf(file).catch(() => null);
        return `Playing ${path.basename(file)}${duration ? ` (${duration.toFixed(1)} s)` : ''} with ${p.name}.`;
      })
  );

  server.registerTool(
    'find_in_transcript',
    {
      title: 'Find in transcript',
      description:
        'Find when a word or phrase is said, with timestamps, in a transcript saved by speech_to_text or transcribe_video ' +
        '(.json gives word-level times; .srt/.vtt give subtitle-level times). Matches Arabic script with or without ' +
        'harakat and letter variants (أ/ا, ة/ه, ى/ي), French accents optional, and small typos when fuzzy. ' +
        'Useful for cutting video ("where does he say X?"). Free, runs locally.',
      inputSchema: {
        transcript_path: z.string().describe('Transcript file (.json, .srt, .vtt) or tapra://output/... resource.'),
        query: z.string().min(1).max(200).describe('Word or phrase to find, in the same script as the transcript.'),
        fuzzy: z.boolean().default(true).describe('Also match near spellings (words of 3+ letters).'),
        max_results: z.number().int().min(1).max(200).default(20)
      },
      annotations: LOCAL_READ
    },
    (args) =>
      run(async () => {
        const file = resolveInput(args.transcript_path, 'transcript', { allowOutputs: true });
        const { hits, mode } = searchTranscript(file, args.query, args.fuzzy, args.max_results);
        if (!hits.length) return `"${args.query}" was not found in ${path.basename(file)} (searched ${mode}).`;
        return inline(
          [
            `${hits.length}${hits.length === args.max_results ? '+' : ''} match${hits.length === 1 ? '' : 'es'} for "${args.query}" (${mode}):`,
            ...hits.map((h) => `${clock(h.start)} – ${clock(h.end)}  ${h.context}`)
          ].join('\n')
        );
      })
  );

  server.registerTool(
    'edit_audio',
    {
      title: 'Edit audio',
      description:
        'Prepare audio for videos and posts, locally with ffmpeg: join several files in order, trim, remove long silences, ' +
        'normalize loudness (-14 LUFS for social video, -16 podcasts, -23 broadcast), fade in/out, and convert to any of ' +
        'the 19 formats. Video inputs contribute their sound. Writes a new file; never changes the originals. Free.',
      inputSchema: {
        input_paths: z.array(z.string()).min(1).max(50).describe('Audio or video files, joined in this order.'),
        trim_start: z.number().min(0).optional().describe('Keep audio from this second (of the joined audio).'),
        trim_end: z.number().positive().optional().describe('Keep audio up to this second (of the joined audio).'),
        remove_silence: z.boolean().default(false).describe('Shorten silences longer than min_silence_seconds.'),
        silence_threshold_db: z.number().min(-90).max(-10).default(-45).describe('Quieter than this counts as silence.'),
        min_silence_seconds: z.number().min(0.1).max(10).default(0.6),
        loudness_lufs: z.number().min(-40).max(-5).optional().describe('Target loudness. -14 social, -16 podcast, -23 broadcast.'),
        fade_in_seconds: z.number().min(0).max(30).optional(),
        fade_out_seconds: z.number().min(0).max(30).optional(),
        channels: z.enum(['auto', 'mono', 'stereo']).default('auto').describe('auto = mono only if every input is mono.'),
        format: formatSchema,
        output_path: z.string().optional().describe('Where to save. Relative paths go in the output folder.')
      },
      annotations: LOCAL_WRITE
    },
    (args, extra) =>
      run(async () => {
        await requireFfmpeg('Audio editing');
        if (args.trim_start !== undefined && args.trim_end !== undefined && args.trim_end <= args.trim_start) {
          throw new Error('trim_end must be after trim_start.');
        }
        const progress = progressFrom(extra);
        const inputs = args.input_paths.map((p) => resolveInput(p, 'media', { allowOutputs: true }));
        const infos = await Promise.all(inputs.map((f) => probe(f)));
        infos.forEach((info, i) => {
          if (!info.hasAudio) throw new Error(`${path.basename(inputs[i]!)} has no audio.`);
        });
        const mono = args.channels === 'mono' || (args.channels === 'auto' && infos.every((i) => i.channels === 1));
        const layout = mono ? 'mono' : 'stereo';
        const inputSeconds = infos.reduce((n, i) => n + (i.durationSeconds ?? 0), 0);

        const graph: string[] = inputs.map((_, i) => `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=${layout}[a${i}]`);
        let label = 'a0';
        if (inputs.length > 1) {
          graph.push(`${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[cat]`);
          label = 'cat';
        }
        const chain: string[] = [];
        if (args.trim_start !== undefined || args.trim_end !== undefined) {
          chain.push(`atrim=${[args.trim_start !== undefined ? `start=${args.trim_start}` : '', args.trim_end !== undefined ? `end=${args.trim_end}` : ''].filter(Boolean).join(':')}`, 'asetpts=PTS-STARTPTS');
        }
        if (args.remove_silence) {
          const t = `${args.silence_threshold_db}dB`;
          chain.push(
            `silenceremove=start_periods=1:start_threshold=${t}:start_silence=0.1:stop_periods=-1:stop_threshold=${t}:stop_duration=${args.min_silence_seconds}:stop_silence=0.25`
          );
        }
        if (args.loudness_lufs !== undefined) chain.push(`loudnorm=I=${args.loudness_lufs}:TP=-1.5:LRA=11`, 'aresample=48000');
        if (args.fade_in_seconds) chain.push(`afade=t=in:d=${args.fade_in_seconds}`);
        graph.push(`[${label}]${chain.length ? chain.join(',') : 'anull'}[out]`);

        const tmp = makeTempDir('edit');
        try {
          progress(0, 3, 'Processing');
          let stage = path.join(tmp, 'stage1.wav');
          const ffArgs: string[] = [];
          for (const f of inputs) ffArgs.push('-i', f);
          ffArgs.push('-filter_complex', graph.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', stage);
          await ffmpeg(ffArgs);
          let seconds = (await probe(stage)).durationSeconds ?? 0;
          if (seconds <= 0.01) throw new Error('Nothing is left after trimming and silence removal.');
          if (args.fade_out_seconds) {
            progress(1, 3, 'Fading out');
            const faded = path.join(tmp, 'stage2.wav');
            const d = Math.min(args.fade_out_seconds, seconds);
            await ffmpeg(['-i', stage, '-af', `afade=t=out:st=${(seconds - d).toFixed(3)}:d=${d}`, '-c:a', 'pcm_s16le', faded]);
            stage = faded;
          }
          progress(2, 3, `Encoding ${args.format}`);
          const name = inputs.length === 1 ? path.basename(inputs[0]!, path.extname(inputs[0]!)) : 'joined';
          const out = resolveOutput(args.output_path, `${name}_edited`, extensionFor(args.format));
          await encodeAudio(stage, args.format, out);
          seconds = (await probe(out)).durationSeconds ?? seconds;
          progress(3, 3, 'Done');
          const steps = [
            inputs.length > 1 ? `joined ${inputs.length} files` : '',
            args.trim_start !== undefined || args.trim_end !== undefined ? 'trimmed' : '',
            args.remove_silence ? 'removed silences' : '',
            args.loudness_lufs !== undefined ? `normalized to ${args.loudness_lufs} LUFS` : '',
            args.fade_in_seconds ? 'faded in' : '',
            args.fade_out_seconds ? 'faded out' : '',
            `${layout}, ${args.format}`
          ].filter(Boolean);
          return {
            text: `Saved ${seconds.toFixed(2)} s (from ${inputSeconds.toFixed(2)} s): ${steps.join(', ')}.\nSaved to: ${out}`,
            files: [out]
          };
        } finally {
          removeDir(tmp);
        }
      })
  );

  server.registerTool(
    'translate_subtitles',
    {
      title: 'Translate subtitles',
      description:
        'Translate an SRT or VTT file between Tunisian Derja and English, French, or MSA, keeping every timing and speaker ' +
        'label. Lines are sent in batches to keep cost low. Pair with create_voiceover (srt_path) to dub a video. ' +
        'Reports progress per batch. Costs money per character.',
      inputSchema: {
        input_path: z.string().describe('SRT/VTT file, e.g. from transcribe_video, or a tapra://output/... resource.'),
        target: z.string().describe('Target language, e.g. "French", "English", "Derja", "MSA" (see list_translation_languages).'),
        source: z.string().optional().describe('Source language. Usually auto-detected.'),
        format: z.enum(['same', 'srt', 'vtt']).default('same'),
        output_path: z.string().optional().describe('Where to save. Default: <name>.<target>.srt in the output folder.'),
        max_cost_tnd: maxCost
      },
      annotations: PAID
    },
    (args, extra) =>
      run(async () => {
        requireApiKey();
        const progress = progressFrom(extra);
        const input = resolveInput(args.input_path, 'subtitles', { allowOutputs: true });
        const cues: Cue[] = parseSubtitles(fs.readFileSync(input, 'utf8')).map((c) => {
          const m = /^\[([^\]]+)\]\s*(.*)$/.exec(c.text);
          return m ? { ...c, speaker: m[1]!, text: m[2]! } : c;
        });
        if (!cues.length) throw new Error('No subtitles found in the file.');

        const groups = batches(cues.map((c) => c.text), 1200);
        let estimateTnd = 0;
        for (const g of groups) {
          const chars = g.reduce((n, i) => n + cues[i]!.text.length + 6, 0);
          const e = await estimate('mt', chars);
          if (e === null) {
            estimateTnd = Number.NaN;
            break;
          }
          estimateTnd += e;
        }
        checkBudget(Number.isNaN(estimateTnd) ? null : estimateTnd, args.max_cost_tnd, `Translating ${cues.length} subtitles`);

        const spend = new Spend();
        const translated = new Map<number, string>();
        let fallbacks = 0;
        const translate = async (text: string) => {
          const res = await client.translations.create(
            { input: text, target: args.target, ...(args.source ? { source: args.source } : {}) },
            requestOptions()
          );
          spend.add(res.usage);
          return res.translation;
        };
        for (const [b, ids] of groups.entries()) {
          progress(b, groups.length, `Translating batch ${b + 1} of ${groups.length}`);
          try {
            const packed = ids.map((i) => `${MARK(i)} ${cues[i]!.text}`).join('\n');
            const got = unpack(await translate(packed), ids);
            if (got) {
              for (const [i, t] of got) translated.set(i, t);
              continue;
            }
            // The model merged or dropped numbered lines: redo this batch one line at a time.
            fallbacks++;
            for (const i of ids) translated.set(i, (await translate(cues[i]!.text)).trim());
          } catch (err) {
            throw new Error(`Stopped at batch ${b + 1} of ${groups.length}: ${describeError(err)} ${spend.summary()}`);
          }
        }
        progress(groups.length, groups.length, 'Translated');

        const out_cues = cues.map((c, i) => ({ ...c, text: translated.get(i) ?? c.text }));
        const inExt = path.extname(input).toLowerCase() === '.vtt' ? 'vtt' : 'srt';
        const fmt = args.format === 'same' ? inExt : args.format;
        const lang = args.target.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 20);
        const name = path.basename(input, path.extname(input));
        // Default name: <input>.<language>.srt (a -1 suffix if it exists).
        const out = resolveOutput(args.output_path ?? `${name}.${lang}`, `${name}.${lang}`, fmt);
        fs.writeFileSync(out, fmt === 'vtt' ? toVtt(out_cues) : toSrt(out_cues), 'utf8');
        return {
          text: [
            `Translated ${cues.length} subtitles to ${args.target} in ${groups.length} batch${groups.length === 1 ? '' : 'es'}.`,
            spend.summary(),
            fallbacks ? `Note: ${fallbacks} batch${fallbacks === 1 ? ' was' : 'es were'} redone line by line to keep timings aligned.` : '',
            `Saved to: ${out}`,
            '',
            inline(out_cues.slice(0, 8).map((c) => `${clock(c.start)}  ${c.speaker ? `[${c.speaker}] ` : ''}${c.text}`).join('\n'))
          ]
            .filter((l, i) => l !== '' || i === 4)
            .join('\n'),
          files: [out]
        };
      })
  );
}

