/**
 * Built-in copy of the Tapra voices (tapra-speak-v1 speakers, the same ones as Voice Studio).
 * The live list from GET /v1/voices wins (see parseVoiceList), so a voice added on the server
 * works without a new MCP release; this copy covers startup text and an unreachable API.
 * `instruct` is the style hint Voice Studio sends with each one.
 */
export interface TapraVoice {
  id: string;
  name: string;
  gender: 'female' | 'male';
  description: string;
  instruct: string;
}

export const VOICES: readonly TapraVoice[] = [
  {
    id: 'youssef',
    name: 'Youssef',
    gender: 'male',
    description: 'Man. The default Tapra voice.',
    instruct: 'Male, Young Adult, Moderate Pitch'
  },
  {
    id: 'zeineb',
    name: 'Zeineb',
    gender: 'female',
    description: 'Woman. A warm storyteller, made for narration.',
    instruct: ''
  },
  {
    id: 'karim',
    name: 'Karim',
    gender: 'male',
    description: 'Man. Calm.',
    instruct: 'Male, Elderly, Very Low Pitch'
  },
  {
    id: 'sarra',
    name: 'Sarra',
    gender: 'female',
    description: 'Woman. Clear.',
    instruct: 'Female, Young Adult, Moderate Pitch'
  },
  {
    id: 'anis',
    name: 'Anis',
    gender: 'male',
    description: 'Man. Clear.',
    instruct: 'Male, Young Adult, Low Pitch'
  },
  {
    id: 'rim',
    name: 'Rim',
    gender: 'female',
    description: 'Woman.',
    instruct: 'Female, Young Adult, High Pitch'
  },
  {
    id: 'hamza',
    name: 'Hamza',
    gender: 'male',
    description: 'Man.',
    instruct: ''
  },
  {
    id: 'mariem',
    name: 'Mariem',
    gender: 'female',
    description: 'Woman.',
    instruct: 'Female, Middle-aged, Low Pitch'
  },
  {
    id: 'mehdi',
    name: 'Mehdi',
    gender: 'male',
    description: 'Man.',
    instruct: ''
  },
  {
    id: 'ines',
    name: 'Ines',
    gender: 'female',
    description: 'Woman.',
    instruct: ''
  },
  {
    id: 'walid',
    name: 'Walid',
    gender: 'male',
    description: 'Man.',
    instruct: ''
  }
];

export const DEFAULT_VOICE_ID = 'youssef';

export const VOICE_IDS = VOICES.map((v) => v.id) as [string, ...string[]];

export const CLONING_UNAVAILABLE = cloningUnavailable(VOICES);

export function voiceById(id: string, voices: readonly TapraVoice[] = VOICES): TapraVoice {
  const voice = voices.find((v) => v.id === id.trim().toLowerCase());
  if (!voice) throw new Error(`Unknown voice "${id}". Available: ${voices.map((v) => v.id).join(', ')}.`);
  return voice;
}

/** A built-in voice by id, or undefined (no network). */
export function builtinVoice(id: string): TapraVoice | undefined {
  return VOICES.find((v) => v.id === id.trim().toLowerCase());
}

/** Display name for a voice id: the built-in name, else the id capitalised. */
export function voiceName(id: string): string {
  const clean = id.trim().toLowerCase();
  return builtinVoice(clean)?.name ?? clean.charAt(0).toUpperCase() + clean.slice(1);
}

export interface VoiceList {
  voices: TapraVoice[];
  defaultId: string;
}

/**
 * GET /v1/voices body `{default, data: [{name, gender, description}]}` -> voices, keeping the
 * built-in style hint for voices it already knows. Undefined when the body has no usable voice.
 */
export function parseVoiceList(body: unknown): VoiceList | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const voices: TapraVoice[] = [];
  for (const item of data) {
    const id = String((item as { name?: unknown } | null)?.name ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || voices.some((v) => v.id === id)) continue;
    const known = builtinVoice(id);
    const gender = String((item as { gender?: unknown }).gender ?? '').toLowerCase();
    const description = String((item as { description?: unknown }).description ?? '').trim();
    voices.push({
      id,
      name: voiceName(id),
      gender: gender === 'female' || gender === 'male' ? gender : (known?.gender ?? 'male'),
      description: description || known?.description || '',
      instruct: known?.instruct ?? ''
    });
  }
  if (!voices.length) return undefined;
  const wanted = String((body as { default?: unknown }).default ?? '').trim().toLowerCase();
  return { voices, defaultId: voices.some((v) => v.id === wanted) ? wanted : voices[0]!.id };
}

/** The cloning answer for a given voice list. */
export function cloningUnavailable(voices: readonly TapraVoice[]): string {
  return (
    'Voice cloning is not currently available in Tapra. Choose one of the Tapra voices instead: ' +
    voices.map((v) => `${v.name} (${(v.description.split('.')[0] || (v.gender === 'female' ? 'Woman' : 'Man')).toLowerCase()})`).join(', ') +
    '.'
  );
}

/** One line per voice, for tool descriptions. */
export function voiceMenu(): string {
  return VOICES.map((v) => `${v.id} = ${v.description}`).join('; ');
}

/** Speech models: full quality, or Flash (same voices, about 5x faster, cheaper). */
export const SPEECH_MODELS = { full: 'tapra-speak-v1', flash: 'tapra-speak-flash-v1' } as const;

/**
 * Non-verbal effect tags Tapra-Speak understands (same list as Voice Studio,
 * src/features/voice-studio/effects.ts). Write them inline, e.g. "[euh] ma na3rafch".
 * The server swaps each tag for the sound; tags are billed as characters like any text.
 */
export const EFFECTS: readonly { tag: string; sound: string }[] = [
  { tag: 'euh', sound: 'breathy hesitation' },
  { tag: 'aaa', sound: 'long filler while thinking' },
  { tag: 'hmm', sound: 'closed-mouth "mmm"' },
  { tag: 'ahem', sound: 'clears the throat' },
  { tag: 'ouf', sound: 'tired sigh' },
  { tag: 'breath', sound: 'out-breath, "haah"' },
  { tag: 'stutter', sound: 'repeats the first sound of the next word; put it right before that word' }
];

const TAG_PATTERN = /\[[a-z]+(?:-[a-z]+)*\]/g;

/** Text as billed: tags removed (matches the server). */
export function stripEffectTags(text: string): string {
  return text.replace(TAG_PATTERN, ' ').split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Emotions Tapra-Speak can put on the delivery (the API's `emotion` field). Inside the text, `[whisper]` (or any
 * emotion) changes the delivery from that point and `[normal]` goes back to the plain voice.
 */
export const EMOTIONS: readonly { id: string; feel: string }[] = [
  { id: 'happy', feel: 'cheerful, excited' },
  { id: 'sad', feel: 'low, heavy' },
  { id: 'angry', feel: 'sharp, loud' },
  { id: 'surprised', feel: 'caught off guard' },
  { id: 'fearful', feel: 'scared, tense' },
  { id: 'disgusted', feel: 'put off, repelled' },
  { id: 'whisper', feel: 'quiet, secret' }
];
export const EMOTION_IDS = EMOTIONS.map((e) => e.id) as [string, ...string[]];
const EMOTION_TAGS = new Set([...EMOTION_IDS, 'normal', 'neutral']);

export function emotionsMenu(): string {
  return EMOTIONS.map((e) => `${e.id} (${e.feel})`).join(', ');
}

/** Tags in `text` that Tapra-Speak does not know (effect and emotion tags are known). */
export function unknownEffectTags(text: string): string[] {
  const known = new Set([...EFFECTS.map((e) => e.tag), ...EMOTION_TAGS]);
  return [...new Set((text.match(TAG_PATTERN) ?? []).map((t) => t.slice(1, -1)))].filter((t) => !known.has(t));
}

export function effectsMenu(): string {
  return EFFECTS.map((e) => `[${e.tag}] ${e.sound}`).join('; ');
}
