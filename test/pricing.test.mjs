import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { billableCharacters, speechCostMicroTnd } from '../dist/pricing.js';
import { makeFolders, startServer } from './helpers/harness.mjs';
import { PRICES, startMock } from './helpers/mock-api.mjs';

test('speech counts include tags and use trimmed NFC code points', () => {
  assert.equal(billableCharacters('[euh] ' + 'b'.repeat(994)), 1000);
  assert.equal(billableCharacters('  ' + 'e\u0301'.repeat(1000) + '  '), 1000);
  assert.equal(billableCharacters('\u{1f600}'.repeat(1000)), 1000);
});

test('Flash uses its explicit rate before applying each request minimum', () => {
  const stale = { ...PRICES, ttsFlashMultiplier: 0.8 };
  assert.equal(speechCostMicroTnd(stale, ['a'.repeat(1000)], true), 300000);
  assert.equal(speechCostMicroTnd(stale, ['a'], true), 3000);
  assert.equal(speechCostMicroTnd(stale, ['a', 'b'.repeat(1000)], true), 303000);
  assert.equal(speechCostMicroTnd(stale, ['a', 'b'.repeat(1000)]), 423000);
  const { ttsFlashMicroTndPerUnit: _fixed, ...legacy } = PRICES;
  assert.equal(speechCostMicroTnd(legacy, ['a'.repeat(1000)], true), 300000);
});

let mock;
let folders;
let server;
before(async () => {
  mock = await startMock();
  folders = makeFolders();
  server = await startServer(mock, folders);
});
after(async () => {
  await server?.close();
  await mock?.close();
  folders?.cleanup();
});

test('tagged speech above its cap sends no request', async () => {
  const count = mock.calls('/v1/audio/speech').length;
  const result = await server.call('text_to_speech', {
    text: '[euh] ' + 'b'.repeat(994), quality: 'flash', max_cost_tnd: 0.299
  });
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, /above the .* limit/);
  assert.equal(mock.calls('/v1/audio/speech').length, count);
});

test('a one-character Flash request still requires the text minimum', async () => {
  const count = mock.calls('/v1/audio/speech').length;
  const result = await server.call('text_to_speech', {
    text: 'a', quality: 'flash', max_cost_tnd: 0.0029
  });
  assert.equal(result.isError, true, result.text);
  assert.equal(mock.calls('/v1/audio/speech').length, count);
});

test('Unicode normalization avoids rejecting affordable speech', async () => {
  for (const text of ['  ' + 'e\u0301'.repeat(500) + '  ', '\u{1f600}'.repeat(500)]) {
    const result = await server.call('text_to_speech', {
      text, quality: 'flash', max_cost_tnd: 0.15
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Cost: 0\.150 TND/);
  }
});

test('unequal voiceover lines cannot bypass a cap through averaging', async () => {
  for (const [quality, cap] of [['flash', 0.301], ['full', 0.421]]) {
    const count = mock.calls('/v1/audio/speech').length;
    const result = await server.call('create_voiceover', {
      lines: ['a', 'b'.repeat(1000)], quality, max_cost_tnd: cap
    });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /above the .* limit/);
    assert.equal(mock.calls('/v1/audio/speech').length, count);
  }
});

test('voiceover at its exact total cap succeeds and reports that charge', async () => {
  const result = await server.call('create_voiceover', {
    lines: ['a', 'b'.repeat(1000)], quality: 'flash', max_cost_tnd: 0.303
  });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /Cost: 0\.303 TND/);
});
