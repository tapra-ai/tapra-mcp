#!/usr/bin/env node
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { registerOutputResources } from './output.js';
import { registerExtraTools } from './tools-extra.js';
import { registerTools } from './tools.js';
import { voiceMenu } from './voices.js';

const server = new McpServer(
  { name: 'tapra', title: 'Tapra', version: '0.1.2' },
  {
    instructions:
      'Tapra speech and language tools for Tunisian Derja code-switched with French and English. ' +
      'Paid tools spend the user\'s Tapra balance (TND) and report cost and remaining balance. ' +
      `Input files must be inside ${config.basePath} (relative paths resolve there). ` +
      (config.outputMode === 'resources'
        ? 'Results come back inline as tapra://output resources. '
        : `Results are saved in ${config.outputDir}; existing files are never overwritten. `) +
      'For subtitles use transcribe_video; to dub, translate_subtitles then create_voiceover; edit_audio prepares audio; ' +
      'play_audio plays results; find_in_transcript finds when something is said; call tapra_status if anything fails. ' +
      `Voices: ${voiceMenu()}. Voice cloning is not currently available; if asked to clone a voice, say so and offer these voices.`
  }
);

registerTools(server);
registerExtraTools(server);
registerOutputResources(server);

// In resources mode, results live in a private temp folder that only this process uses.
if (config.outputMode === 'resources') {
  process.on('exit', () => fs.rmSync(config.outputDir, { recursive: true, force: true }));
}

// stdout carries the MCP protocol, so all logging goes to stderr.
await server.connect(new StdioServerTransport());
console.error(`Tapra MCP server ready (site ${config.siteUrl}, output ${config.outputDir}).`);
