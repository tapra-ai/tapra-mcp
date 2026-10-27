import fs from 'node:fs';
import path from 'node:path';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, isInside } from './config.js';

/** What a tool hands back: a summary, plus the files it made (returned inline outside files mode). */
export interface ToolOutput {
  text: string;
  files?: string[];
}

type TextContent = { type: 'text'; text: string };
type ResourceContent = {
  type: 'resource';
  resource: { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string };
};
export type Content = TextContent | ResourceContent;

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.txt': 'text/plain',
  '.json': 'application/json'
};

const TEXT_TYPES = new Set(['.srt', '.vtt', '.txt', '.json']);

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** `tapra://output/<path inside the output folder>` */
export function resourceUri(file: string): string {
  const rel = path.relative(config.outputDir, file).split(path.sep).map(encodeURIComponent).join('/');
  return `tapra://output/${rel}`;
}

function fileFromUri(rel: string): string {
  const full = path.resolve(config.outputDir, ...rel.split('/').map(decodeURIComponent));
  if (!isInside(full, config.outputDir)) throw new Error('Resource is outside the Tapra output folder.');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`No such Tapra output: ${rel}`);
  return full;
}

function embed(file: string): ResourceContent {
  const ext = path.extname(file).toLowerCase();
  const uri = resourceUri(file);
  const mimeType = mimeFor(file);
  return TEXT_TYPES.has(ext)
    ? { type: 'resource', resource: { uri, mimeType, text: fs.readFileSync(file, 'utf8') } }
    : { type: 'resource', resource: { uri, mimeType, blob: fs.readFileSync(file).toString('base64') } };
}

/** Turns a tool's output into MCP content according to TAPRA_MCP_OUTPUT_MODE. */
export function toContent(out: ToolOutput): Content[] {
  const content: Content[] = [{ type: 'text', text: out.text }];
  if (config.outputMode === 'files' || !out.files?.length) return content;
  const skipped: string[] = [];
  for (const file of out.files) {
    const size = fs.statSync(file).size;
    if (size > config.maxInlineBytes) skipped.push(`${path.basename(file)} (${(size / 1048576).toFixed(1)} MB)`);
    else content.push(embed(file));
  }
  if (skipped.length) {
    content.push({
      type: 'text',
      text:
        `Too large to return inline: ${skipped.join(', ')}. Read them later as tapra://output resources ` +
        `or raise TAPRA_MCP_MAX_INLINE_MB.`
    });
  }
  return content;
}

/** Lets clients re-read any file the server made, as tapra://output/... */
export function registerOutputResources(server: McpServer): void {
  server.registerResource(
    'tapra-output',
    new ResourceTemplate('tapra://output/{+path}', { list: undefined }),
    {
      title: 'Tapra output file',
      description: 'A file made by a Tapra tool (audio, subtitles, transcript, manifest).'
    },
    async (uri, vars) => {
      const rel = Array.isArray(vars.path) ? vars.path.join('/') : String(vars.path ?? '');
      const file = fileFromUri(rel);
      const ext = path.extname(file).toLowerCase();
      const mimeType = mimeFor(file);
      return {
        contents: [
          TEXT_TYPES.has(ext)
            ? { uri: uri.href, mimeType, text: fs.readFileSync(file, 'utf8') }
            : { uri: uri.href, mimeType, blob: fs.readFileSync(file).toString('base64') }
        ]
      };
    }
  );
}
