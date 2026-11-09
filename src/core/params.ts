/** World parameters — DESIGN.md §4 bake tier. */

import type { FbmParams } from './noise';

export interface WorldParams {
  /** Hashed from the seed string in the UI. */
  seed: number;
  /** Metres. 5000 => the 10 km sandbox. */
  worldRadius: number;
  /** Atlas is atlasRes x atlasRes over the bounding square of the disc. */
  atlasRes: number;
  seaLevel: number;

  // --- island-cluster scatter -------------------------------------------
  /** Metres between island seed points before jitter. */
  islandSpacing: number;
  islandJitter: number;
  islandRadiusMin: number;
  islandRadiusMax: number;
  /** Low-frequency field deciding which seeds survive — this makes clusters. */
  clusterFrequency: number;
  clusterThreshold: number;
  /** How fast vigour ramps once a seed is above threshold. */
  clusterSharpness: number;
  /** Per-seed random offset to the cluster field. Breaks up blobby groups. */
  islandVariance: number;
  /** smax() k. Higher = islands merge into landmasses more readily. */
  mergeSoftness: number;

  // --- continental detail -----------------------------------------------
  continentFbm: FbmParams;
  detailAmplitude: number;
  warpAmplitude: number;
  warpFrequency: number;

  // --- landness -> metres -----------------------------------------------
  shoreline: number;
  landGain: number;
  oceanGain: number;

  // --- radial ocean taper -------------------------------------------------
  /** Fraction of worldRadius where the taper begins. */
  rimStart: number;
  rimDepth: number;

  // --- biome partition (stage 2) -------------------------------------------
  /**
   * Worley cell spacing in metres — roughly the size of a biome region.
   *
   * This is the single most consequential number in stage 2, and not for the
   * reason it looks like. What controls whether the biome mix is steerable is
   * the count of LAND-BEARING sites: only ~19% of the disc is land, so at
   * 1150 m there were 22 of them for 8 biomes, under 3 regions each, and no
   * amount of quota pressure can subdivide a region. Watch "land sites" in
   * the Bake panel, not this value — aim for 6+ per biome.
   */
  biomeCellSpacing: number;
  biomeJitter: number;
  /** 0 = independent per-site draws, 1 = full land-area quota enforcement. */
  biomeQuota: number;
  /** Three-scale boundary warp. Coarse breaks the polygon silhouette, mid
   *  makes lobes, fine removes the last straight edge. */
  warpA1: number;
  warpF1: number;
  warpA2: number;
  warpF2: number;
  warpA3: number;
  warpF3: number;

  // --- height envelope (stage 3) -------------------------------------------
  /** 0 = continental base untouched (M2 behaviour), 1 = full envelope. */
  envelopeStrength: number;
  /** Metres of elevation over which the envelope fades in from the shore.
   *  Without this every biome with a high elevMin gets a cliff at the coast. */
  coastBand: number;
  /** Multiplier on every per-biome blend width. */
  blendScale: number;
  /** Metres of blend granted to pairs marked hardEdge. 0 = a true 1-cell cut. */
  hardEdgeBlend: number;

  // --- global erosion (stage 5) --------------------------------------------
  eroIterations: number;
  eroDt: number;
  eroRain: number;
  eroEvaporation: number;
  /** Sediment capacity constant Kc. */
  eroCapacity: number;
  /** Dissolution rate Ks — the rate erodibility gates. */
  eroDissolve: number;
  /** Deposition rate Kd — deliberately NOT gated by erodibility. */
  eroDeposit: number;
  /** Floor on sin(tilt) so flat ground still transports a little. */
  eroMinTilt: number;
  /** Water depth below which a cell carries nothing. */
  eroMinWater: number;
  /** Stability clamps. The pipe model divides velocity by water depth, so
   *  without these a steep dry cell diverges within one iteration. */
  eroMaxVelocity: number;
  eroMaxCapacity: number;
  eroMaxDelta: number;
  /** tan(stable slope) at erodibility 1 (soft) and 0 (resistant). */
  eroTalusSoft: number;
  eroTalusHard: number;
  eroThermalRate: number;
  /** Run thermal relaxation every N hydraulic iterations. 0 disables it. */
  eroThermalEvery: number;
  /**
   * Test control, not a world parameter. >= 0 forces every cell to this
   * erodibility, which brackets the §6 mechanism: 0 must leave the terrain
   * untouched, 1 must erode everywhere uniformly. -1 uses the real field.
   */
  eroErodibilityOverride: number;
  /**
   * Test control. >= 0 replaces talusTan for every hardEdge biome with this
   * value, so §6.2's rim-versus-erosion trade-off can be swept without
   * editing the roster. -1 uses each biome's authored value.
   */
  hardTalusOverride: number;
  /**
   * Test controls: per-biome overrides keyed by BiomeDef.key, so sensitivity
   * can be swept without editing the roster. Empty object = use the authored
   * values. These exist for the harness; generation reads them transparently.
   */
  spanOverride: Record<string, number>;
  profileOverride: Record<string, number>;
  radialMeanOverride: Record<string, number>;
  radialWidthOverride: Record<string, number>;
  elevRankMeanOverride: Record<string, number>;
  elevRankWidthOverride: Record<string, number>;
}

export const DEFAULT_PARAMS: WorldParams = {
  seed: 0,
  worldRadius: 5000,
  atlasRes: 1024,
  seaLevel: 0,

  islandSpacing: 820,
  islandJitter: 0.85,
  islandRadiusMin: 260,
  islandRadiusMax: 980,
  clusterFrequency: 1 / 4200,
  clusterThreshold: -0.04,
  clusterSharpness: 2.6,
  islandVariance: 0.42,
  mergeSoftness: 0.3,

  continentFbm: { octaves: 6, frequency: 1 / 1500, lacunarity: 2.05, gain: 0.5 },
  detailAmplitude: 0.28,
  warpAmplitude: 420,
  warpFrequency: 1 / 2600,

  shoreline: 0.32,
  landGain: 270,
  oceanGain: 430,

  rimStart: 0.74,
  rimDepth: 220,

  biomeCellSpacing: 900,
  biomeJitter: 0.9,
  biomeQuota: 1,
  warpA1: 340,
  warpF1: 1 / 4000,
  warpA2: 115,
  warpF2: 1 / 900,
  warpA3: 30,
  warpF3: 1 / 200,

  envelopeStrength: 1,
  coastBand: 55,
  blendScale: 1,
  hardEdgeBlend: 0,

  eroIterations: 140,
  eroDt: 0.02,
  eroRain: 0.012,
  eroEvaporation: 0.015,
  eroCapacity: 14,
  eroDissolve: 0.5,
  eroDeposit: 0.5,
  eroMinTilt: 0.05,
  eroMinWater: 0.012,
  eroMaxVelocity: 6,
  eroMaxCapacity: 1.2,
  eroMaxDelta: 0.25,
  eroTalusSoft: 0.55,
  eroTalusHard: 2.6,
  eroThermalRate: 0.5,
  eroThermalEvery: 2,
  eroErodibilityOverride: -1,
  hardTalusOverride: -1,
  spanOverride: {},
  profileOverride: {},
  radialMeanOverride: {},
  radialWidthOverride: {},
  elevRankMeanOverride: {},
  elevRankWidthOverride: {},
};

export function cloneParams(p: WorldParams): WorldParams {
  return {
    ...p,
    continentFbm: { ...p.continentFbm },
    spanOverride: { ...p.spanOverride },
    profileOverride: { ...p.profileOverride },
    radialMeanOverride: { ...p.radialMeanOverride },
    radialWidthOverride: { ...p.radialWidthOverride },
    elevRankMeanOverride: { ...p.elevRankMeanOverride },
    elevRankWidthOverride: { ...p.elevRankWidthOverride },
  };
}
