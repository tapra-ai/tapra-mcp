// Path safety: inputs confined to TAPRA_BASE_PATH, outputs to TAPRA_OUTPUT_DIR, no overwrites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { makeFolders } from './helpers/harness.mjs';

const folders = makeFolders();
process.env.TAPRA_BASE_PATH = folders.input;
process.env.TAPRA_OUTPUT_DIR = folders.output;
process.env.TAPRA_MCP_OUTPUT_MODE = 'files';
const { resolveInput, resolveOutput, resolveOutputDir, suggestFiles } = await import('../dist/config.js');
after(() => folders.cleanup());

fs.writeFileSync(path.join(folders.input, 'interview_2026.mp4'), 'x');
fs.writeFileSync(path.join(folders.input, 'notes.txt'), 'x');
fs.mkdirSync(path.join(folders.input, 'sub'));
fs.writeFileSync(path.join(folders.input, 'sub', 'episode1.srt'), 'x');
fs.writeFileSync(path.join(folders.root, 'secret.wav'), 'x');

test('relative and absolute inputs inside the base folder resolve', () => {
  assert.equal(resolveInput('interview_2026.mp4', 'media'), path.join(folders.input, 'interview_2026.mp4'));
  assert.equal(resolveInput(path.join(folders.input, 'sub', 'episode1.srt'), 'subtitles'), path.join(folders.input, 'sub', 'episode1.srt'));
});

test('inputs outside the base folder are refused', () => {
  assert.throws(() => resolveInput('../secret.wav', 'media'), /outside the allowed folder/);
  assert.throws(() => resolveInput(path.join(folders.root, 'secret.wav'), 'media'), /outside the allowed folder/);
});

test('symlinks cannot point outside the base folder', (t) => {
  const link = path.join(folders.input, 'link.wav');
  try {
    fs.symlinkSync(path.join(folders.root, 'secret.wav'), link);
  } catch {
    t.skip('symlinks need extra rights on this system');
    return;
  }
  assert.throws(() => resolveInput('link.wav', 'media'), /links outside the allowed folder/);
});

test('missing files suggest close matches', () => {
  assert.throws(() => resolveInput('interveiw_2026.mp4', 'media'), (err) => {
    assert.match(err.message, /File not found/);
    assert.match(err.message, /Did you mean: .*interview_2026\.mp4/);
    return true;
  });
  // Suggestions only include the right kind of file.
  assert.deepEqual(suggestFiles(path.join(folders.input, 'notes.wav'), 'media'), []);
  assert.throws(() => resolveInput('sub/episode2.srt', 'subtitles'), /Did you mean: .*episode1\.srt/);
});

test('wrong file types are refused', () => {
  assert.throws(() => resolveInput('notes.txt', 'media'), /does not look like an audio or video file/);
  assert.throws(() => resolveInput('interview_2026.mp4', 'subtitles'), /SRT\/VTT/);
});

test('outputs stay in the output folder and never overwrite', () => {
  const first = resolveOutput('take.wav', 'speech', 'wav');
  assert.equal(first, path.join(folders.output, 'take.wav'));
  fs.writeFileSync(first, 'old');
  const second = resolveOutput('take.wav', 'speech', 'wav');
  assert.equal(second, path.join(folders.output, 'take-1.wav'));
  assert.equal(fs.readFileSync(first, 'utf8'), 'old');

  assert.equal(resolveOutput('nested/clip', 'speech', 'wav'), path.join(folders.output, 'nested', 'clip.wav'));
  assert.throws(() => resolveOutput('../escape.wav', 'speech', 'wav'), /outside the allowed folder/);
  assert.throws(() => resolveOutput(path.join(folders.input, 'x.wav'), 'speech', 'wav'), /outside the allowed folder/);
  assert.match(path.basename(resolveOutput(undefined, 'speech', 'wav')), /^speech_\d{8}-\d{6}-[0-9a-f]{4}\.wav$/);
});

test('output folders are fresh: a non-empty one gets a suffix', () => {
  const a = resolveOutputDir('project', 'voiceover');
  fs.writeFileSync(path.join(a, 'voiceover.wav'), 'x');
  const b = resolveOutputDir('project', 'voiceover');
  assert.equal(b, path.join(folders.output, 'project-1'));
  assert.throws(() => resolveOutputDir('../../elsewhere', 'voiceover'), /outside the allowed folder/);
});
