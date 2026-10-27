// End to end: the built server over stdio, against the mock API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ffmpeg, hasFfmpeg, makeFolders, startServer } from './helpers/harness.mjs';
import { sineWav, startMock } from './helpers/mock-api.mjs';

let mock;
let folders;
let tapra;

before(async () => {
  mock = await startMock();
  folders = makeFolders();
  fs.writeFileSync(path.join(folders.input, 'clip.wav'), sineWav(7, 16000));
  fs.writeFileSync(
    path.join(folders.input, 'dub.srt'),
    '1\n00:00:00,500 --> 00:00:02,000\nعسلامة\n\n2\n00:00:03,000 --> 00:00:04,500\n[S2] ça va\n'
  );
  tapra = await startServer(mock, folders);
});

after(async () => {
  await tapra?.close();
  await mock?.close();
  folders?.cleanup();
});

const outFiles = () => fs.readdirSync(folders.output);

describe('discovery and free tools', () => {
  test('lists every tool with honest cost hints', async () => {
    const { tools } = await tapra.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['tapra_status', 'list_voices', 'get_balance', 'speech_to_text', 'transcribe_video', 'diarize_audio', 'text_to_speech', 'create_voiceover', 'translate', 'list_translation_languages', 'convert_script']) {
      assert.ok(byName[name], `missing tool ${name}`);
    }
    for (const paid of ['speech_to_text', 'text_to_speech', 'create_voiceover', 'translate', 'convert_script']) {
      assert.equal(byName[paid].annotations.readOnlyHint, false, `${paid} must not claim to be read-only`);
    }
    for (const free of ['tapra_status', 'list_voices', 'get_balance']) assert.equal(byName[free].annotations.readOnlyHint, true);
    const tts = byName.text_to_speech;
    assert.deepEqual(tts.inputSchema.properties.voice.enum, ['amal', 'salma', 'salah', 'fahmi', 'leo']);
    assert.ok(!('voice_reference_path' in tts.inputSchema.properties), 'cloning input must be gone');
    assert.match(tts.description, /cloning .* not currently available/i);
  });

  test('server instructions tell the model cloning is unavailable', () => {
    assert.match(tapra.client.getInstructions(), /Voice cloning is not currently available/);
  });

  test('tapra_status finds the API address from the website', async () => {
    const r = await tapra.call('tapra_status');
    assert.equal(r.isError, false);
    assert.match(r.text, new RegExp(`API: ${mock.url.replace(/[.]/g, '\\.')} \\(from website\\)`));
    assert.match(r.text, /Balance: 9\.500 TND/);
    assert.match(r.text, /Models: tapra-voice-v1, tapra-speak-v3/);
    assert.match(r.text, /Voices: amal, salma, salah, fahmi, leo \(cloning not available\)/);
  });

  test('list_voices describes each voice and refuses cloning', async () => {
    const r = await tapra.call('list_voices');
    assert.match(r.text, /Amal .*Mature woman/);
    assert.match(r.text, /Salma .*Younger woman/);
    assert.match(r.text, /Salah .*big/);
    assert.match(r.text, /Fahmi .*Middle-aged man/);
    assert.match(r.text, /Leo .*default.*Young man/);
    assert.match(r.text, /Voice cloning is not currently available/);
  });

  test('get_balance reads the account with the API key', async () => {
    const r = await tapra.call('get_balance');
    assert.match(r.text, /Balance: 9\.500 TND/);
    assert.match(r.text, /Test key/);
    assert.match(r.text, /tts .*120 chars/);
    assert.equal(mock.calls('/api/v1/account').at(-1).auth, 'Bearer tapra_sk_live_test_0123456789abcdefghijklmnopqrstuv');
  });
});

describe('speech', () => {
  test('text_to_speech sends the named voice, v3 model and its style hint', async () => {
    const r = await tapra.call('text_to_speech', { text: '3aslema, chna7welek?', voice: 'salma', output_path: 'hello.wav' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Voice: Salma \(full quality\)/);
    const sent = mock.calls('/v1/audio/speech').at(-1);
    assert.equal(sent.fields.voice, 'salma');
    assert.equal(sent.fields.model, 'tapra-speak-v3');
    assert.equal(sent.fields.instruct, 'Female, Young Adult, Moderate Pitch');
    assert.equal(sent.fields.convert_arabizi, 'true');
    assert.ok(sent.idempotencyKey, 'paid calls carry an Idempotency-Key');
    assert.ok(!('ref_audio' in sent.fields) && !('clone_voice' in sent.fields));
    assert.equal(fs.readFileSync(path.join(folders.output, 'hello.wav')).toString('ascii', 0, 4), 'RIFF');
  });

  test('defaults to Leo; flash quality uses the flash model', async () => {
    await tapra.call('text_to_speech', { text: 'Ahla' });
    assert.equal(mock.calls('/v1/audio/speech').at(-1).fields.voice, 'leo');
    await tapra.call('text_to_speech', { text: 'Ahla', voice: 'fahmi', quality: 'flash' });
    assert.equal(mock.calls('/v1/audio/speech').at(-1).fields.model, 'tapra-speak-flash');
  });

  test('unknown voices are rejected before any charge', async () => {
    const before = mock.calls('/v1/audio/speech').length;
    const r = await tapra.call('text_to_speech', { text: 'Ahla', voice: 'khadija' });
    assert.equal(r.isError, true);
    assert.equal(mock.calls('/v1/audio/speech').length, before);
  });

  test('never overwrites an existing output', async () => {
    await tapra.call('text_to_speech', { text: 'Ahla', output_path: 'hello.wav' });
    assert.ok(outFiles().includes('hello.wav') && outFiles().includes('hello-1.wav'));
  });

  test('budget limit stops a call before it is sent', async () => {
    const before = mock.calls('/v1/audio/speech').length;
    const r = await tapra.call('text_to_speech', { text: 'Ahla bikom', max_cost_tnd: 0.0001 });
    assert.equal(r.isError, true);
    assert.match(r.text, /above the .* limit/);
    assert.equal(mock.calls('/v1/audio/speech').length, before);
  });

  test('create_voiceover from lines writes audio, clips and a manifest', async () => {
    const r = await tapra.call('create_voiceover', { lines: ['Ahla bikom.', 'Lyoum bech nwarriwkom.'], voice: 'amal', output_dir: 'vo' });
    assert.equal(r.isError, false, r.text);
    const dir = path.join(folders.output, 'vo');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.segments.length, 2);
    assert.equal(manifest.voice.id, 'amal');
    assert.ok(manifest.segments[1].start > manifest.segments[0].end, 'lines are sequential with a gap');
    assert.ok(fs.existsSync(path.join(dir, 'clips', '002.wav')));
    assert.ok(fs.existsSync(path.join(dir, 'voiceover.wav')));
  });

  test('create_voiceover from SRT fits each line to its slot', async () => {
    const r = await tapra.call('create_voiceover', { srt_path: 'dub.srt', voice: 'salah' });
    assert.equal(r.isError, false, r.text);
    const sent = mock.calls('/v1/audio/speech').slice(-2);
    assert.deepEqual(sent.map((s) => s.fields.duration), ['1.5', '1.5']);
    assert.equal(sent[1].fields.input, 'ça va', 'speaker tags are not spoken');
  });

  test('create_voiceover needs exactly one source', async () => {
    const r = await tapra.call('create_voiceover', { lines: ['a'], script: 'b' });
    assert.equal(r.isError, true);
    assert.match(r.text, /exactly one of script, lines, or srt_path/);
  });
});

describe('transcription and text', () => {
  test('speech_to_text saves an SRT with word-timed cues', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
    const r = await tapra.call('speech_to_text', { input_path: 'clip.wav', format: 'srt', diarize: true, output_path: 'clip.srt' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Transcribed 7\.0 s/);
    const srt = fs.readFileSync(path.join(folders.output, 'clip.srt'), 'utf8');
    assert.match(srt, /^1\n00:00:00,000 --> /);
    assert.match(srt, /\[S1\] 3aslema/);
    const sent = mock.calls('/v1/audio/transcriptions').at(-1);
    assert.equal(sent.fields.timestamps, 'word');
    assert.equal(sent.fields.diarize, 'true');
  });

  test('inputs outside the base folder are refused', async () => {
    const outside = path.join(folders.root, 'outside.wav');
    fs.writeFileSync(outside, sineWav(1, 16000));
    const r = await tapra.call('speech_to_text', { input_path: outside });
    assert.equal(r.isError, true);
    assert.match(r.text, /outside the allowed folder/);
  });

  test('a mistyped file name gets suggestions', async () => {
    const r = await tapra.call('speech_to_text', { input_path: 'clpi.wav' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Did you mean: .*clip\.wav/);
  });

  test('translate and convert_script return text and cost', async () => {
    const t = await tapra.call('translate', { text: 'chna7welek', target: 'French' });
    assert.match(t.text, /\[French\] chna7welek/);
    assert.match(t.text, /Cost: 0\.003 TND, balance left 9\.500 TND/);
    const c = await tapra.call('convert_script', { text: '3aslema', direction: 'arabizi_to_arabic' });
    assert.match(c.text, /^عسلامة/);
    assert.equal(mock.calls('/v1/converters/transliterate').at(-1).json.direction, 'ZI2AR');
  });

  test('a bad key gives a clear error', async () => {
    const bad = await startServer(mock, folders, { TAPRA_API_KEY: 'tapra_sk_live_wrong_0000000000000000000000000000' });
    try {
      const r = await bad.call('convert_script', { text: 'x', direction: 'arabic_to_arabizi' });
      assert.equal(r.isError, true);
      assert.match(r.text, /401: Missing, invalid, or revoked API key\. Check TAPRA_API_KEY\./);
    } finally {
      await bad.close();
    }
  });
});

describe('video', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  before(() => {
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100',
      '-t', '7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(folders.input, 'clip.mp4')
    ]);
  });

  test('transcribe_video writes subtitles and a burned-in copy', async () => {
    const r = await tapra.call('transcribe_video', { input_path: 'clip.mp4', burn_subtitles: true, output_path: 'clip_subs.srt', video_output_path: 'clip_subbed.mp4' });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.statSync(path.join(folders.output, 'clip_subbed.mp4')).size > 1000);
    assert.match(fs.readFileSync(path.join(folders.output, 'clip_subs.srt'), 'utf8'), /عسلامة/);
  });

  test('create_voiceover lays the narration onto the video', async () => {
    const r = await tapra.call('create_voiceover', { srt_path: 'dub.srt', video_path: 'clip.mp4', original_audio_volume: 0.2, output_dir: 'dubbed' });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.existsSync(path.join(folders.output, 'dubbed', 'clip_voiceover.mp4')));
  });

  test('long audio is transcribed in chunks with continuous timestamps', async () => {
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=16000', '-t', '960', '-c:a', 'libmp3lame', '-b:a', '16k', path.join(folders.input, 'long.mp3')]);
    const r = await tapra.call('speech_to_text', { input_path: 'long.mp3', format: 'json', output_path: 'long.json' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /in 2 chunks/);
    const json = JSON.parse(fs.readFileSync(path.join(folders.output, 'long.json'), 'utf8'));
    assert.ok(json.segments.at(-1).start > 900, 'second chunk is offset');
    const starts = json.segments.map((s) => s.start);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });
});
