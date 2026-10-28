// Pure functions: subtitles, WAV handling, file-name similarity, voices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import { sineWav } from './helpers/mock-api.mjs';

// The server modules read config at import; point it at temp folders so nothing real is created.
process.env.TAPRA_OUTPUT_DIR = os.tmpdir();
process.env.TAPRA_BASE_PATH = os.tmpdir();
process.env.TAPRA_MCP_OUTPUT_MODE = 'files';
const { decodeWav, encodeWav, mixAt, resample } = await import('../dist/media.js');
const { buildCues, parseSubtitles, splitScript, toSrt, toTxt, toVtt } = await import('../dist/subtitles.js');
const { CLONING_UNAVAILABLE, VOICES, voiceById } = await import('../dist/voices.js');
const { similarity } = await import('../dist/config.js');

test('SRT and VTT round-trip through the parser', () => {
  const cues = [
    { start: 0.5, end: 2.25, text: 'عسلامة، شنحوالك؟' },
    { start: 3661.001, end: 3662, text: 'ça va, merci barcha', speaker: 'S2' }
  ];
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,500 --> 00:00:02,250\nعسلامة، شنحوالك؟\n/);
  assert.match(srt, /01:01:01,001 --> 01:01:02,000\n\[S2\] ça va, merci barcha/);
  const back = parseSubtitles(srt);
  assert.equal(back.length, 2);
  assert.equal(back[1].start, 3661.001);
  assert.equal(back[1].text, '[S2] ça va, merci barcha');

  const vtt = toVtt(cues);
  assert.ok(vtt.startsWith('WEBVTT\n\n00:00:00.500 --> 00:00:02.250'));
  assert.deepEqual(parseSubtitles(vtt).map((c) => c.end), [2.25, 3662]);
});

test('parser tolerates BOM, CRLF and styling tags', () => {
  const cues = parseSubtitles('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Yalla</i>\r\n\r\n');
  assert.deepEqual(cues, [{ start: 1, end: 2, text: 'Yalla' }]);
});

test('word timestamps are regrouped into readable cues with speakers', () => {
  const words = [];
  for (let i = 0; i < 20; i++) words.push({ text: `kelma${i}`, t0_ms: i * 300, t1_ms: i * 300 + 250 });
  const segments = [{ id: 0, start: 0, end: 6, text: 'x' }];
  const turns = [
    { speaker: 'S1', start_ms: 0, end_ms: 3000 },
    { speaker: 'S2', start_ms: 3000, end_ms: 6000 }
  ];
  const cues = buildCues(segments, words, turns, 30);
  assert.ok(cues.length >= 3);
  for (const c of cues) assert.ok(c.text.length <= 30, `cue too long: ${c.text}`);
  assert.equal(cues[0].speaker, 'S1');
  assert.equal(cues.at(-1).speaker, 'S2');
  assert.match(toTxt(cues, ''), /^\[00:00\] S1: kelma0/);
});

test('long pauses split cues; segments are used when there are no words', () => {
  const words = [
    { text: 'a', t0_ms: 0, t1_ms: 200 },
    { text: 'b', t0_ms: 2000, t1_ms: 2200 }
  ];
  assert.equal(buildCues([], words, undefined, 84).length, 2);
  const segs = [{ id: 0, start: 1, end: 2, text: ' hello ' }, { id: 1, start: 2, end: 3, text: '   ' }];
  assert.deepEqual(buildCues(segs, null, undefined, 84), [{ start: 1, end: 2, text: 'hello' }]);
});

test('scripts split on lines and long paragraphs on sentences', () => {
  assert.deepEqual(splitScript('Ahla.\n\nBikom fi Tapra.\n'), ['Ahla.', 'Bikom fi Tapra.']);
  const long = Array.from({ length: 20 }, (_, i) => `Jomla numero ${i} hiya hedhi.`).join(' ');
  const parts = splitScript(long);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 280);
});

test('WAV decode/encode round-trip, resample and mix', () => {
  const a = decodeWav(sineWav(1, 24000));
  assert.equal(a.sampleRate, 24000);
  assert.equal(a.samples.length, 24000);
  const again = decodeWav(encodeWav(a));
  assert.equal(again.samples.length, 24000);
  assert.ok(Math.abs(again.samples[100] - a.samples[100]) < 1e-3);

  const r = resample(a, 16000);
  assert.equal(r.samples.length, 16000);

  const mixed = mixAt([{ audio: a, startSeconds: 0 }, { audio: r, startSeconds: 2 }], 24000, 5);
  assert.equal(mixed.samples.length, 5 * 24000);
  assert.equal(mixed.samples[Math.round(1.5 * 24000)], 0, 'gap stays silent');
});

test('decodeWav rejects non-WAV data', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav at all')), /Not a WAV/);
});

test('file-name similarity ranks typos above unrelated names', () => {
  assert.equal(similarity('interview', 'interview'), 1);
  assert.ok(similarity('interveiw', 'interview') > 0.7);
  assert.ok(similarity('intervew', 'holiday photos') < 0.4);
  assert.ok(similarity('podcast', 'podcast episode 3') >= 0.75, 'containment bonus');
});

test('five named voices; unknown names and cloning are refused', () => {
  assert.deepEqual(VOICES.map((v) => v.id), ['amal', 'salma', 'salah', 'fahmi', 'leo']);
  for (const v of VOICES) assert.ok(v.description.length > 10);
  assert.equal(voiceById(' Salma ').id, 'salma');
  assert.throws(() => voiceById('khadija'), /Unknown voice "khadija"/);
  assert.match(CLONING_UNAVAILABLE, /not currently available/);
  for (const v of VOICES) assert.ok(CLONING_UNAVAILABLE.includes(v.name));
});
