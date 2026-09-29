// Seedable PRNG and weighted sampling without replacement. Pure: no Firestore, no fetch.
//
// Stored seeds (Daily, lobby results) replay through these exact algorithms, so changing the hash,
// the generator or the draw order changes the result of every stored seed. The golden vectors in
// tests/qit-roulette-core.test.ts pin them.

/** Uniform draws in [0, 1). */
export type Rng = () => number;

// cyrb128 (bryc): a string to four 32-bit words for the generator state.
function hashSeed(seed: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32 seeded from a string: the same seed always yields the same sequence. */
export function createRng(seed: string): Rng {
  let [a, b, c, d] = hashSeed(seed);
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Mix the hashed state before the first draw.
  for (let i = 0; i < 15; i++) next();
  return next;
}

/** A fresh 128-bit seed (hex) for spins that are not deterministic; store it to replay the draw. */
export function randomSeed(): string {
  const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
  return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
}

/** Joins seed parts unambiguously, e.g. `composeSeed('daily', steamId, localDate, modeId, rerollIndex)`. */
export function composeSeed(...parts: (string | number)[]): string {
  return JSON.stringify(parts);
}

export interface Weighted<T> {
  item: T;
  /** Finite and greater than zero; leave ineligible items out instead of weighting them 0. */
  weight: number;
}

export interface SampleOptions {
  rng: Rng;
  /** Draw probability is proportional to weight ^ gamma; 0 makes every item equally likely. */
  gamma: number;
}

/**
 * Draws up to `count` distinct items. Each draw picks among the items not yet drawn with
 * probability proportional to weight ^ gamma (Efraimidis-Spirakis exponential keys), so the
 * first result follows the weights exactly and later results never repeat an earlier one.
 *
 * Every item consumes exactly one rng draw, in input order, so the same entries in the same order
 * with the same seed give the same result, and a smaller `count` gives a prefix of a larger one.
 */
export function weightedSample<T>(entries: readonly Weighted<T>[], count: number, options: SampleOptions): T[] {
  const { rng, gamma } = options;
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`Sample count must be a non-negative integer, got ${count}`);
  if (!Number.isFinite(gamma) || gamma < 0) throw new RangeError(`Sampler gamma must be finite and at least 0, got ${gamma}`);

  const keyed = entries.map(({ item, weight }, index) => {
    if (!Number.isFinite(weight) || weight <= 0) throw new RangeError(`Sampler weights must be finite and above 0, got ${weight}`);
    const u = rng();
    // Exponential race: the smallest -ln(u) / weight^gamma wins. Compared in log space so large
    // weights or gammas cannot overflow and tiny ones cannot underflow to a tie.
    const key = Math.log(-Math.log(u > 0 ? u : Number.MIN_VALUE)) - gamma * Math.log(weight);
    return { item, key, index };
  });
  keyed.sort((x, y) => x.key - y.key || x.index - y.index);
  return keyed.slice(0, count).map(entry => entry.item);
}
