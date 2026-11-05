// Security fixes: spending cap, API address allowlist, private input folders,
// output link escapes, and the Windows shell player.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ffmpeg, hasFfmpeg, makeFolders, startServer } from './helpers/harness.mjs';
import { sineWav, startMock } from './helpers/mock-api.mjs';

const folders = makeFolders();
process.env.TAPRA_BASE_PATH = folders.input;
process.env.TAPRA_OUTPUT_DIR = folders.output;
process.env.TAPRA_MCP_OUTPUT_MODE = 'files';
delete process.env.TAPRA_MAX_COST_TND;
delete process.env.TAPRA_API_URL;
delete process.env.TAPRA_ALLOW_UNESTIMATED;
const { resolveInput, resolveOutput, resolveOutputDir, privatePart } = await import('../dist/config.js');
const { checkBudget, effectiveLimit, DEFAULT_MAX_COST_TND, isTrustedAdvertisedUrl, checkApiUrlOverride } = await import('../dist/tapra.js');
const { needsShell, checkShellSafe } = await import('../dist/tools-extra.js');
const { wavSeconds } = await import('../dist/media.js');
after(() => folders.cleanup());

// 1. Spending cap ------------------------------------------------------------

test('max_cost_tnd can only lower the cap, never raise it', () => {
  assert.equal(DEFAULT_MAX_COST_TND, 20);
  assert.equal(effectiveLimit(undefined, undefined), 20);
  assert.equal(effectiveLimit(9999, undefined), 20, 'the model cannot raise the default cap');
  assert.equal(effectiveLimit(9999, 20), 20, 'nor the env cap');
  assert.equal(effectiveLimit(1, 20), 1, 'but it can lower it');
  assert.equal(effectiveLimit(undefined, 50), 50, 'the env var can raise the default');
  assert.throws(() => checkBudget(21, 9999, 'This speech', undefined), (err) => {
    assert.match(err.message, /above the 20\.000 TND limit/);
    assert.match(err.message, /TAPRA_MAX_COST_TND/);
    assert.doesNotMatch(err.message, /raise max_cost_tnd/i);
    return true;
  });
  assert.throws(() => checkBudget(25, 1000, 'x', 20), /20\.000 TND limit \(TAPRA_MAX_COST_TND\)/);
  assert.throws(() => checkBudget(2, 1, 'x', 20), /1\.000 TND limit \(max_cost_tnd for this call\)/);
  checkBudget(19.99, undefined, 'x', undefined);
  checkBudget(19, 9999, 'x', 20);
  // Unknown estimate: refused unless TAPRA_ALLOW_UNESTIMATED=1.
  assert.throws(() => checkBudget(null, undefined, 'This speech', undefined, false), /TAPRA_ALLOW_UNESTIMATED=1/);
  assert.throws(() => checkBudget(Number.NaN, undefined, 'x', undefined, false), /cannot be estimated/);
  checkBudget(null, undefined, 'x', undefined, true);
});

test('end to end: a huge max_cost_tnd does not lift TAPRA_MAX_COST_TND', async () => {
  const mock = await startMock();
  const tapra = await startServer(mock, folders, { TAPRA_MAX_COST_TND: '0.0001' });
  try {
    const before = mock.calls('/v1/audio/speech').length;
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom', max_cost_tnd: 9999 });
    assert.equal(r.isError, true);
    assert.match(r.text, /TAPRA_MAX_COST_TND/);
    assert.equal(mock.calls('/v1/audio/speech').length, before, 'nothing was sent');
  } finally {
    await tapra.close();
    await mock.close();
  }
});

// 2. API address ------------------------------------------------------------

test('only https tapra.tn addresses advertised by the website are trusted', () => {
  const site = 'https://www.tapra.tn';
  assert.ok(isTrustedAdvertisedUrl('https://api.tapra.tn', site));
  assert.ok(isTrustedAdvertisedUrl('https://tapra.tn', site));
  assert.ok(isTrustedAdvertisedUrl('https://eu.api.TAPRA.tn:8443', site));
  assert.ok(!isTrustedAdvertisedUrl('http://api.tapra.tn', site), 'no plain http');
  assert.ok(!isTrustedAdvertisedUrl('https://evil.example', site));
  assert.ok(!isTrustedAdvertisedUrl('https://tapra.tn.evil.example', site));
  assert.ok(!isTrustedAdvertisedUrl('https://eviltapra.tn', site));
  assert.ok(!isTrustedAdvertisedUrl('https://user:pw@api.tapra.tn', site));
  assert.ok(!isTrustedAdvertisedUrl('http://127.0.0.1:8787', site), 'a remote site cannot point the key at localhost');
  assert.ok(!isTrustedAdvertisedUrl('not a url', site));
  // A local dev site may advertise a local API.
  assert.ok(isTrustedAdvertisedUrl('http://127.0.0.1:8787', 'http://127.0.0.1:3000'));
  assert.ok(!isTrustedAdvertisedUrl('https://evil.example', 'http://127.0.0.1:3000'));
});

test('TAPRA_API_URL: https anywhere (warned), http only on loopback', () => {
  assert.deepEqual(checkApiUrlOverride('https://api.tapra.tn'), { ok: true });
  assert.deepEqual(checkApiUrlOverride('http://127.0.0.1:8787'), { ok: true });
  assert.deepEqual(checkApiUrlOverride('http://localhost:8787'), { ok: true });
  assert.deepEqual(checkApiUrlOverride('http://[::1]:8787'), { ok: true });
  const other = checkApiUrlOverride('https://my-proxy.example');
  assert.equal(other.ok, true);
  assert.match(other.warning, /not a tapra\.tn host/);
  assert.equal(checkApiUrlOverride('http://api.tapra.tn').ok, false);
  assert.equal(checkApiUrlOverride('http://192.168.1.5:8787').ok, false);
  assert.equal(checkApiUrlOverride('ftp://api.tapra.tn').ok, false);
});

// 3. Private input folders --------------------------------------------------

test('hidden and app-data folders inside the base folder are refused', () => {
  for (const dir of ['.ssh', '.config', 'AppData', 'appdata', 'Library', 'LIBRARY']) {
    fs.mkdirSync(path.join(folders.input, dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(folders.input, dir, 'sub', 'clip.wav'), 'x');
    assert.throws(() => resolveInput(`${dir}/sub/clip.wav`, 'media'), /hidden or app-data folder/, dir);
  }
  fs.writeFileSync(path.join(folders.input, '.hidden.wav'), 'x');
  assert.throws(() => resolveInput('.hidden.wav', 'media'), /hidden or app-data folder/);
  // Missing files there get no suggestions (no listing of private folders).
  assert.throws(() => resolveInput('.ssh/sub/clpi.wav', 'media'), (err) => {
    assert.doesNotMatch(err.message, /Did you mean/);
    return true;
  });
  // AppData/Library only count directly under the base folder; dot parts count at any depth.
  for (const rel of ['Music/Library/song.wav', 'Projects/AppData/take.wav']) {
    fs.mkdirSync(path.join(folders.input, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(folders.input, rel), 'x');
    assert.equal(resolveInput(rel, 'media'), path.join(folders.input, rel));
  }
  fs.mkdirSync(path.join(folders.input, 'Music', '.cache'), { recursive: true });
  fs.writeFileSync(path.join(folders.input, 'Music', '.cache', 'x.wav'), 'x');
  assert.throws(() => resolveInput('Music/.cache/x.wav', 'media'), /hidden or app-data folder/);
  // Ordinary folders, and names merely containing a dot, still work.
  fs.mkdirSync(path.join(folders.input, 'My.Library2'));
  fs.writeFileSync(path.join(folders.input, 'My.Library2', 'a.b.wav'), 'x');
  assert.equal(resolveInput('My.Library2/a.b.wav', 'media'), path.join(folders.input, 'My.Library2', 'a.b.wav'));
  assert.equal(privatePart(path.join(folders.input, 'Music', 'x.wav'), folders.input), undefined);
  assert.equal(privatePart(path.join(folders.input, 'x', '.git', 'y'), folders.input), '.git');
});

test('a normal-looking link into a hidden folder is refused on its real path', (t) => {
  fs.mkdirSync(path.join(folders.input, '.secret'), { recursive: true });
  fs.writeFileSync(path.join(folders.input, '.secret', 'key.wav'), 'x');
  const link = path.join(folders.input, 'innocent.wav');
  try {
    fs.symlinkSync(path.join(folders.input, '.secret', 'key.wav'), link);
  } catch {
    t.skip('symlinks need extra rights on this system');
    return;
  }
  assert.throws(() => resolveInput('innocent.wav', 'media'), /hidden or app-data folder/);
});

// 4. Output link escapes ----------------------------------------------------

test('a junction or symlink in the output folder cannot lead outside it', (t) => {
  const outside = path.join(folders.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(folders.output, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('cannot create a directory link on this system');
    return;
  }
  assert.throws(() => resolveOutput('escape/x.wav', 'speech', 'wav'), /links outside the allowed folder/);
  assert.throws(() => resolveOutput('escape/deeper/x.wav', 'speech', 'wav'), /links outside the allowed folder/);
  assert.throws(() => resolveOutputDir('escape', 'voiceover'), /links outside the allowed folder/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was created outside');
  // Normal outputs are unaffected.
  assert.equal(resolveOutput('fine/x.wav', 'speech', 'wav'), path.join(folders.output, 'fine', 'x.wav'));
});

// 5. Windows shell player ---------------------------------------------------

test('.cmd/.bat players need a shell only on Windows', () => {
  assert.equal(needsShell('C:\\tools\\play.cmd', 'win32'), true);
  assert.equal(needsShell('C:\\tools\\PLAY.BAT', 'win32'), true);
  assert.equal(needsShell('C:\\tools\\ffplay.exe', 'win32'), false);
  assert.equal(needsShell('/usr/bin/play.cmd', 'linux'), false);
});

test('shell metacharacters in file names are refused for shell players', () => {
  checkShellSafe(['C:\\tools\\play.cmd', 'C:\\Users\\me\\Tapra\\speech_2026 (1).wav']);
  for (const ch of ['%', '!', '^', '&', '|', '<', '>', '"']) {
    assert.throws(() => checkShellSafe(['C:\\tools\\play.cmd', `C:\\out\\a${ch}b.wav`]), /Windows shell would interpret/, ch);
  }
  assert.throws(() => checkShellSafe(['C:\\tools\\play.cmd', 'C:\\out\\%USERPROFILE%.wav']), /\.exe player/);
});

// Round 2: cost checks use the real audio length and fail closed --------------

test('wavSeconds measures the data, not the header', () => {
  const f = path.join(folders.root, 'len.wav');
  fs.writeFileSync(f, sineWav(3, 16000));
  assert.ok(Math.abs(wavSeconds(f) - 3) < 0.01, String(wavSeconds(f)));
});

test('no price list: paid calls fail closed unless TAPRA_ALLOW_UNESTIMATED=1', async () => {
  const mock = await startMock();
  const dead = 'http://127.0.0.1:9'; // nothing listens: price list unreachable
  const env = { TAPRA_SITE_URL: dead, TAPRA_API_URL: mock.url };
  let tapra = await startServer(mock, folders, env);
  try {
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom' });
    assert.equal(r.isError, true);
    assert.match(r.text, /cannot be estimated.*TAPRA_ALLOW_UNESTIMATED=1/s);
    assert.equal(mock.calls('/v1/audio/speech').length, 0, 'nothing was sent');
    if (hasFfmpeg) {
      fs.writeFileSync(path.join(folders.input, 'short.wav'), sineWav(2, 16000));
      const s = await tapra.call('speech_to_text', { input_path: 'short.wav' });
      assert.equal(s.isError, true);
      assert.match(s.text, /TAPRA_ALLOW_UNESTIMATED/);
      assert.equal(mock.calls('/v1/audio/transcriptions').length, 0);
    }
  } finally {
    await tapra.close();
  }
  tapra = await startServer(mock, folders, { ...env, TAPRA_ALLOW_UNESTIMATED: '1' });
  try {
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom' });
    assert.equal(r.isError, false, r.text);
  } finally {
    await tapra.close();
    await mock.close();
  }
});

test('a WebM with no duration header is measured after extraction and capped', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  // Piped WebM has "Duration: N/A", like MediaRecorder output.
  const webm = path.join(folders.input, 'recorder.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=120', '-c:a', 'libopus', '-f', 'webm', '-live', '1', webm]);
  const mock = await startMock();
  // 0.15 TND/min in the mock: a 0.1 TND cap pays for 40 s, the file is 120 s.
  const tapra = await startServer(mock, folders, { TAPRA_MAX_COST_TND: '0.1' });
  try {
    const r = await tapra.call('speech_to_text', { input_path: 'recorder.webm', diarize: false });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /longer than the 0\.100 TND limit/);
    assert.equal(mock.calls('/v1/audio/transcriptions').length, 0, 'nothing was uploaded');
    const d = await tapra.call('diarize_audio', { input_path: 'recorder.webm' });
    assert.equal(d.isError, true, d.text);
    assert.match(d.text, /longer than the 0\.100 TND limit/);
    assert.equal(mock.calls('/v1/audio/diarization').length, 0);
    // A lower per-call cap is still honoured.
    const ok = await tapra.call('speech_to_text', { input_path: 'recorder.webm', diarize: false, max_cost_tnd: 0.05 });
    assert.equal(ok.isError, true, 'a lower per-call cap still applies');
  } finally {
    await tapra.close();
    await mock.close();
  }
  const roomy = await startMock();
  const t2 = await startServer(roomy, folders, { TAPRA_MAX_COST_TND: '1' });
  try {
    const ok = await t2.call('speech_to_text', { input_path: 'recorder.webm', diarize: false });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(roomy.calls('/v1/audio/transcriptions').length, 1);
  } finally {
    await t2.close();
    await roomy.close();
  }
});
