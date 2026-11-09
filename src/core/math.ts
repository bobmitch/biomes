/** Scalar helpers. Pure, no dependencies. */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** Hermite smoothstep, clamped. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(edge0 === edge1 ? (x >= edge1 ? 1 : 0) : (x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Quintic smootherstep — C2 continuous, used where a visible crease would show. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(edge0 === edge1 ? (x >= edge1 ? 1 : 0) : (x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Polynomial smooth maximum. Merges overlapping island falloffs into
 * continuous landmasses instead of leaving a crease where they meet.
 * k = 0 degenerates to Math.max.
 */
export function smax(a: number, b: number, k: number): number {
  if (k <= 0) return a > b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a > b ? a : b) + h * h * k * 0.25;
}
