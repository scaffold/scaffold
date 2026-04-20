/**
 * Seeded RNG helpers. Mulberry32 -- small, fast, good enough for
 * harness purposes (non-cryptographic). Deterministic given the seed.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit seed, FNV-1a style. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Gaussian sample via Box-Muller. */
export function gaussian(rand: Rng, mean: number, stddev: number): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = rand();
  while (u2 === 0) u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z;
}

/** Poisson interarrival time (seconds) for rate lambda (events/sec). */
export function exponential(rand: Rng, ratePerSec: number): number {
  if (ratePerSec <= 0) return Infinity;
  return -Math.log(1 - rand()) / ratePerSec;
}

/** Continuous power-law sample in [min, max] with exponent alpha (>1). */
export function powerLaw(rand: Rng, alpha: number, min: number, max: number): number {
  const u = rand();
  const exp = 1 - alpha;
  const p = Math.pow(max, exp) - Math.pow(min, exp);
  return Math.pow(u * p + Math.pow(min, exp), 1 / exp);
}
