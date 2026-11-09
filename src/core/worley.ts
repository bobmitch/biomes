/**
 * Worley sites as a precomputed grid — DESIGN.md §5.1/§5.2.
 *
 * The world is bounded, so every Worley site in it can be built once per bake
 * (a 10 km world at 1100 m spacing is ~400 sites) and queried by table lookup
 * afterwards. Beyond the obvious speed win, this is what makes per-cell biome
 * assignment and the adjacency repair in §5.1 possible at all: both need to
 * address a site as a thing with identity and mutable state, which a purely
 * procedural Worley evaluation cannot offer.
 *
 * Stage 7 (feature placement) wants the same structure.
 */

import { hash2, hashU32, rand01 } from './hash';

export interface SiteGrid {
  spacing: number;
  /** Grid-space origin, in cell units. */
  gx0: number;
  gy0: number;
  nx: number;
  ny: number;
  /** Site positions in world metres, indexed iy * nx + ix. */
  px: Float64Array;
  py: Float64Array;
}

export interface WorleyHit {
  /** Distance to the nearest site, metres. */
  f1: number;
  /** Distance to the second-nearest site, metres. */
  f2: number;
  /** Flat index of the nearest site, or -1. */
  cell: number;
}

export function buildSiteGrid(
  seed: number,
  spacing: number,
  jitter: number,
  extent: number,
): SiteGrid {
  const gx0 = Math.floor(-extent / spacing) - 1;
  const gy0 = gx0;
  const nx = Math.ceil(extent / spacing) - gx0 + 2;
  const ny = nx;
  const px = new Float64Array(nx * ny);
  const py = new Float64Array(nx * ny);

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cx = gx0 + ix;
      const cy = gy0 + iy;
      const h0 = hash2(seed, cx, cy);
      const h1 = hashU32(h0 ^ 0x6d2b79f5);
      const i = iy * nx + ix;
      px[i] = (cx + 0.5 + (rand01(h0) - 0.5) * jitter) * spacing;
      py[i] = (cy + 0.5 + (rand01(h1) - 0.5) * jitter) * spacing;
    }
  }

  return { spacing, gx0, gy0, nx, ny, px, py };
}

/**
 * Euclidean F1/F2 over a 5x5 neighbourhood. 5x5 rather than the usual 3x3
 * because at jitter 1.0 a site can sit anywhere in its cell, and F2 in
 * particular is wrong often enough at 3x3 to put visible kinks in the
 * boundary-distance field — which is exactly the field §5.3 blends on.
 */
export function queryF1F2(g: SiteGrid, x: number, y: number, out: WorleyHit): void {
  const gx = Math.floor(x / g.spacing) - g.gx0;
  const gy = Math.floor(y / g.spacing) - g.gy0;

  let f1 = Infinity;
  let f2 = Infinity;
  let cell = -1;

  const x0 = gx - 2 < 0 ? 0 : gx - 2;
  const x1 = gx + 2 >= g.nx ? g.nx - 1 : gx + 2;
  const y0 = gy - 2 < 0 ? 0 : gy - 2;
  const y1 = gy + 2 >= g.ny ? g.ny - 1 : gy + 2;

  for (let iy = y0; iy <= y1; iy++) {
    const row = iy * g.nx;
    for (let ix = x0; ix <= x1; ix++) {
      const i = row + ix;
      const dx = x - g.px[i];
      const dy = y - g.py[i];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        cell = i;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }

  out.f1 = f1;
  out.f2 = f2;
  out.cell = cell;
}

export interface BoundaryHit {
  /** Distance to the nearest site, metres. */
  f1: number;
  /** Flat index of the nearest site, or -1. */
  cell: number;
  /** Distance to the nearest site carrying a DIFFERENT label, or Infinity. */
  fOther: number;
  /** That site's index, or -1 if no foreign site is within the search ring. */
  cellOther: number;
}

const SCRATCH_D = new Float64Array(25);
const SCRATCH_I = new Int32Array(25);

/**
 * Nearest site, plus nearest site with a different label.
 *
 * This replaces plain F1/F2 for anything that blends. (F2 - F1)/2 measures the
 * distance to the nearest *site* edge, which is only the distance to the
 * nearest *biome* edge when adjacent sites happen to disagree. Where several
 * neighbouring sites share a biome — which the quota draw makes common — a
 * cell deep inside a merged region reports a boundary distance near zero and
 * blends against itself. Labelling the query fixes that at the source.
 *
 * fOther is Infinity when the whole 5x5 neighbourhood agrees; callers should
 * read that as "deep interior", which is exactly what it means.
 */
export function queryLabelled(
  g: SiteGrid, x: number, y: number, label: Uint16Array, out: BoundaryHit,
): void {
  const gx = Math.floor(x / g.spacing) - g.gx0;
  const gy = Math.floor(y / g.spacing) - g.gy0;

  const x0 = gx - 2 < 0 ? 0 : gx - 2;
  const x1 = gx + 2 >= g.nx ? g.nx - 1 : gx + 2;
  const y0 = gy - 2 < 0 ? 0 : gy - 2;
  const y1 = gy + 2 >= g.ny ? g.ny - 1 : gy + 2;

  let n = 0;
  let f1 = Infinity;
  let cell = -1;

  for (let iy = y0; iy <= y1; iy++) {
    const row = iy * g.nx;
    for (let ix = x0; ix <= x1; ix++) {
      const i = row + ix;
      const dx = x - g.px[i];
      const dy = y - g.py[i];
      const d = Math.sqrt(dx * dx + dy * dy);
      SCRATCH_D[n] = d;
      SCRATCH_I[n] = i;
      n++;
      if (d < f1) { f1 = d; cell = i; }
    }
  }

  // Second scan over the cached distances rather than recomputing them.
  let fOther = Infinity;
  let cellOther = -1;
  if (cell >= 0) {
    const mine = label[cell];
    for (let k = 0; k < n; k++) {
      if (label[SCRATCH_I[k]] === mine) continue;
      if (SCRATCH_D[k] < fOther) { fOther = SCRATCH_D[k]; cellOther = SCRATCH_I[k]; }
    }
  }

  out.f1 = f1;
  out.cell = cell;
  out.fOther = fOther;
  out.cellOther = cellOther;
}

/** Grid neighbours of a site (4-connected), used by the adjacency repair. */
export function siteNeighbours(g: SiteGrid, i: number, out: number[]): number {
  const ix = i % g.nx;
  const iy = (i - ix) / g.nx;
  let n = 0;
  if (ix > 0) out[n++] = i - 1;
  if (ix < g.nx - 1) out[n++] = i + 1;
  if (iy > 0) out[n++] = i - g.nx;
  if (iy < g.ny - 1) out[n++] = i + g.nx;
  return n;
}
