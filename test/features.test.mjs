// Effects, Tunisian style, formats, play_audio, find_in_transcript, edit_audio,
// translate_subtitles and progress notifications.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ffmpeg, hasFfmpeg, makeFolders, startServer } from './helpers/harness.mjs';
import { sineWav, startMock } from './helpers/mock-api.mjs';

let mock;
let folders;
let tapra;
let playLog;

before(async () => {
  mock = await startMock();
  folders = makeFolders();
  // A fake player that records what it was asked to play.
  playLog = path.join(folders.root, 'played.txt');
  const fakePlayer = path.join(folders.root, 'fake-player.mjs');
  fs.writeFileSync(fakePlayer, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(playLog)}, process.argv[2] + '\\n');`);
  const launcher = process.platform === 'win32' ? path.join(folders.root, 'player.cmd') : path.join(folders.root, 'player.sh');
  fs.writeFileSync(
    launcher,
    process.platform === 'win32' ? `@"${process.execPath}" "${fakePlayer}" %*\r\n` : `#!/bin/sh\n"${process.execPath}" "${fakePlayer}" "$@"\n`
  );
  fs.chmodSync(launcher, 0o755);

  fs.writeFileSync(path.join(folders.input, 'voice.wav'), sineWav(2, 24000));
  fs.writeFileSync(
    path.join(folders.input, 'talk.json'),
    JSON.stringify({
      text: '',
      segments: [{ id: 0, start: 0, end: 4, text: 'x' }],
      words: [
        { text: 'Ahla', t0_ms: 0, t1_ms: 400 },
        { text: 'bikom', t0_ms: 450, t1_ms: 900 },
        { text: 'fi', t0_ms: 950, t1_ms: 1100 },
        { text: 'التَّطْبِيقَة', t0_ms: 1200, t1_ms: 1900 },
        { text: 'mta3', t0_ms: 2000, t1_ms: 2300 },
        { text: 'Tapra', t0_ms: 2350, t1_ms: 2800 },
        { text: 'Très', t0_ms: 3000, t1_ms: 3300 },
        { text: 'bien.', t0_ms: 3350, t1_ms: 3700 }
      ]
    })
  );
  fs.writeFileSync(
    path.join(folders.input, 'talk.srt'),
    '1\n00:00:01,000 --> 00:00:02,500\n[S1] عسلامة شنحوالك\n\n2\n00:00:03,000 --> 00:00:05,000\n[S2] labes, el 7amdoulah\n\n3\n00:00:06,000 --> 00:00:07,000\nyalla\n'
  );
  tapra = await startServer(mock, folders, { TAPRA_AUDIO_PLAYER: launcher });
});

after(async () => {
  await tapra?.close();
  await mock?.close();
  folders?.cleanup();
});

describe('speech options', () => {
  test('effect tags are passed through, not billed, and documented', async () => {
    const { tools } = await tapra.client.listTools();
    const tts = tools.find((t) => t.name === 'text_to_speech');
    for (const tag of ['euh', 'aaa', 'hmm', 'ahem', 'ouf', 'breath', 'stutter']) assert.ok(tts.description.includes(`[${tag}]`), tag);

    const r = await tapra.call('text_to_speech', { text: '[euh] ma na3rafch, [breath] khalli nchouf' });
    assert.equal(r.isError, false, r.text);
    assert.equal(mock.calls('/v1/audio/speech').at(-1).fields.input, '[euh] ma na3rafch, [breath] khalli nchouf');
  });

  test('unknown effect tags are refused before any charge', async () => {
    const before = mock.calls('/v1/audio/speech').length;
    const r = await tapra.call('text_to_speech', { text: 'Ahla [laugh] bikom' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Unknown effect tag: \[laugh\]/);
    assert.equal(mock.calls('/v1/audio/speech').length, before);
  });

  test('pronunciation is always Tunisian and not exposed as an option', async () => {
    await tapra.call('text_to_speech', { text: 'pizza w coca' });
    assert.equal(mock.calls('/v1/audio/speech').at(-1).fields.pronunciation_style, 'tunisian');
    const { tools } = await tapra.client.listTools();
    assert.ok(!('pronunciation_style' in tools.find((t) => t.name === 'text_to_speech').inputSchema.properties));
  });

  test('all 19 formats are offered', async () => {
    const { tools } = await tapra.client.listTools();
    const formats = tools.find((t) => t.name === 'text_to_speech').inputSchema.properties.format.enum;
    assert.equal(formats.length, 19);
    assert.ok(formats.includes('mp3_44100_128') && formats.includes('ulaw_8000') && formats.includes('opus_48000_192'));
  });

  test('pcm formats work without ffmpeg and resample', async () => {
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom', format: 'pcm_16000', output_path: 'pcm.mp3' });
    assert.equal(r.isError, false, r.text);
    const file = path.join(folders.output, 'pcm.wav');
    assert.ok(fs.existsSync(file), 'extension follows the format');
    assert.equal(fs.readFileSync(file).readUInt32LE(24), 16000);
  });

  test('mp3, opus and telephony formats encode with ffmpeg', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
    for (const [format, ext, magic] of [
      ['mp3_44100_128', 'mp3', null],
      ['opus_48000_64', 'opus', 'OggS'],
      ['ulaw_8000', 'wav', 'RIFF']
    ]) {
      const r = await tapra.call('text_to_speech', { text: 'Ahla bikom', format, output_path: `fmt_${format}` });
      assert.equal(r.isError, false, r.text);
      const file = path.join(folders.output, `fmt_${format}.${ext}`);
      const head = fs.readFileSync(file).subarray(0, 4).toString('latin1');
      if (magic) assert.equal(head, magic);
      else assert.ok(head.startsWith('ID3') || fs.readFileSync(file)[0] === 0xff, 'mp3 header');
    }
    // G.711 mu-law: WAV format tag 7 at 8 kHz.
    const ulaw = fs.readFileSync(path.join(folders.output, 'fmt_ulaw_8000.wav'));
    assert.equal(ulaw.readUInt16LE(20), 7);
    assert.equal(ulaw.readUInt32LE(24), 8000);
  });

  test('voiceover track uses the chosen format and reports progress per line', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
    const events = [];
    const r = await tapra.client.callTool(
      { name: 'create_voiceover', arguments: { lines: ['Ahla.', '[hmm] Bikom.', 'Yalla.'], format: 'mp3_44100_64', output_dir: 'vo_mp3' } },
      CallToolResultSchema,
      { onprogress: (p) => events.push(p) }
    );
    assert.ok(!r.isError, r.content[0].text);
    const dir = path.join(folders.output, 'vo_mp3');
    assert.ok(fs.existsSync(path.join(dir, 'voiceover.mp3')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).audio, 'voiceover.mp3');
    // The final "Done" notification can arrive after the response, so it is not required.
    assert.ok(events.length >= 3, `got ${events.length} progress events`);
    assert.match(events[0].message, /line 1 of 3/);
    assert.ok(events.every((e) => e.total === events[0].total));
  });
});

describe('play_audio', () => {
  test('plays a generated file through the player', async () => {
    const tts = await tapra.call('text_to_speech', { text: 'Ahla', output_path: 'toplay.wav' });
    assert.equal(tts.isError, false);
    const r = await tapra.call('play_audio', { input_path: path.join(folders.output, 'toplay.wav') });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Playing toplay\.wav/);
    for (let i = 0; i < 50 && !fs.existsSync(playLog); i++) await new Promise((res) => setTimeout(res, 100));
    assert.match(fs.readFileSync(playLog, 'utf8'), /toplay\.wav/);
  });

  test('accepts tapra:// resources and input files; refuses others', async () => {
    assert.equal((await tapra.call('play_audio', { input_path: 'tapra://output/toplay.wav' })).isError, false);
    assert.equal((await tapra.call('play_audio', { input_path: 'voice.wav' })).isError, false);
    const r = await tapra.call('play_audio', { input_path: path.join(folders.root, 'played.txt') });
    assert.equal(r.isError, true);
  });

  test('stop with nothing playing is harmless', async () => {
    const r = await tapra.call('play_audio', { stop: true });
    assert.equal(r.isError, false);
  });
});

describe('find_in_transcript', () => {
  test('finds a phrase with word-level times, ignoring case and accents', async () => {
    const r = await tapra.call('find_in_transcript', { transcript_path: 'talk.json', query: 'tres bien' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /1 match for "tres bien" \(word timestamps\)/);
    assert.match(r.text, /00:00:03\.000 – 00:00:03\.700 .*\*\*Très\*\* \*\*bien\.\*\*/);
  });

  test('matches Arabic without harakat and with letter variants', async () => {
    const r = await tapra.call('find_in_transcript', { transcript_path: 'talk.json', query: 'التطبيقه' });
    assert.match(r.text, /00:00:01\.200 – 00:00:01\.900/);
  });

  test('fuzzy matching catches small typos; exact mode does not', async () => {
    assert.match((await tapra.call('find_in_transcript', { transcript_path: 'talk.json', query: 'Tapraa' })).text, /1 match/);
    assert.match((await tapra.call('find_in_transcript', { transcript_path: 'talk.json', query: 'Tapraa', fuzzy: false })).text, /was not found/);
  });

  test('SRT files give subtitle-level times', async () => {
    // Arabizi spelling variants (7 for ح) match fuzzily, not exactly.
    assert.match((await tapra.call('find_in_transcript', { transcript_path: 'talk.srt', query: 'el hamdoulah' })).text, /1 match/);
    assert.match((await tapra.call('find_in_transcript', { transcript_path: 'talk.srt', query: 'el hamdoulah', fuzzy: false })).text, /not found/);
    const ok = await tapra.call('find_in_transcript', { transcript_path: 'talk.srt', query: 'شنحوالك' });
    assert.match(ok.text, /subtitle timings/);
    assert.match(ok.text, /00:00:01\.000 – 00:00:02\.500/);
  });
});

describe('edit_audio', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  before(() => {
    // 1 s tone, 3 s silence, 1 s tone.
    ffmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', path.join(folders.input, 'gappy.wav')
    ]);
  });

  test('joins, trims and converts', async () => {
    const r = await tapra.call('edit_audio', {
      input_paths: ['voice.wav', 'gappy.wav'],
      trim_start: 0.5,
      trim_end: 6.5,
      format: 'mp3_44100_128',
      output_path: 'edited'
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Saved 6\.0\d s \(from 7\.00 s\): joined 2 files, trimmed, mono, mp3_44100_128/);
    assert.ok(fs.existsSync(path.join(folders.output, 'edited.mp3')));
  });

  test('removes long silences, normalizes loudness and fades', async () => {
    const r = await tapra.call('edit_audio', {
      input_paths: ['gappy.wav'],
      remove_silence: true,
      loudness_lufs: -16,
      fade_in_seconds: 0.2,
      fade_out_seconds: 0.3,
      output_path: 'tight.wav'
    });
    assert.equal(r.isError, false, r.text);
    const seconds = Number(/Saved ([\d.]+) s/.exec(r.text)[1]);
    assert.ok(seconds < 3, `silence should be gone, got ${seconds}s`);
    assert.match(r.text, /removed silences, normalized to -16 LUFS, faded in, faded out/);
  });

  test('never touches the originals and refuses bad trims', async () => {
    const before = fs.statSync(path.join(folders.input, 'gappy.wav')).mtimeMs;
    const r = await tapra.call('edit_audio', { input_paths: ['gappy.wav'], trim_start: 3, trim_end: 1 });
    assert.equal(r.isError, true);
    assert.equal(fs.statSync(path.join(folders.input, 'gappy.wav')).mtimeMs, before);
  });
});

describe('translate_subtitles', () => {
  test('translates in one batch and keeps timings and speakers', async () => {
    const before = mock.calls('/v1/translations').length;
    const r = await tapra.call('translate_subtitles', { input_path: 'talk.srt', target: 'French', output_path: 'talk.fr.srt' });
    assert.equal(r.isError, false, r.text);
    assert.equal(mock.calls('/v1/translations').length - before, 1, 'one request for the whole file');
    const srt = fs.readFileSync(path.join(folders.output, 'talk.fr.srt'), 'utf8');
    assert.match(srt, /^1\n00:00:01,000 --> 00:00:02,500\n\[S1\] \[French\] عسلامة شنحوالك\n/);
    assert.match(srt, /00:00:03,000 --> 00:00:05,000\n\[S2\] \[French\] labes, el 7amdoulah/);
    assert.match(srt, /3\n00:00:06,000 --> 00:00:07,000\n\[French\] yalla/);
  });

  test('falls back to line by line when the model drops the numbering', async () => {
    const r = await tapra.call('translate_subtitles', { input_path: 'talk.srt', target: 'Broken', format: 'vtt' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /redone line by line/);
    const out = /Saved to: (.+)/.exec(r.text)[1].trim();
    assert.ok(out.endsWith('talk.broken.vtt'));
    const vtt = fs.readFileSync(out, 'utf8');
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /\[S2\] \[Broken\] labes, el 7amdoulah/);
  });

  test('accepts subtitles made by transcribe_video (tapra:// resource)', async () => {
    fs.copyFileSync(path.join(folders.input, 'talk.srt'), path.join(folders.output, 'made.srt'));
    const r = await tapra.call('translate_subtitles', { input_path: 'tapra://output/made.srt', target: 'English' });
    assert.equal(r.isError, false, r.text);
  });

  test('progress is reported per batch', async () => {
    const events = [];
    await tapra.client.callTool(
      { name: 'translate_subtitles', arguments: { input_path: 'talk.srt', target: 'English' } },
      CallToolResultSchema,
      { onprogress: (p) => events.push(p) }
    );
    assert.match(events[0].message, /batch 1 of 1/);
    assert.equal(events.at(-1).progress, 1);
  });
});

describe('progress on transcription', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  test('speech_to_text reports progress', async () => {
    const events = [];
    const r = await tapra.client.callTool(
      { name: 'speech_to_text', arguments: { input_path: 'voice.wav' } },
      CallToolResultSchema,
      { onprogress: (p) => events.push(p) }
    );
    assert.ok(!r.isError);
    assert.deepEqual(events.map((e) => e.message), ['Transcribing', 'Transcribed']);
  });
});
