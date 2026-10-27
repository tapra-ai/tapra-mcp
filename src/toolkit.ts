import { z } from 'zod';
import { toContent, type Content, type ToolOutput } from './output.js';
import { describeError } from './tapra.js';

export type ToolResult = { content: Content[]; isError?: boolean };

export async function run(fn: () => Promise<string | ToolOutput>): Promise<ToolResult> {
  try {
    const out = await fn();
    return { content: toContent(typeof out === 'string' ? { text: out } : out) };
  } catch (err) {
    return { content: [{ type: 'text', text: describeError(err) }], isError: true };
  }
}

const MAX_INLINE_CHARS = 12_000;

export function inline(text: string): string {
  return text.length > MAX_INLINE_CHARS
    ? `${text.slice(0, MAX_INLINE_CHARS)}\n… [${text.length - MAX_INLINE_CHARS} more characters in the saved file]`
    : text;
}

/** Paid calls: they spend balance, so clients should confirm them. */
export const PAID = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Free calls to Tapra that change nothing. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Free, local work that writes new files (never overwrites). */
export const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export const maxCost = z
  .number()
  .positive()
  .optional()
  .describe('Refuse to run if the estimated cost is above this many TND. Defaults to TAPRA_MAX_COST_TND when set.');

// ---------------------------------------------------------------------------
// Progress notifications, so clients show progress and keep long calls alive
// ---------------------------------------------------------------------------

export type Progress = (done: number, total: number, message: string) => void;

interface RequestExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

/** Sends progress only when the client asked for it (sent a progressToken). */
export function progressFrom(extra: unknown): Progress {
  const e = extra as RequestExtra | undefined;
  const token = e?._meta?.progressToken;
  if (token === undefined || !e?.sendNotification) return () => {};
  return (done, total, message) => {
    void e
      .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } })
      .catch(() => {});
  };
}
