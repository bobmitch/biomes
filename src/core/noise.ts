/**
 * OpenSimplex2S (SuperSimplex), 2D — DESIGN.md §9 pins this variant.
 *
 * Lattice and kernel follow KdotJPG's reference implementation. One deliberate
 * difference: gradient selection is by position hash rather than a seeded
 * permutation table. That keeps the §9 contract literal — every value is a pure
 * hash of (seed, position) with no per-instance state to allocate or thread
 * through — and lets any pass derive an independent noise stream from an int.
 *
 * Output is approximately [-1, 1].
 */

import { hash2 } from './hash';

const N2 = 0.05481866495625118;
const SKEW_2D = 0.366025403784439; //  (sqrt(3) - 1) / 2
const UNSKEW_2D = -0.211324865405187; // -(1 - 1/sqrt(3)) / 2

const RAW_GRAD2 = [
  0.130526192220052, 0.991444861373810, 0.382683432365090, 0.923879532511287,
  0.608761429008721, 0.793353340291235, 0.793353340291235, 0.608761429008721,
  0.923879532511287, 0.382683432365090, 0.991444861373810, 0.130526192220052,
  0.991444861373810, -0.130526192220052, 0.923879532511287, -0.382683432365090,
  0.793353340291235, -0.608761429008721, 0.608761429008721, -0.793353340291235,
  0.382683432365090, -0.923879532511287, 0.130526192220052, -0.991444861373810,
  -0.130526192220052, -0.991444861373810, -0.382683432365090, -0.923879532511287,
  -0.608761429008721, -0.793353340291235, -0.793353340291235, -0.608761429008721,
  -0.923879532511287, -0.382683432365090, -0.991444861373810, -0.130526192220052,
  -0.991444861373810, 0.130526192220052, -0.923879532511287, 0.382683432365090,
  -0.793353340291235, 0.608761429008721, -0.608761429008721, 0.793353340291235,
  -0.382683432365090, 0.923879532511287, -0.130526192220052, 0.991444861373810,
];

const GRAD2 = new Float64Array(48);
for (let i = 0; i < 48; i++) GRAD2[i] = RAW_GRAD2[i] / N2;

// Lattice lookup: 8 orientation groups of 4 contributing vertices.
const LK_XSV = new Int32Array(32);
const LK_YSV = new Int32Array(32);
const LK_DX = new Float64Array(32);
const LK_DY = new Float64Array(32);

function setLattice(slot: number, xsv: number, ysv: number): void {
  const ssv = (xsv + ysv) * UNSKEW_2D;
  LK_XSV[slot] = xsv;
  LK_YSV[slot] = ysv;
  LK_DX[slot] = -xsv - ssv;
  LK_DY[slot] = -ysv - ssv;
}

for (let i = 0; i < 8; i++) {
  let i1: number, j1: number, i2: number, j2: number;
  if ((i & 1) === 0) {
    if ((i & 2) === 0) { i1 = -1; j1 = 0; } else { i1 = 1; j1 = 0; }
    if ((i & 4) === 0) { i2 = 0; j2 = -1; } else { i2 = 0; j2 = 1; }
  } else {
    if ((i & 2) !== 0) { i1 = 2; j1 = 1; } else { i1 = 0; j1 = 1; }
    if ((i & 4) !== 0) { i2 = 1; j2 = 2; } else { i2 = 1; j2 = 0; }
  }
  setLattice(i * 4 + 0, 0, 0);
  setLattice(i * 4 + 1, 1, 1);
  setLattice(i * 4 + 2, i1, j1);
  setLattice(i * 4 + 3, i2, j2);
}

/** Single-octave OpenSimplex2S. */
export function simplex2(seed: number, x: number, y: number): number {
  const s = SKEW_2D * (x + y);
  const xs = x + s;
  const ys = y + s;

  const xsb = Math.floor(xs);
  const ysb = Math.floor(ys);
  const xsi = xs - xsb;
  const ysi = ys - ysb;

  const a = (xsi + ysi) | 0;
  const index =
    (a << 2) |
    (((xsi - ysi * 0.5 + 1 - a * 0.5) | 0) << 3) |
    (((ysi - xsi * 0.5 + 1 - a * 0.5) | 0) << 4);

  const ssi = (xsi + ysi) * UNSKEW_2D;
  const xi = xsi + ssi;
  const yi = ysi + ssi;

  let value = 0;
  for (let i = 0; i < 4; i++) {
    const k = index + i;
    const dx = xi + LK_DX[k];
    const dy = yi + LK_DY[k];
    let attn = 0.6666666666666666 - dx * dx - dy * dy;
    if (attn <= 0) continue;
    const gi = (hash2(seed, xsb + LK_XSV[k], ysb + LK_YSV[k]) % 24) * 2;
    attn *= attn;
    value += attn * attn * (GRAD2[gi] * dx + GRAD2[gi + 1] * dy);
  }
  return value;
}

export interface FbmParams {
  octaves: number;
  /** Cycles per metre. 1/1200 means a feature about every 1200 m. */
  frequency: number;
  lacunarity: number;
  gain: number;
}

/** Amplitude-normalised fBm. Output stays in roughly [-1, 1] for any gain. */
export function fbm2(seed: number, x: number, y: number, p: FbmParams): number {
  let amp = 1;
  let freq = p.frequency;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < p.octaves; o++) {
    sum += amp * simplex2((seed ^ Math.imul(o + 1, 0x9e3779b1)) | 0, x * freq, y * freq);
    norm += amp;
    amp *= p.gain;
    freq *= p.lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal. Not used by M1's continental base, but M3 mountains
 * need it and keeping it beside fbm2 keeps the noise vocabulary in one place.
 */
export function ridged2(seed: number, x: number, y: number, p: FbmParams): number {
  let amp = 1;
  let freq = p.frequency;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < p.octaves; o++) {
    const n = 1 - Math.abs(simplex2((seed ^ Math.imul(o + 1, 0x9e3779b1)) | 0, x * freq, y * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= p.gain;
    freq *= p.lacunarity;
  }
  return norm > 0 ? (sum / norm) * 2 - 1 : 0;
}
