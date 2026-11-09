/**
 * Stage 1 — Continental base. DESIGN.md §4.
 *
 * Writes: baseHeight.
 *
 * Three things combine:
 *   1. an island-cluster scatter, which gives the archipelago topology
 *   2. continental fBm, which gives each landmass internal shape
 *   3. the radial taper, which closes the world at the rim
 *
 * The scatter is a two-level construction. Island seed points sit on a jittered
 * grid; a low-frequency cluster field decides which of them survive. Clustering
 * falls out of that for free — the surviving seeds group where the field is
 * high, leaving open water between groups, without ever placing a "cluster"
 * explicitly. Overlapping islands merge via smax() rather than max(), so
 * adjacent islands grow isthmuses instead of meeting at a crease.
 *
 * The island table is precomputed once per bake. There are only a few hundred
 * seed points across the whole world, and evaluating the cluster fBm per seed
 * instead of per atlas cell is the difference between a ~0.4 s bake and a ~12 s
 * one. Stage 7 (feature placement) will reuse this pattern.
 */

import { Atlas } from '../atlas';
import { FLAG_OUTSIDE } from '../atlas';
import { clamp, clamp01, smax, smoothstep } from '../math';
import { deriveSeed, hash2, hashU32, rand01 } from '../hash';
import { fbm2 } from '../noise';
import type { FbmParams } from '../noise';
import type { WorldParams } from '../params';

export const PASS_CONTINENTAL = 1;

interface IslandTable {
  gx0: number;
  gy0: number;
  nx: number;
  ny: number;
  /** -1 radius marks a dead cell. */
  px: Float64Array;
  py: Float64Array;
  radius: Float64Array;
  amp: Float64Array;
}

const CLUSTER_FBM: FbmParams = { octaves: 3, frequency: 1 / 4200, lacunarity: 2, gain: 0.5 };

/**
 * The warp spectrum matters more than its amplitude. At gain 0.5 the high
 * octaves are too weak to do anything but translate the field, and islands
 * stay visibly circular — the falloff shape shows straight through. Carrying
 * energy down to the ~500 m octave is what actually ripples a coastline.
 */
const WARP_FBM: FbmParams = { octaves: 5, frequency: 1 / 2600, lacunarity: 2.1, gain: 0.62 };

function buildIslandTable(p: WorldParams, sIsland: number, sCluster: number): IslandTable {
  const s = p.islandSpacing;
  // Warping can push a lookup outside the disc, and an island centred outside
  // can still reach in, so the table covers a generous margin.
  const margin = p.warpAmplitude + p.islandRadiusMax + s * 2;
  const extent = p.worldRadius + margin;
  const gx0 = Math.floor(-extent / s);
  const gy0 = Math.floor(-extent / s);
  const nx = Math.ceil(extent / s) - gx0 + 1;
  const ny = Math.ceil(extent / s) - gy0 + 1;
  const n = nx * ny;

  const table: IslandTable = {
    gx0, gy0, nx, ny,
    px: new Float64Array(n),
    py: new Float64Array(n),
    radius: new Float64Array(n).fill(-1),
    amp: new Float64Array(n),
  };

  const clusterFbm: FbmParams = { ...CLUSTER_FBM, frequency: p.clusterFrequency };

  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const cx = gx0 + gx;
      const cy = gy0 + gy;
      const h0 = hash2(sIsland, cx, cy);
      const h1 = hashU32(h0 ^ 0x9e3779b1);
      const h2 = hashU32(h1 ^ 0x85ebca6b);

      const jx = (cx + 0.5 + (rand01(h0) - 0.5) * p.islandJitter) * s;
      const jy = (cy + 0.5 + (rand01(h1) - 0.5) * p.islandJitter) * s;

      // Survival: cluster field plus a per-seed offset. Without the offset the
      // groups read as smooth blobs; with it their edges are ragged.
      const alive =
        fbm2(sCluster, jx, jy, clusterFbm) + (rand01(h2) - 0.5) * p.islandVariance;
      if (alive <= p.clusterThreshold) continue;

      const vigour = clamp01((alive - p.clusterThreshold) * p.clusterSharpness);
      const i = gy * nx + gx;
      table.px[i] = jx;
      table.py[i] = jy;
      table.radius[i] = p.islandRadiusMin + (p.islandRadiusMax - p.islandRadiusMin) * vigour;
      table.amp[i] = 0.55 + 0.45 * vigour;
    }
  }

  return table;
}

function islandField(t: IslandTable, s: number, ring: number, k: number, x: number, y: number): number {
  const gx = Math.floor(x / s) - t.gx0;
  const gy = Math.floor(y / s) - t.gy0;
  let acc = 0;

  const x0 = Math.max(0, gx - ring);
  const x1 = Math.min(t.nx - 1, gx + ring);
  const y0 = Math.max(0, gy - ring);
  const y1 = Math.min(t.ny - 1, gy + ring);

  for (let iy = y0; iy <= y1; iy++) {
    const row = iy * t.nx;
    for (let ix = x0; ix <= x1; ix++) {
      const i = row + ix;
      const r = t.radius[i];
      if (r < 0) continue;
      const dx = x - t.px[i];
      const dy = y - t.py[i];
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      const u = 1 - Math.sqrt(d2) / r;
      acc = smax(acc, u * u * (3 - 2 * u) * t.amp[i], k);
    }
  }
  return acc;
}

export function continentalBase(atlas: Atlas, p: WorldParams): void {
  const sIsland = deriveSeed(p.seed, PASS_CONTINENTAL, 1);
  const sCluster = deriveSeed(p.seed, PASS_CONTINENTAL, 2);
  const sDetail = deriveSeed(p.seed, PASS_CONTINENTAL, 3);
  const sWarpX = deriveSeed(p.seed, PASS_CONTINENTAL, 4);
  const sWarpY = deriveSeed(p.seed, PASS_CONTINENTAL, 5);

  const table = buildIslandTable(p, sIsland, sCluster);
  const ring = Math.max(1, Math.ceil(p.islandRadiusMax / p.islandSpacing));
  const warpFbm: FbmParams = { ...WARP_FBM, frequency: p.warpFrequency };

  const { res, baseHeight, flags } = atlas;
  const R = p.worldRadius;
  const invR = 1 / R;
  const floorClamp = -p.rimDepth - 60;

  for (let iy = 0; iy < res; iy++) {
    const wy = atlas.worldY(iy);
    const row = iy * res;

    for (let ix = 0; ix < res; ix++) {
      const wx = atlas.worldX(ix);

      // Domain warp. Two independent streams, or the offset collapses onto the
      // diagonal and every coastline leans the same way.
      const ax = wx + p.warpAmplitude * fbm2(sWarpX, wx, wy, warpFbm);
      const ay = wy + p.warpAmplitude * fbm2(sWarpY, wx, wy, warpFbm);

      const island = islandField(table, p.islandSpacing, ring, p.mergeSoftness, ax, ay);
      const detail = fbm2(sDetail, ax, ay, p.continentFbm);
      const landness = island + detail * p.detailAmplitude;

      const d = landness - p.shoreline;
      let h = d >= 0 ? d * p.landGain : d * p.oceanGain;

      // Radial taper — the world closes itself. Everything beyond rimStart is
      // pulled to ocean floor, which also makes out-of-disc cells harmless.
      const r = Math.sqrt(wx * wx + wy * wy) * invR;
      const rim = smoothstep(p.rimStart, 1, r);
      h = h * (1 - rim) - p.rimDepth * rim;

      const i = row + ix;
      baseHeight[i] = clamp(h, floorClamp, 520);
      if (r > 1) flags[i] |= FLAG_OUTSIDE;
    }
  }
}
