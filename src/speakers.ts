import fs from 'node:fs';
import path from 'node:path';
import type { Tapra } from '@tapra/sdk';
import { ffmpeg } from './media.js';
import type { Cue } from './subtitles.js';

/** Readable on video and on light or dark pages. Speaker N gets color N. */
export const SPEAKER_COLORS = ['#F4AE52', '#6EC6FF', '#8BE28B', '#FF8FB1', '#C3A6FF', '#FFE066', '#7FE0D4', '#FFB38A', '#B5C0D0', '#E9A0FF'];

export interface SpeakerInfo {
  id: string;
  name: string;
  color: string;
  talk_seconds: number;
  share: number;
  turns: number;
  first_heard: number;
  /** Longest turn: where the audio sample comes from. */
  sample: { start: number; end: number; text: string; file?: string };
}

/** Speaker labels to show the user: names when given, else the ids. */
export type SpeakerStyle = Record<string, { name: string; color: string }>;

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Renumbers speakers S1, S2, ... in order of first appearance. */
export function renumberSpeakers(turns: Tapra.SpeakerTurn[]): Tapra.SpeakerTurn[] {
  const map = new Map<string, string>();
  const sorted = [...turns].sort((a, b) => a.start_ms - b.start_ms);
  for (const t of sorted) if (!map.has(t.speaker)) map.set(t.speaker, `S${map.size + 1}`);
  return sorted.map((t) => ({ ...t, speaker: map.get(t.speaker)! }));
}

/**
 * Maps one chunk's raw speaker labels onto the labels already used, by how long
 * they talk at the same time in the audio both chunks share. Unmatched labels
 * get new ids.
 */
export function linkSpeakers(
  known: Tapra.SpeakerTurn[],
  incoming: Tapra.SpeakerTurn[],
  windowMs: [number, number],
  nextId: () => string
): Map<string, string> {
  const clip = (t: Tapra.SpeakerTurn) => [Math.max(t.start_ms, windowMs[0]), Math.min(t.end_ms, windowMs[1])] as const;
  const overlap = new Map<string, Map<string, number>>();
  for (const a of incoming) {
    const [a0, a1] = clip(a);
    if (a1 <= a0) continue;
    for (const b of known) {
      const [b0, b1] = clip(b);
      const ms = Math.min(a1, b1) - Math.max(a0, b0);
      if (ms <= 0) continue;
      const row = overlap.get(a.speaker) ?? new Map<string, number>();
      row.set(b.speaker, (row.get(b.speaker) ?? 0) + ms);
      overlap.set(a.speaker, row);
    }
  }
  const pairs = [...overlap].flatMap(([a, row]) => [...row].map(([b, ms]) => ({ a, b, ms }))).sort((x, y) => y.ms - x.ms);
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (p.ms < 1000 || map.has(p.a) || used.has(p.b)) continue;
    map.set(p.a, p.b);
    used.add(p.b);
  }
  for (const t of incoming) if (!map.has(t.speaker)) map.set(t.speaker, nextId());
  return map;
}

/** Talk time, turns and a sample per speaker, most talkative first. */
export function speakerStats(turns: Tapra.SpeakerTurn[], cues: Cue[], style: SpeakerStyle = {}): SpeakerInfo[] {
  const total = turns.reduce((n, t) => n + Math.max(0, t.end_ms - t.start_ms), 0) || 1;
  const byId = new Map<string, Tapra.SpeakerTurn[]>();
  for (const t of turns) byId.set(t.speaker, [...(byId.get(t.speaker) ?? []), t]);
  const ids = [...byId.keys()];
  return ids
    .map((id, i) => {
      const own = byId.get(id)!;
      const ms = own.reduce((n, t) => n + Math.max(0, t.end_ms - t.start_ms), 0);
      const longest = own.reduce((a, b) => (b.end_ms - b.start_ms > a.end_ms - a.start_ms ? b : a));
      // Up to 8 s from the middle of the longest turn.
      const mid = (longest.start_ms + longest.end_ms) / 2000;
      const half = Math.min(4, (longest.end_ms - longest.start_ms) / 2000);
      const start = mid - half;
      const end = mid + half;
      const text = cues
        .filter((c) => c.end > start && c.start < end)
        .map((c) => c.text)
        .join(' ');
      return {
        id,
        name: style[id]?.name ?? id,
        color: style[id]?.color ?? SPEAKER_COLORS[i % SPEAKER_COLORS.length]!,
        talk_seconds: +(ms / 1000).toFixed(1),
        share: +(ms / total).toFixed(3),
        turns: own.length,
        first_heard: +(Math.min(...own.map((t) => t.start_ms)) / 1000).toFixed(1),
        sample: { start: +start.toFixed(2), end: +end.toFixed(2), text }
      };
    })
    .sort((a, b) => b.talk_seconds - a.talk_seconds);
}

/** Cuts one short clip per speaker into `dir`. Missing clips are skipped, never fatal. */
export async function cutSamples(media: string, speakers: SpeakerInfo[], dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of speakers) {
    const len = (s.sample.end - s.sample.start).toFixed(2);
    const base = ['-ss', s.sample.start.toFixed(2), '-t', len, '-i', media, '-vn', '-ac', '1', '-af', 'afade=t=in:d=0.15'];
    for (const [ext, codec] of [
      ['mp3', ['-c:a', 'libmp3lame', '-q:a', '4']],
      ['wav', ['-ar', '16000']]
    ] as const) {
      const file = path.join(dir, `${s.id}.${ext}`);
      try {
        await ffmpeg([...base, ...codec, file]);
        s.sample.file = file;
        break;
      } catch {
        // Try the next format.
      }
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** A self-contained page: who speaks, how much, when, and a clip of each voice. */
export function speakersHtml(title: string, duration: number, speakers: SpeakerInfo[], turns: Tapra.SpeakerTurn[], dir: string): string {
  const colorOf = new Map(speakers.map((s) => [s.id, s.color]));
  const bars = turns
    .map((t) => {
      const left = ((t.start_ms / 1000 / duration) * 100).toFixed(3);
      const width = Math.max(0.15, ((t.end_ms - t.start_ms) / 1000 / duration) * 100).toFixed(3);
      const row = speakers.findIndex((s) => s.id === t.speaker);
      return `<i style="left:${left}%;width:${width}%;top:${row * 22 + 4}px;background:${colorOf.get(t.speaker)}"></i>`;
    })
    .join('');
  const labels = speakers.map((s, i) => `<b style="top:${i * 22 + 2}px;color:${s.color}">${esc(s.name)}</b>`).join('');
  const cards = speakers
    .map((s) => {
      const src = s.sample.file ? path.relative(dir, s.sample.file).split(path.sep).join('/') : '';
      return `<section style="--c:${s.color}">
  <h2><span class="dot"></span>${esc(s.name)}${s.name !== s.id ? ` <small>${s.id}</small>` : ''}</h2>
  <p class="meta">${clock(s.talk_seconds)} talking · ${Math.round(s.share * 100)}% · ${s.turns} turn${s.turns === 1 ? '' : 's'} · first heard at ${clock(s.first_heard)}</p>
  ${src ? `<audio controls preload="none" src="${esc(src)}"></audio>` : '<p class="meta">No audio sample (ffmpeg missing).</p>'}
  <p class="quote" dir="auto">${esc(s.sample.text || '…')}</p>
  <p class="meta">Sample from ${clock(s.sample.start)}–${clock(s.sample.end)}</p>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Speakers · ${esc(title)}</title>
<style>
:root{--bg:#FEF3E2;--fg:#2A1A0E;--muted:#7a6650;--card:#fff;--line:#ecdcc4}
@media (prefers-color-scheme:dark){:root{--bg:#2A1A0E;--fg:#FEF3E2;--muted:#c9b59a;--card:#3a2717;--line:#4d3722}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,Tahoma,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.timeline{position:relative;background:var(--card);border:1px solid var(--line);padding:6px 6px 6px 110px;margin-bottom:24px}
.track{position:relative;height:${speakers.length * 22 + 6}px}
.track i{position:absolute;height:16px;display:block}
.track b{position:absolute;left:-104px;width:98px;font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:11px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
section{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--c);padding:12px 14px}
h2{font-size:17px;margin:0 0 2px;display:flex;align-items:center;gap:8px}h2 small{color:var(--muted);font-weight:400}
.dot{width:12px;height:12px;background:var(--c);display:inline-block}
.meta{color:var(--muted);font-size:12px;margin:2px 0}.quote{margin:8px 0 2px}
audio{width:100%;margin-top:6px}
</style></head><body><main>
<h1>${speakers.length} speaker${speakers.length === 1 ? '' : 's'} detected</h1>
<p class="sub"><bdi>${esc(title)}</bdi> · ${clock(duration)}</p>
<div class="timeline"><div class="track">${labels}${bars}</div><div class="axis"><span>0:00</span><span>${clock(duration / 2)}</span><span>${clock(duration)}</span></div></div>
<div class="grid">
${cards}
</div>
</main></body></html>
`;
}
