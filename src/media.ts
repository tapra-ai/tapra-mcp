import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

interface RunResult {
  code: number;
  stderr: string;
}

function runFfmpegRaw(args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpeg, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      ...(cwd ? { cwd } : {})
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

let ffmpegAvailable: boolean | undefined;

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  try {
    ffmpegAvailable = (await runFfmpegRaw(['-version'])).code === 0;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

export async function requireFfmpeg(feature: string): Promise<void> {
  if (!(await hasFfmpeg())) {
    throw new Error(
      `${feature} needs ffmpeg, which was not found. Install it (winget install Gyan.FFmpeg, ` +
        'brew install ffmpeg, or apt install ffmpeg) or set TAPRA_FFMPEG_PATH to its full path.'
    );
  }
}

/** Runs ffmpeg and throws with its last error lines on failure. */
export async function ffmpeg(args: string[], cwd?: string): Promise<void> {
  const { code, stderr } = await runFfmpegRaw(['-loglevel', 'error', '-y', ...args], cwd);
  if (code !== 0) {
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    throw new Error(`ffmpeg failed (exit ${code}): ${tail || 'no output'}`);
  }
}

export interface MediaInfo {
  durationSeconds: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  /** Channels of the first audio stream (1 = mono), when known. */
  channels: number | null;
}

/** Reads duration and streams from `ffmpeg -i` (no ffprobe needed). */
export async function probe(file: string): Promise<MediaInfo> {
  const { stderr } = await runFfmpegRaw(['-i', file]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationSeconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  // e.g. "Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s"
  const layout = /Stream #.*: Audio: [^\n]*?Hz, (mono|stereo|(\d+) channels|[^,\n]+)/.exec(stderr);
  const channels = layout ? (layout[1] === 'mono' ? 1 : layout[1] === 'stereo' ? 2 : layout[2] ? Number(layout[2]) : null) : null;
  return {
    channels,
    durationSeconds,
    hasAudio: /Stream #.*: Audio:/.test(stderr),
    hasVideo: /Stream #.*: Video:/.test(stderr) && !/Video: (png|mjpeg).*attached pic/.test(stderr)
  };
}

/** Extracts mono 16 kHz PCM WAV, optionally a time window. */
export async function extractWav16k(
  input: string,
  output: string,
  startSeconds?: number,
  durationSeconds?: number
): Promise<void> {
  const args: string[] = [];
  if (startSeconds !== undefined) args.push('-ss', startSeconds.toFixed(3));
  args.push('-i', input);
  if (durationSeconds !== undefined) args.push('-t', durationSeconds.toFixed(3));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output);
  await ffmpeg(args);
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tapra-mcp-${prefix}-`));
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best effort.
  }
}

// ---------------------------------------------------------------------------
// WAV decode / mix / encode, so voiceovers do not need ffmpeg.
// ---------------------------------------------------------------------------

export interface MonoAudio {
  sampleRate: number;
  samples: Float32Array;
}

/** Decodes PCM 8/16/24/32-bit or float32 WAV to mono float samples. */
export function decodeWav(buf: Buffer): MonoAudio {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file.');
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    // Streamed WAVs may leave the data size as 0 or 0xFFFFFFFF.
    if (id === 'data' && (size === 0 || size === 0xffffffff || body + size > buf.length)) size = buf.length - body;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error('WAV file has no fmt or data chunk.');
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      let v: number;
      if (format === 3 && bits === 32) v = data.readFloatLE(p);
      else if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
      else if (bits === 8) v = (data.readUInt8(p) - 128) / 128;
      else throw new Error(`Unsupported WAV sample format (${bits}-bit, format ${format}).`);
      sum += v;
    }
    out[i] = sum / channels;
  }
  return { sampleRate, samples: out };
}

/** Linear resampling; fine for speech clips. */
export function resample(audio: MonoAudio, targetRate: number): MonoAudio {
  if (audio.sampleRate === targetRate) return audio;
  const ratio = audio.sampleRate / targetRate;
  const length = Math.max(1, Math.round(audio.samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, audio.samples.length - 1);
    const t = pos - i0;
    out[i] = (audio.samples[i0] ?? 0) * (1 - t) + (audio.samples[i1] ?? 0) * t;
  }
  return { sampleRate: targetRate, samples: out };
}

/** Encodes mono float samples as 16-bit PCM WAV. */
export function encodeWav(audio: MonoAudio): Buffer {
  const n = audio.samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(audio.sampleRate, 24);
  buf.writeUInt32LE(audio.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, audio.samples[i] ?? 0));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Places clips on a silent timeline at their start times and sums overlaps. */
export function mixAt(
  clips: { audio: MonoAudio; startSeconds: number }[],
  sampleRate: number,
  minDurationSeconds = 0
): MonoAudio {
  const placed = clips.map((c) => ({ audio: resample(c.audio, sampleRate), start: Math.round(c.startSeconds * sampleRate) }));
  const end = placed.reduce((m, c) => Math.max(m, c.start + c.audio.samples.length), Math.ceil(minDurationSeconds * sampleRate));
  const out = new Float32Array(Math.max(end, 1));
  for (const c of placed) {
    for (let i = 0; i < c.audio.samples.length; i++) {
      const j = c.start + i;
      if (j >= 0 && j < out.length) out[j] = (out[j] ?? 0) + (c.audio.samples[i] ?? 0);
    }
  }
  return { sampleRate, samples: out };
}
