// A fake Tapra API + website for tests: /v1/* endpoints, /health, /api/pricing,
// /api/openapi (API discovery) and /api/v1/account. Records every request.
import http from 'node:http';

export const TEST_KEY = 'tapra_sk_live_test_0123456789abcdefghijklmnopqrstuv';

const PRICES = {
  version: 'test',
  currency: 'TND',
  tndPerUsd: 3,
  rateDate: null,
  rateSource: 'fallback',
  microTndPerTnd: 1_000_000,
  minimumChargeMicroTnd: 2950,
  welcomeCreditTnd: 2,
  topUpPackagesTnd: [10],
  ttsFlashMultiplier: 0.8,
  services: {
    offline: price('tapra-scribe-v1', 'audio_ms', 60000, 150000),
    tts: price('tapra-speak-v3', 'characters', 1000, 200000),
    mt: price('tapra-translate-v1', 'characters', 1000, 150000),
    converter: price('tapra-flip-v1', 'characters', 1000, 100000)
  }
};

function price(model, unit, unitsPerChargeUnit, microTndPerUnit) {
  const tnd = microTndPerUnit / 1e6;
  return { model, unit, unitsPerChargeUnit, tndPerUnit: tnd, usdPerUnit: tnd / 3, microTndPerUnit, minimumTnd: 0.00295, minimumUsd: 0.001 };
}

const usage = (costTnd) => ({ status: 'ok', requestId: 'req_test', costTnd, balanceTnd: 9.5 });

/** Mono 16-bit sine WAV. */
export function sineWav(seconds, rate = 24000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
  return b;
}

async function readForm(req, body) {
  const request = new Request('http://mock/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body });
  const form = await request.formData();
  const fields = {};
  let fileBytes = 0;
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') fields[k] = v;
    else fileBytes = v.size;
  }
  return { fields, fileBytes };
}

export async function startMock() {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = req.url.split('?')[0];
      const entry = { method: req.method, url, auth: req.headers.authorization ?? '', idempotencyKey: req.headers['idempotency-key'] ?? null };
      log.push(entry);
      const json = (o, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const denied = () => json({ error: { type: 'authentication_error', message: 'Missing, invalid, or revoked API key.' } }, 401);
      const authed = req.headers.authorization === `Bearer ${TEST_KEY}`;
      try {
        if (url === '/health') return json({ ok: true, model: 'tapra-scribe-v1' });
        if (url === '/api/pricing') return json(PRICES);
        if (url === '/api/openapi') return json({ openapi: '3.1.0', servers: [{ url: `http://127.0.0.1:${server.address().port}` }] });
        if (url === '/v1/models') return json({ object: 'list', data: [{ id: 'tapra-scribe-v1' }, { id: 'tapra-speak-v3' }] });
        if (url === '/api/v1/account') {
          if (!authed) return denied();
          return json({
            object: 'account',
            balanceTnd: 9.5,
            totalSpentTnd: 0.5,
            key: { name: 'Test key', prefix: 'tapra_sk_live_test…', scopes: ['all'] },
            recentUsage: [{ service: 'tts', endpoint: '/v1/audio/speech', quantity: 120, unit: 'characters', costTnd: 0.024, createdAt: '2026-10-27T10:00:00.000Z' }]
          });
        }
        if (!authed) return denied();

        if (url === '/v1/audio/transcriptions') {
          const { fields, fileBytes } = await readForm(req, body);
          entry.fields = fields;
          const dur = Math.max(1, (fileBytes - 44) / 32000);
          const segments = [];
          const words = [];
          for (let t = 0, k = 0; t + 3 <= dur; t += 3, k++) {
            const ws = k % 2 ? ['عسلامة', 'شنحوالك', 'ça', 'va'] : ['3aslema', 'chna7welek', 'ça', 'va'];
            segments.push({ id: k, start: t, end: t + 2.8, text: ws.join(' ') });
            ws.forEach((w, j) => words.push({ text: w, t0_ms: Math.round((t + j * 0.7) * 1000), t1_ms: Math.round((t + j * 0.7 + 0.6) * 1000) }));
          }
          const diarization =
            fields.diarize === 'true'
              ? { duration: dur, processing_ms: 1, speakers: [{ id: 'S1' }, { id: 'S2' }], turns: segments.map((s, k) => ({ speaker: k % 2 ? 'S2' : 'S1', start_ms: s.start * 1000, end_ms: s.end * 1000 })) }
              : null;
          return json({
            text: segments.map((s) => s.text).join(' '),
            language: 'aeb',
            duration: dur,
            processing_ms: 5,
            model: 'tapra-scribe-v1',
            segments,
            words: fields.timestamps === 'word' ? words : null,
            diarization,
            usage: usage(+((dur / 60) * 0.15).toFixed(4))
          });
        }
        if (url === '/v1/audio/diarization') {
          return json({ duration: 6, processing_ms: 1, speakers: [{ id: 'S1' }], turns: [{ speaker: 'S1', start_ms: 0, end_ms: 6000 }], usage: usage(0.015) });
        }
        if (url === '/v1/audio/speech') {
          const { fields } = await readForm(req, body);
          entry.fields = fields;
          const d = Number(fields.duration) || Math.max(0.5, (fields.input ?? '').length / 15);
          return json({
            audio: sineWav(d).toString('base64'),
            audio_format: 'wav',
            sample_rate: 24000,
            duration: d,
            text: fields.input,
            converted: false,
            processing_ms: 5,
            model: fields.model,
            usage: usage(0.01)
          });
        }
        if (url === '/v1/translations/languages') {
          return json({ object: 'list', data: [{ label: 'Derja', language: 'Tunisian Arabic', code: 'aeb', rtl: true }, { label: 'French', language: 'French', code: 'fr', rtl: false }] });
        }
        if (url === '/v1/translations') {
          const b = JSON.parse(body.toString());
          entry.json = b;
          // Numbered subtitle batches: translate line by line, keeping the ⟦n⟧ markers,
          // except for target "Broken", which drops them (to exercise the fallback).
          if (b.input.includes('⟦')) {
            const lines = b.input.split('\n').map((l) => l.replace(/^(⟦\d+⟧)\s*(.*)$/, (_, m, t) => `${m} [${b.target}] ${t}`));
            const translation = b.target === 'Broken' ? lines.join(' ').replace(/⟦\d+⟧/g, '') : lines.join('\n');
            return json({ translation, target: b.target, processing_ms: 3, model: 'tapra-translate-v1', usage: usage(0.003) });
          }
          return json({ translation: `[${b.target}] ${b.input}`, target: b.target, target_language: b.target, source_language: 'Derja', processing_ms: 3, model: 'tapra-translate-v1', usage: usage(0.003) });
        }
        if (url === '/v1/converters/transliterate') {
          const b = JSON.parse(body.toString());
          entry.json = b;
          return json({ input: b.text, output: b.direction === 'ZI2AR' ? 'عسلامة' : '3aslema', direction: b.direction, model: 'tapra-flip-v1', processing_ms: 2, usage: usage(0.003) });
        }
        json({ error: { type: 'not_found', message: url } }, 404);
      } catch (err) {
        json({ error: { type: 'mock_error', message: String(err) } }, 500);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    log,
    /** Requests to one path, newest last. */
    calls: (path) => log.filter((e) => e.url === path),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
