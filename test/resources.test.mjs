// TAPRA_MCP_OUTPUT_MODE: resources returns files inline; both saves and returns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { makeFolders, startServer } from './helpers/harness.mjs';
import { startMock } from './helpers/mock-api.mjs';

let mock;
let folders;

before(async () => {
  mock = await startMock();
  folders = makeFolders();
});

after(async () => {
  await mock?.close();
  folders?.cleanup();
});

test('resources mode returns audio inline and writes nothing to the output folder', async () => {
  const tapra = await startServer(mock, folders, { TAPRA_MCP_OUTPUT_MODE: 'resources' });
  try {
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom', voice: 'leo' });
    assert.equal(r.isError, false, r.text);
    const res = r.content.find((c) => c.type === 'resource');
    assert.ok(res, 'audio comes back as an embedded resource');
    assert.equal(res.resource.mimeType, 'audio/wav');
    assert.match(res.resource.uri, /^tapra:\/\/output\/speech_.*\.wav$/);
    assert.equal(Buffer.from(res.resource.blob, 'base64').toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(fs.readdirSync(folders.output), []);

    // The same file can be read again by URI.
    const read = await tapra.client.readResource({ uri: res.resource.uri });
    assert.equal(read.contents[0].blob, res.resource.blob);

    // Text outputs come back as text.
    const v = await tapra.call('create_voiceover', { lines: ['Ahla'], output_dir: 'vo' });
    const manifest = v.content.find((c) => c.type === 'resource' && c.resource.mimeType === 'application/json');
    assert.equal(JSON.parse(manifest.resource.text).segments.length, 1);

    // URIs cannot escape the output folder.
    await assert.rejects(tapra.client.readResource({ uri: 'tapra://output/..%2F..%2Fsecret.txt' }), /outside the Tapra output folder/);
  } finally {
    await tapra.close();
  }
});

test('both mode saves the file and returns it inline; size cap is respected', async () => {
  const tapra = await startServer(mock, folders, { TAPRA_MCP_OUTPUT_MODE: 'both', TAPRA_MCP_MAX_INLINE_MB: '0.01' });
  try {
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom fi Tapra, lyoum', output_path: 'big.wav' });
    assert.ok(fs.existsSync(`${folders.output}/big.wav`));
    assert.ok(!r.content.some((c) => c.type === 'resource'), 'over the cap: not inlined');
    assert.match(r.text, /Too large to return inline: big\.wav/);
  } finally {
    await tapra.close();
  }
});

test('files mode (default) returns only text', async () => {
  const tapra = await startServer(mock, folders);
  try {
    const r = await tapra.call('text_to_speech', { text: 'Ahla' });
    assert.ok(r.content.every((c) => c.type === 'text'));
  } finally {
    await tapra.close();
  }
});

test('an invalid output mode stops the server with a clear message', async () => {
  await assert.rejects(startServer(mock, folders, { TAPRA_MCP_OUTPUT_MODE: 'cloud' }));
});
