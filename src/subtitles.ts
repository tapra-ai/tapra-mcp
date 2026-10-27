import type { Tapra } from '@tapra/sdk';

export interface Cue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

function timestamp(seconds: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

function cueText(cue: Cue): string {
  return cue.speaker ? `[${cue.speaker}] ${cue.text}` : cue.text;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\n${cueText(c)}\n`)
    .join('\n');
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${timestamp(c.start, '.')} --> ${timestamp(c.end, '.')}\n${cueText(c)}\n`).join('\n')}`;
}

export function toTxt(cues: Cue[], fallback: string): string {
  if (!cues.some((c) => c.speaker)) return fallback;
  const lines: string[] = [];
  for (const c of cues) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last]!.startsWith(`${c.speaker}:`)) lines[last] += ` ${c.text}`;
    else lines.push(`${c.speaker}: ${c.text}`);
  }
  return lines.join('\n\n');
}

function parseTime(t: string): number {
  const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d{1,3})/.exec(t.trim());
  if (!m) throw new Error(`Bad subtitle timestamp: ${t}`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

/** Parses SRT or WebVTT into cues. Speaker prefixes like `[S1]` are kept in the text. */
export function parseSubtitles(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx]!.split('-->');
    const text = lines
      .slice(timeIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;
    cues.push({ start: parseTime(a!), end: parseTime(b!.trim().split(/\s+/)[0]!), text });
  }
  return cues;
}

/** Splits long text into sentence-sized lines for untimed voiceovers. */
export function splitScript(script: string): string[] {
  const paragraphs = script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= 280) {
      out.push(p);
      continue;
    }
    // Split very long paragraphs at sentence ends (Latin and Arabic punctuation).
    let current = '';
    for (const sentence of p.split(/(?<=[.!?؟。])\s+/)) {
      if (current && current.length + sentence.length + 1 > 280) {
        out.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

function speakerAt(turns: Tapra.SpeakerTurn[] | undefined, start: number, end: number): string | undefined {
  if (!turns?.length) return undefined;
  let best: string | undefined;
  let bestOverlap = 0;
  for (const t of turns) {
    const overlap = Math.min(end, t.end_ms / 1000) - Math.max(start, t.start_ms / 1000);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = t.speaker;
    }
  }
  return best;
}

/**
 * Builds subtitle cues. With word timestamps, long segments are re-split so a
 * cue stays readable (at most `maxChars`, breaking on pauses). Otherwise the
 * API's segments are used as they are.
 */
export function buildCues(
  segments: Tapra.Segment[],
  words: Tapra.Word[] | null | undefined,
  turns: Tapra.SpeakerTurn[] | undefined,
  maxChars: number
): Cue[] {
  const cues: Cue[] = [];
  if (words && words.length) {
    let current: { start: number; end: number; parts: string[] } | undefined;
    const flush = () => {
      if (current && current.parts.length) {
        cues.push({ start: current.start, end: current.end, text: current.parts.join(' ') });
      }
      current = undefined;
    };
    for (const w of words) {
      const start = w.t0_ms / 1000;
      const end = w.t1_ms / 1000;
      const text = w.text.trim();
      if (!text) continue;
      if (current) {
        const length = current.parts.join(' ').length + 1 + text.length;
        const pause = start - current.end;
        const crossesSegment = segments.some((s) => current!.end <= s.start + 0.01 && start >= s.start - 0.01 && current!.start < s.start);
        const speakerChange = turns?.length && speakerAt(turns, current.start, current.end) !== speakerAt(turns, start, end);
        if (length > maxChars || pause > 0.8 || crossesSegment || speakerChange) flush();
      }
      if (!current) current = { start, end, parts: [] };
      current.parts.push(text);
      current.end = end;
      if (/[.!?؟]$/.test(text) && current.parts.join(' ').length > maxChars / 2) flush();
    }
    flush();
  } else {
    for (const s of segments) {
      const text = s.text.trim();
      if (text) cues.push({ start: s.start, end: s.end, text });
    }
  }
  if (turns?.length) {
    for (const c of cues) c.speaker = speakerAt(turns, c.start, c.end);
  }
  return cues;
}
