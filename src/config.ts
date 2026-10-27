import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Website origin: serves the price list, account balance, and the current API address. */
export const DEFAULT_SITE_URL = 'https://tapra.tn';
/** Used only if the website cannot be reached to discover the API address. */
export const FALLBACK_API_URL = 'https://api.tapra.tn';

export type OutputMode = 'files' | 'resources' | 'both';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function positiveNumber(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function outputMode(value: string | undefined): OutputMode {
  const mode = (value?.trim().toLowerCase() || 'files') as OutputMode;
  if (!['files', 'resources', 'both'].includes(mode)) {
    throw new Error(`TAPRA_MCP_OUTPUT_MODE must be files, resources, or both (got "${value}").`);
  }
  return mode;
}

/** Real path of an existing folder, so symlinks cannot widen the allowed area. */
function realDir(p: string): string {
  const full = path.resolve(expandHome(p));
  fs.mkdirSync(full, { recursive: true });
  return fs.realpathSync.native(full);
}

const mode = outputMode(process.env.TAPRA_MCP_OUTPUT_MODE);

export const config = {
  apiKey: process.env.TAPRA_API_KEY?.trim() || undefined,
  /** Explicit API origin. When unset, it is read from the website's API docs. */
  apiUrlOverride: process.env.TAPRA_API_URL?.trim().replace(/\/+$/, '') || undefined,
  siteUrl: (process.env.TAPRA_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, ''),
  /** files: save to outputDir. resources: return files inline only. both: do both. */
  outputMode: mode,
  /**
   * Where results are written. In resources mode they go to a private temp folder and
   * come back inline, so nothing lands in the user's folders.
   */
  outputDir:
    mode === 'resources'
      ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tapra-mcp-out-')))
      : realDir(process.env.TAPRA_OUTPUT_DIR?.trim() || '~/Tapra'),
  /** Inputs must live inside this folder. */
  basePath: realDir(process.env.TAPRA_BASE_PATH?.trim() || os.homedir()),
  ffmpeg: process.env.TAPRA_FFMPEG_PATH?.trim() || 'ffmpeg',
  /** Refuse any single tool call estimated above this many TND. */
  maxCostTnd: positiveNumber(process.env.TAPRA_MAX_COST_TND),
  /** Per-request HTTP timeout. Long audio can take a while on the model host. */
  timeoutSeconds: positiveNumber(process.env.TAPRA_TIMEOUT_SECONDS) ?? 600,
  /** Largest file returned inline in resources/both mode. */
  maxInlineBytes: (positiveNumber(process.env.TAPRA_MCP_MAX_INLINE_MB) ?? 15) * 1024 * 1024
};

// ---------------------------------------------------------------------------
// Path safety: reads stay inside basePath, writes inside outputDir, nothing is overwritten.
// ---------------------------------------------------------------------------

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves a path against `root` and refuses anything that escapes it. */
function confine(p: string, root: string, what: string, envName: string): string {
  const expanded = expandHome(p.trim());
  const full = path.resolve(root, expanded);
  if (!isInside(full, root)) {
    throw new Error(`${what} ${full} is outside the allowed folder ${root}. Move it there or change ${envName}.`);
  }
  return full;
}

export type InputKind = 'media' | 'audio' | 'subtitles' | 'transcript' | 'any';

const EXTENSIONS: Record<Exclude<InputKind, 'any'>, string[]> = {
  transcript: ['.json', '.srt', '.vtt'],
  audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma', '.webm'],
  media: [
    '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma',
    '.mp4', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts'
  ],
  subtitles: ['.srt', '.vtt']
};

function stem(name: string): string {
  return path.basename(name, path.extname(name)).toLowerCase().replace(/[\s_\-.]+/g, ' ').trim();
}

/**
 * Similarity 0..1 from edit distance where swapping two neighbouring letters counts as
 * one edit (typos like "clpi" for "clip"), with a bonus when one name contains the other.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  const score = 1 - d[a.length]![b.length]! / Math.max(a.length, b.length);
  return a.includes(b) || b.includes(a) ? Math.max(score, 0.75) : score;
}

/** Files near `wanted` whose names look like it, best first. */
export function suggestFiles(wanted: string, kind: InputKind, limit = 5): string[] {
  const exts = kind === 'any' ? undefined : EXTENSIONS[kind];
  const target = stem(wanted);
  const dirs = new Set<string>();
  let dir = path.dirname(wanted);
  // Look in the closest existing folder (inside basePath), then the base folder itself.
  while (!fs.existsSync(dir) && isInside(path.dirname(dir), config.basePath) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  if (fs.existsSync(dir) && isInside(dir, config.basePath)) dirs.add(dir);
  dirs.add(config.basePath);

  const scored: { file: string; score: number }[] = [];
  let seen = 0;
  for (const d of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > 5000) break;
      if (!e.isFile()) continue;
      if (exts && !exts.includes(path.extname(e.name).toLowerCase())) continue;
      const score = similarity(target, stem(e.name));
      if (score >= 0.6) scored.push({ file: path.join(d, e.name), score });
    }
  }
  return [...new Map(scored.sort((x, y) => y.score - x.score).map((s) => [s.file, s])).keys()].slice(0, limit);
}

const OUTPUT_URI = 'tapra://output/';

/**
 * Resolves an input file inside basePath; suggests close matches when it is missing.
 * With `allowOutputs`, files this server made are accepted too: a path in the output
 * folder or a `tapra://output/...` URI.
 */
export function resolveInput(p: string, kind: InputKind = 'any', opts: { allowOutputs?: boolean } = {}): string {
  const trimmed = p.trim();
  let full: string;
  if (trimmed.startsWith(OUTPUT_URI)) {
    if (!opts.allowOutputs) throw new Error('This tool takes a file path, not a tapra:// resource.');
    const rel = trimmed.slice(OUTPUT_URI.length).split('/').map(decodeURIComponent);
    full = confine(path.join(...rel), config.outputDir, 'Resource', 'TAPRA_OUTPUT_DIR');
    return checkInput(full, kind, config.outputDir);
  }
  const expanded = path.resolve(config.basePath, expandHome(trimmed));
  if (opts.allowOutputs && isInside(expanded, config.outputDir) && !isInside(expanded, config.basePath)) {
    return checkInput(expanded, kind, config.outputDir);
  }
  full = confine(p, config.basePath, 'Input file', 'TAPRA_BASE_PATH');
  return checkInput(full, kind, config.basePath);
}

function checkInput(full: string, kind: InputKind, root: string): string {
  if (!fs.existsSync(full)) {
    const near = suggestFiles(full, kind);
    throw new Error(
      `File not found: ${full}.` + (near.length ? ` Did you mean: ${near.join(', ')}?` : ` Paths are relative to ${config.basePath}.`)
    );
  }
  // Re-check after resolving symlinks.
  const real = fs.realpathSync.native(full);
  if (!isInside(real, root)) {
    throw new Error(`Input file ${full} links outside the allowed folder ${root}.`);
  }
  if (!fs.statSync(real).isFile()) throw new Error(`Not a file: ${full}`);
  const exts = kind === 'any' ? undefined : EXTENSIONS[kind];
  if (exts && !exts.includes(path.extname(real).toLowerCase())) {
    const what = kind === 'subtitles' ? 'an SRT/VTT file' : kind === 'transcript' ? 'a transcript (.json, .srt or .vtt)' : 'an audio or video file';
    throw new Error(`${full} does not look like ${what}.`);
  }
  return real;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    randomBytes(2).toString('hex')
  );
}

/** A unique name such as `speech_20261027-142233-a1b2.wav`. */
export function uniqueName(prefix: string, ext: string): string {
  return `${prefix}_${stamp()}${ext ? `.${ext.replace(/^\./, '')}` : ''}`;
}

/** `name.ext`, else `name-1.ext`, `name-2.ext`, ... so existing files are never replaced. */
function freePath(full: string): string {
  if (!fs.existsSync(full)) return full;
  const ext = path.extname(full);
  const base = full.slice(0, full.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}${ext}`;
}

/**
 * Where to write an output file: inside outputDir, never over an existing file.
 * No path gets a unique name. Parent folders are created.
 */
export function resolveOutput(p: string | undefined, prefix: string, ext: string): string {
  let full: string;
  if (p && p.trim()) {
    full = confine(p, config.outputDir, 'Output path', 'TAPRA_OUTPUT_DIR');
    // The extension always matches what is written (e.g. "x.wav" with an mp3 format becomes "x.mp3").
    if (ext && path.extname(full).toLowerCase() !== `.${ext}`) {
      full = path.extname(full) && /^\.(wav|mp3|opus|ogg|srt|vtt|txt|json|mp4|mkv)$/i.test(path.extname(full))
        ? full.slice(0, -path.extname(full).length) + `.${ext}`
        : `${full}.${ext}`;
    }
  } else {
    full = path.join(config.outputDir, uniqueName(prefix, ext));
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return freePath(full);
}

/** A fresh, empty folder inside outputDir (an existing non-empty one gets a suffix). */
export function resolveOutputDir(p: string | undefined, prefix: string): string {
  let full = p && p.trim() ? confine(p, config.outputDir, 'Output folder', 'TAPRA_OUTPUT_DIR') : path.join(config.outputDir, uniqueName(prefix, ''));
  if (fs.existsSync(full) && fs.readdirSync(full).length > 0) full = freePath(full);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/** Shows only the key prefix, never the secret. */
export function maskedKey(): string {
  if (!config.apiKey) return 'not set';
  return `${config.apiKey.slice(0, 16)}…`;
}
