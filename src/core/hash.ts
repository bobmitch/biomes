/**
 * Deterministic hashing — DESIGN.md §9.
 *
 * Contract: every "random" value in the generator is a pure function of
 * (worldSeed, passId, slot, position). There is no Math.random anywhere in
 * core/ and there must never be one — a bake is reproducible from its seed
 * alone, or the auditioner is lying to you. (The UI's Reroll button picks a
 * new seed from the clock, which is the one place non-determinism belongs.)
 *
 * DEVIATION from DESIGN.md §9, recorded deliberately:
 * the doc specifies splitmix64 over u64 seeds. JS has no fast 64-bit integer
 * path (BigInt is ~50x slower and a bake hashes tens of millions of times),
 * so this uses a 32-bit avalanche chain instead. The contract is identical;
 * only the word is narrower. Widening to u64 in a port changes the terrain
 * it produces, not the architecture around it.
 */

/** lowbias32 finalizer (Chris Wellons). Returns uint32. */
export function hashU32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function hash2(seed: number, x: number, y: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  return hashU32(h);
}

export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h = Math.imul(h ^ (z | 0), 0x9e3779b1);
  return hashU32(h);
}

const INV_U32 = 1 / 4294967296;

/** uint32 -> [0, 1) */
export function rand01(h: number): number {
  return (h >>> 0) * INV_U32;
}

/** uint32 -> [-1, 1) */
export function rand11(h: number): number {
  return (h >>> 0) * INV_U32 * 2 - 1;
}

/**
 * The documented seed chain. Every pass derives its own stream from the world
 * seed, so changing one pass's parameters never reshuffles another's noise.
 * `slot` separates independent streams inside a single pass (warp vs detail vs
 * placement), which is what keeps a slider from secretly rerolling the world.
 */
export function deriveSeed(worldSeed: number, passId: number, slot = 0): number {
  return (
    hashU32(
      Math.imul(worldSeed | 0, 0x9e3779b1) ^
        Math.imul(passId | 0, 0x85ebca6b) ^
        Math.imul(slot | 0, 0xc2b2ae35),
    ) | 0
  );
}

/** FNV-1a over a user-typed seed string, so "driftwood" is a valid world seed. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return hashU32(h) | 0;
}
