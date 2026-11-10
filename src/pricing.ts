import type { TapraPrices } from '@tapra/sdk';

/** Meter v2 counts NFC-normalised, trimmed code points, including effect/emotion tags. */
export function billableCharacters(text: string): number {
  return [...text.normalize('NFC').trim()].length;
}

/** Exact total for the individual speech requests, including each request's minimum. */
export function speechCostMicroTnd(prices: TapraPrices, texts: readonly string[], flash = false): number {
  const speak = prices.services.tts;
  if (!speak) throw new Error('The price list has no tts service.');
  // The explicit Flash field postdates the published SDK's types.
  const list = prices as TapraPrices & { ttsFlashMicroTndPerUnit?: number };
  const rate = flash
    ? list.ttsFlashMicroTndPerUnit ?? Math.round(speak.microTndPerUnit * prices.ttsFlashMultiplier)
    : speak.microTndPerUnit;
  return texts.reduce((total, text) => {
    const characters = billableCharacters(text);
    if (characters === 0) return total;
    return total + Math.max(
      prices.minimumChargeMicroTnd,
      Math.ceil((characters * rate) / speak.unitsPerChargeUnit)
    );
  }, 0);
}
