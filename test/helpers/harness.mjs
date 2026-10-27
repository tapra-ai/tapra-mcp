// Starts the built server over stdio against the mock API, in throwaway folders.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TEST_KEY } from './mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(here, '..', '..', 'dist', 'index.js');

export const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

/** Fresh input and output folders (real paths, so comparisons are exact). */
export function makeFolders() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tapra-mcp-test-')));
  const input = path.join(root, 'in');
  const output = path.join(root, 'out');
  fs.mkdirSync(input);
  fs.mkdirSync(output);
  return { root, input, output, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

export async function startServer(mock, folders, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: 'ignore',
    env: {
      ...process.env,
      TAPRA_API_KEY: TEST_KEY,
      TAPRA_SITE_URL: mock.url,
      TAPRA_BASE_PATH: folders.input,
      TAPRA_OUTPUT_DIR: folders.output,
      TAPRA_API_URL: '',
      TAPRA_MAX_COST_TND: '',
      TAPRA_MCP_OUTPUT_MODE: '',
      ...env
    }
  });
  const client = new Client({ name: 'tapra-mcp-tests', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    /** Calls a tool and returns { text, isError, content }. */
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { text, isError: Boolean(r.isError), content: r.content };
    },
    close: () => client.close()
  };
}
