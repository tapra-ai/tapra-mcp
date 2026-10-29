/**
 * The Tapra voices offered through the MCP server. They are tapra-speak-v1 speakers
 * (the same ones as Voice Studio, see src/features/voice-studio/voices.ts); `instruct`
 * is the style hint Voice Studio sends with each one.
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
    id: 'amal',
    name: 'Amal',
    gender: 'female',
    description: 'Mature woman. Warm, grounded, everyday Tunisian.',
    instruct: ''
  },
  {
    id: 'salma',
    name: 'Salma',
    gender: 'female',
    description: 'Younger woman. Lighter and brighter, conversational.',
    instruct: 'Female, Young Adult, Moderate Pitch'
  },
  {
    id: 'salah',
    name: 'Salah',
    gender: 'male',
    description: 'Man with a big, sharp (aigu) voice that carries. Strong presence.',
    instruct: 'Male, Elderly, Very Low Pitch'
  },
  {
    id: 'fahmi',
    name: 'Fahmi',
    gender: 'male',
    description: 'Middle-aged man. Normal, natural male voice.',
    instruct: 'Male, Young Adult, Low Pitch'
  },
  {
    id: 'leo',
    name: 'Leo',
    gender: 'male',
    description: 'Young man. Light and energetic. The default Tapra voice.',
    instruct: ''
  }
];

export const DEFAULT_VOICE_ID = 'leo';

export const VOICE_IDS = VOICES.map((v) => v.id) as [string, ...string[]];

export const CLONING_UNAVAILABLE =
  'Voice cloning is not currently available in Tapra. Choose one of the Tapra voices instead: ' +
  VOICES.map((v) => `${v.name} (${v.description.split('.')[0]!.toLowerCase()})`).join(', ') +
  '.';

export function voiceById(id: string): TapraVoice {
  const voice = VOICES.find((v) => v.id === id.trim().toLowerCase());
  if (!voice) throw new Error(`Unknown voice "${id}". Available: ${VOICE_IDS.join(', ')}.`);
  return voice;
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
 * The server swaps each tag for the sound; tags are not billed.
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

/** Tags in `text` that Tapra-Speak does not know. */
export function unknownEffectTags(text: string): string[] {
  const known = new Set(EFFECTS.map((e) => e.tag));
  return [...new Set((text.match(TAG_PATTERN) ?? []).map((t) => t.slice(1, -1)))].filter((t) => !known.has(t));
}

export function effectsMenu(): string {
  return EFFECTS.map((e) => `[${e.tag}] ${e.sound}`).join('; ');
}
