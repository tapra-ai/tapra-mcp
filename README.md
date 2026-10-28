# Tapra MCP server

[![npm](https://img.shields.io/npm/v/@tapra/mcp)](https://www.npmjs.com/package/@tapra/mcp)
[![CI](https://github.com/tapra-ai/tapra-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tapra-ai/tapra-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Setup guide for every app: **[tapra.tn/mcp](https://tapra.tn/mcp)** · API reference: [tapra.tn/docs](https://tapra.tn/docs)

Use Tapra from Claude Desktop, Claude Code, Cursor, or any MCP client: transcribe Tunisian
Derja mixed with French and English, subtitle videos, generate speech and voiceovers,
translate, and convert between Arabizi and Arabic script.

The server runs locally over stdio. It reads your media files, calls the Tapra API with your
key, and writes results to your output folder. Calls are billed like the API, and every paid
tool reports its cost and your remaining balance.

## Setup

1. Create an API key at https://tapra.tn/dashboard.
2. Install [ffmpeg](https://ffmpeg.org/download.html) (needed for video, long-file chunking and
   cost estimates on audio): `winget install Gyan.FFmpeg`, `brew install ffmpeg`, or `apt install ffmpeg`.
3. Add the server to your client.

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tapra": {
      "command": "npx",
      "args": ["-y", "@tapra/mcp"],
      "env": {
        "TAPRA_API_KEY": "tapra_sk_live_…",
        "TAPRA_OUTPUT_DIR": "~/Tapra"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add tapra -e TAPRA_API_KEY=tapra_sk_live_… -- npx -y @tapra/mcp
```

## Tools

| Tool | What it does | Billed |
|---|---|---|
| `tapra_status` | API health, models, prices, balance, output folder, ffmpeg check | free |
| `get_balance` | Balance, total spent, and the 10 latest charges for your key | free |
| `list_voices` | The Tapra voices and what each sounds like | free |
| `speech_to_text` | Transcribe audio or video: one folder with txt, srt and vtt (+ json), speakers detected and colored, a clip of each voice and a `speakers.html` report | per minute |
| `transcribe_video` | Subtitles for a video (srt + vtt + txt in one call), readable cue lengths, speaker colors, optional burned-in MP4 | per minute |
| `name_speakers` | Name the detected speakers (and pick colors); rewrites txt/srt/vtt, merges labels given the same name, can burn the result | free |
| `diarize_audio` | Who spoke when, without a transcript | per minute |
| `text_to_speech` | Speak Derja / Arabizi / French / English with a Tapra voice, effect tags, 19 formats | per character |
| `create_voiceover` | Narration from a script, or dubbing from an SRT, on one timeline; writes the track, per-line clips and `manifest.json`; can lay it onto a video | per character |
| `translate` | Derja ↔ English / French / MSA | per character |
| `translate_subtitles` | Translate an SRT/VTT, keeping every timing and speaker label (batched) | per character |
| `play_audio` | Play a file on this computer's speakers (or stop playback) | free |
| `find_in_transcript` | When is a word or phrase said? Word-level times from a JSON transcript | free |
| `edit_audio` | Join, trim, remove silences, normalize loudness, fade, convert | free |
| `list_translation_languages` | Accepted language names | free |
| `convert_script` | Arabizi ↔ Arabic script | per character |

Example prompts:

- "Subtitle ~/Videos/interview.mp4 with speaker labels and burn them in."
- "Write a 30-second Derja ad for a coffee shop, then make a voiceover with a warm female voice."
- "Narrate this script with Salma, then lay it onto ~/Videos/promo.mp4."
- "Subtitle interview.mp4, translate the subtitles to French, and dub it with Fahmi."
- "Where does she say 'el budget' in interview.json? Cut 5 seconds around it and normalize to -14 LUFS."

### Voices

| Voice | Sounds like |
|---|---|
| `amal` | Mature woman. Warm, grounded, everyday Tunisian. |
| `salma` | Younger woman. Lighter and brighter, conversational. |
| `salah` | Man with a big, sharp (aigu) voice that carries. |
| `fahmi` | Middle-aged man. Normal, natural male voice. |
| `leo` | Young man. Light and energetic. The default. |

Speech is always pronounced the Tunisian way (loanwords and Arabizi). Effect tags go inline
and are not billed: `[euh]` hesitation, `[aaa]` long filler, `[hmm]`, `[ahem]` throat clear,
`[ouf]` sigh, `[breath]` out-breath, `[stutter]` (right before the word to stutter), e.g.
`"[euh] ma na3rafch, [breath] khalli nchouf"`. Unknown tags are refused before any charge.

`quality: "flash"` uses the same voices about 5x faster and cheaper. Voice cloning is not
currently available; the server tells the model so, and it should offer these voices instead.

### Audio formats

`format` on `text_to_speech`, `create_voiceover` and `edit_audio`: `wav` (default, lossless) or one of
the 18 ElevenLabs-style formats: `mp3_22050_32`, `mp3_44100_32/64/96/128/192`,
`pcm_8000/16000/22050/24000/44100` (16-bit WAV at that rate), `ulaw_8000` / `alaw_8000`
(G.711 telephony, in WAV), `opus_48000_32/64/96/128/192` (Ogg Opus). pcm needs nothing extra;
mp3, opus, ulaw and alaw need ffmpeg.

### Progress

`speech_to_text`, `transcribe_video`, `create_voiceover`, `translate_subtitles` and `edit_audio`
send MCP progress notifications (per chunk, line or batch) when the client asks for them, so long
jobs show progress and do not time out.

### Voiceover manifest

`create_voiceover` writes a folder you can hand to a video tool:

```text
voiceover_20261027-142233-a1b2/
  voiceover.wav      full narration
  manifest.json      { duration, segments: [{ index, text, start, end, clip }] }
  clips/001.wav …    one clip per line
```

With `srt_path`, `timing: "fit"` asks the model to make each line last as long as its subtitle,
which is what dubbing needs. `timing: "natural"` keeps natural pacing and warns when a line
spills into the next one.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TAPRA_API_KEY` | required | Your `tapra_sk_live_…` key |
| `TAPRA_API_URL` | read from tapra.tn | Force an API origin (e.g. `http://127.0.0.1:8787` for a local model host) |
| `TAPRA_SITE_URL` | `https://www.tapra.tn` | Website serving the price list, balance, and the current API address |
| `TAPRA_OUTPUT_DIR` | `~/Tapra` | Where generated files go; outputs can't be written anywhere else |
| `TAPRA_BASE_PATH` | home folder | Input files must be inside this folder; relative paths resolve here |
| `TAPRA_MCP_OUTPUT_MODE` | `files` | `files` saves results; `resources` returns them inline only (nothing saved); `both` does both |
| `TAPRA_MCP_MAX_INLINE_MB` | `15` | Largest file returned inline in `resources` / `both` mode |
| `TAPRA_MAX_COST_TND` | none | Refuse any single call estimated above this amount |
| `TAPRA_FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg if it is not on `PATH` |
| `TAPRA_TIMEOUT_SECONDS` | `600` | Per-request timeout |
| `TAPRA_AUDIO_PLAYER` | ffplay, then the system player | Program `play_audio` runs as `<player> <file>` |

Without `TAPRA_API_URL`, the server asks `TAPRA_SITE_URL/api/openapi` for the current API
address, so moving the model host needs no client change.

File safety: inputs outside `TAPRA_BASE_PATH` (including through symlinks) and outputs
outside `TAPRA_OUTPUT_DIR` are refused (tools that work on results, like `play_audio` and
`edit_audio`, also accept files in the output folder or `tapra://output/...` URIs), and an existing file is never replaced (`take.wav`
becomes `take-1.wav`). A missing input gets "did you mean" suggestions from the same folder.
Every file a tool makes can be re-read as an MCP resource, `tapra://output/<path>`.

Every paid call sends a fresh `Idempotency-Key`, so automatic retries are never charged twice.
Files longer than 15 minutes are split into chunks; with speaker labels on, labels restart in
each chunk (prefixed `c1-`, `c2-`, …).

## Development

```bash
npm install
npm test        # builds, then runs the unit, path-safety and end-to-end tests against a mock API
npx @modelcontextprotocol/inspector node dist/index.js
```

Tests need Node.js 22+ and ffmpeg (video and long-file tests are skipped without it). They
never call the real Tapra API.

Issues and pull requests are welcome. For questions about your account or billing, write to
[contact@tapra.tn](mailto:contact@tapra.tn).

## License

MIT. The server is open source; the Tapra models it calls are a paid API.
