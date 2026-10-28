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

/** Speaker id -> shown name and color. Without it, cues show their raw speaker id. */
export type CueStyle = Record<string, { name: string; color: string }>;

function label(cue: Cue, style?: CueStyle): string | undefined {
  return cue.speaker ? (style?.[cue.speaker]?.name ?? cue.speaker) : undefined;
}

/**
 * Cue text with its speaker label. With a style (colors), the label is shown only
 * when the speaker changes; the color tells the rest apart.
 */
function cueText(cue: Cue, style?: CueStyle, prev?: Cue): string {
  const who = label(cue, style);
  if (!who || (style && prev?.speaker === cue.speaker)) return cue.text;
  return `[${who}] ${cue.text}`;
}

/** SRT. With a style, each cue is colored by speaker (<font>, which VLC, mpv and libass honor). */
export function toSrt(cues: Cue[], style?: CueStyle): string {
  return cues
    .map((c, i) => {
      const color = c.speaker ? style?.[c.speaker]?.color : undefined;
      const body = cueText(c, style, cues[i - 1]);
      const text = color ? `<font color="${color}">${body}</font>` : body;
      return `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\n${text}\n`;
    })
    .join('\n');
}

function vttVoice(name: string): string {
  return name.replace(/[<>&"\n]/g, '').trim() || 'speaker';
}

/** WebVTT. With a style, cues carry <v Name> voice tags and a STYLE block colors each voice. */
export function toVtt(cues: Cue[], style?: CueStyle): string {
  let head = 'WEBVTT\n\n';
  if (style && Object.keys(style).length) {
    const rules = Object.values(style)
      .map((s) => `::cue(v[voice="${vttVoice(s.name)}"]) { color: ${s.color}; }`)
      .join('\n');
    head += `STYLE\n${rules}\n\n`;
  }
  const body = cues
    .map((c, i) => {
      const who = label(c, style);
      const body = cueText(c, style, cues[i - 1]);
      const text = style && who ? `<v ${vttVoice(who)}>${body}</v>` : body;
      return `${timestamp(c.start, '.')} --> ${timestamp(c.end, '.')}\n${text}\n`;
    })
    .join('\n');
  return head + body;
}

/**
 * Plain text: one paragraph per speaker turn, each with its time, or the bare text
 * with no speakers. Long turns are split at pauses so paragraphs stay readable.
 */
export function toTxt(cues: Cue[], fallback: string, style?: CueStyle): string {
  if (!cues.some((c) => c.speaker)) return fallback;
  const paras: { who: string; start: number; end: number; parts: string[]; chars: number }[] = [];
  for (const c of cues) {
    const who = label(c, style) ?? '?';
    const last = paras.at(-1);
    const pause = last ? c.start - last.end : 0;
    if (last && last.who === who && !(last.chars > 500 && pause > 0.5) && last.chars < 1200) {
      last.parts.push(c.text);
      last.chars += c.text.length + 1;
      last.end = c.end;
    } else {
      paras.push({ who, start: c.start, end: c.end, parts: [c.text], chars: c.text.length });
    }
  }
  return paras.map((p) => `[${clockOf(p.start)}] ${p.who}: ${p.parts.join(' ')}`).join('\n\n');
}

function clockOf(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
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
