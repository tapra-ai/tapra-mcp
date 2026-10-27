import fs from 'node:fs';
import { z } from 'zod';
import { decodeWav, encodeWav, ffmpeg, requireFfmpeg, resample } from './media.js';

/**
 * Output formats: `wav` (lossless, as generated) plus the 18 codec_samplerate_bitrate
 * formats ElevenLabs offers. pcm_* = 16-bit PCM WAV at that rate; ulaw/alaw = G.711
 * telephony audio (8 kHz) in a WAV file; opus = Ogg Opus.
 */
export const AUDIO_FORMATS = [
  'wav',
  'mp3_22050_32',
  'mp3_44100_32',
  'mp3_44100_64',
  'mp3_44100_96',
  'mp3_44100_128',
  'mp3_44100_192',
  'pcm_8000',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'pcm_44100',
  'ulaw_8000',
  'alaw_8000',
  'opus_48000_32',
  'opus_48000_64',
  'opus_48000_96',
  'opus_48000_128',
  'opus_48000_192'
] as const;

export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export const formatSchema = z
  .enum(AUDIO_FORMATS)
  .default('wav')
  .describe(
    'Audio format: wav (default, lossless), mp3_<rate>_<kbps>, pcm_<rate> (16-bit WAV), ulaw_8000 / alaw_8000 ' +
      '(telephony), opus_48000_<kbps> (Ogg Opus). mp3, opus, ulaw and alaw need ffmpeg.'
  );

export function extensionFor(format: AudioFormat): string {
  if (format.startsWith('mp3')) return 'mp3';
  if (format.startsWith('opus')) return 'opus';
  return 'wav';
}

export function needsFfmpeg(format: AudioFormat): boolean {
  return /^(mp3|opus|ulaw|alaw)/.test(format);
}

/** Writes `srcWav` to `outPath` in `format`. pcm_* and wav need no ffmpeg. */
export async function encodeAudio(srcWav: string, format: AudioFormat, outPath: string): Promise<void> {
  if (format === 'wav') {
    fs.copyFileSync(srcWav, outPath);
    return;
  }
  const [codec, rate, kbps] = format.split('_') as [string, string, string | undefined];
  if (codec === 'pcm') {
    fs.writeFileSync(outPath, encodeWav(resample(decodeWav(fs.readFileSync(srcWav)), Number(rate))));
    return;
  }
  await requireFfmpeg(`The ${format} format`);
  const args = ['-i', srcWav, '-vn', '-ar', rate];
  if (codec === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`);
  else if (codec === 'opus') args.push('-c:a', 'libopus', '-b:a', `${kbps}k`);
  else args.push('-ac', '1', '-c:a', codec === 'ulaw' ? 'pcm_mulaw' : 'pcm_alaw');
  args.push(outPath);
  await ffmpeg(args);
}
