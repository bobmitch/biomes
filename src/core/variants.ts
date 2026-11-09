/**
 * Variant comparison harness.
 *
 * Bakes N parameter sets from ONE seed and reports metrics side by side. This
 * generalises the controlled test that settled §6.1 in M4: holding the seed
 * fixed and varying one axis is the only way to tell a parameter's effect from
 * the seed lottery, and the M2 numbers showed that lottery is violent — the
 * same parameters across two seeds moved Alien from 4% of land to 20%.
 *
 * Every sweep here reports a curve. None of them picks a point; where a value
 * is a look decision it is the caller's to make.
 */

import { bake } from './bake';
import { layoutMetrics } from './layout';
import type { LayoutMetrics } from './layout';
import { cloneParams } from './params';
import type { WorldParams } from './params';
import { partitionStats } from './passes/biomePartition';
import { erosionStats } from './passes/erosion';

export interface VariantSpec {
  label: string;
  overrides: Partial<WorldParams>;
}

export interface VariantResult {
  label: string;
  bakeMs: number;
  erosionMs: number;
  layout: LayoutMetrics;
  /** Slope p99, degrees. */
  slopeInterior: number;
  slopeSoftBorder: number;
  slopeHardBorder: number;
  hardContrast: number;
  meanAbsDelta: number;
  hardEdgeDelta: number;
  driftBefore: number;
  driftAfter: number;
  rhoRoughness: number;
  /** Elevation-rank distribution of land sites won, per biome key. */
  wonRank: Record<string, { mean: number; sd: number; n: number }>;
  biomes: Array<{
    name: string;
    erodibility: number;
    landSharePct: number;
    meanElevBefore: number;
    meanElevAfter: number;
    band: string;
    drift: number;
    delta: number;
    shapeFactor: number;
    peakElev: number;
    highFraction: number;
    highFractionInterior: number;
    meanElevInterior: number;
    meanSlopeDeg: number;
    interiorCells: number;
  }>;
}

export async function runVariant(
  base: WorldParams, spec: VariantSpec,
): Promise<VariantResult> {
  const p = cloneParams({ ...base, ...spec.overrides } as WorldParams);
  const r = await bake(p);

  const layout = layoutMetrics(
    r.atlas, p, partitionStats.targetShare, r.stats.biomeAreaLand, partitionStats.landSites,
  );

  return {
    label: spec.label,
    bakeMs: Math.round(r.totalMs),
    erosionMs: Math.round(erosionStats.gpuMs),
    layout,
    slopeInterior: r.stats.slopeP99Interior,
    slopeSoftBorder: r.stats.slopeP99SoftBorder,
    slopeHardBorder: r.stats.slopeP99HardBorder,
    hardContrast: r.stats.slopeP99HardBorder - r.stats.slopeP99Interior,
    meanAbsDelta: erosionStats.meanAbsDelta,
    hardEdgeDelta: r.geomorph.hardEdgeDelta,
    driftBefore: r.geomorph.driftBefore,
    driftAfter: r.geomorph.driftAfter,
    rhoRoughness: r.geomorph.rhoRoughness,
    wonRank: JSON.parse(JSON.stringify(partitionStats.wonRank)) as Record<
      string, { mean: number; sd: number; n: number }>,
    biomes: r.geomorph.biomes.map((b) => ({
      name: b.name,
      erodibility: b.erodibility,
      landSharePct: (r.stats.biomeAreaLand.get(b.id) ?? 0) * 100,
      meanElevBefore: b.meanElevBefore,
      meanElevAfter: b.meanElevAfter,
      band: `${b.bandMin}-${b.bandMax}`,
      drift: b.bandDrift,
      delta: b.meanAbsDelta,
      shapeFactor: b.shapeFactor,
      peakElev: b.peakElev,
      highFraction: b.highFraction,
      highFractionInterior: b.highFractionInterior,
      meanElevInterior: b.meanElevInterior,
      meanSlopeDeg: b.meanSlopeDeg,
      interiorCells: b.interiorCells,
    })),
  };
}

export async function compareVariants(
  base: WorldParams, specs: VariantSpec[],
): Promise<VariantResult[]> {
  const out: VariantResult[] = [];
  for (const spec of specs) out.push(await runVariant(base, spec));
  return out;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

export interface Spread {
  mean: number;
  /** Sample standard deviation (n-1). */
  sd: number;
  n: number;
}

/**
 * Seed-to-seed summary.
 *
 * Deliberately NOT max or (max - min). Those are not comparable across runs
 * with different seed counts — more draws mechanically produce a worse
 * maximum, so a 6-seed "worst case" looks worse than a 3-seed one even when
 * the underlying distribution is identical. Every earlier table in §14 that
 * reported `worstSeedMixPts` or a range has that flaw.
 *
 * p90 is also unhelpful at these sample sizes: with n = 6 the 90th percentile
 * IS the top order statistic, so it is max wearing a different name. Standard
 * deviation is the only summary here that means the same thing at every n.
 */
export function spread(vals: number[]): Spread {
  const n = vals.length;
  if (n === 0) return { mean: 0, sd: 0, n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const varr = n > 1
    ? vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)
    : 0;
  return { mean, sd: Math.sqrt(varr), n };
}

/**
 * Sweep 1 — the §5.4 region-size tension.
 *
 * Averaged over several seeds, not one. At large region sizes there are only
 * ~22 land sites, and §5.4 measured how violent the seed lottery is at that
 * sample size; a single-seed curve showed mix error FALLING from 1250 m to
 * 1400 m, which is noise reading as signal. Seeds are derived from the base
 * seed so the sweep is still reproducible.
 */
export async function sweepRegionSize(
  base: WorldParams,
  sizes = [500, 620, 760, 900, 1050, 1250, 1400],
  seeds = 3,
): Promise<Array<Record<string, number | string>>> {
  const rows: Array<Record<string, number | string>> = [];

  for (const size of sizes) {
    const acc = {
      landSites: 0, mixErr: 0, maxMixErr: 0, patches: 0,
      meanPatch: 0, medianPatch: 0, run: 0, channels: 0,
    };
    const mixSamples: number[] = [];
    for (let k = 0; k < seeds; k++) {
      const v = await runVariant(base, {
        label: `${size}m/s${k}`,
        overrides: {
          biomeCellSpacing: size,
          seed: (base.seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0,
        },
      });
      acc.landSites += v.layout.landSites;
      acc.mixErr += v.layout.mixErrorPoints;
      acc.maxMixErr += v.layout.maxMixErrorPoints;
      acc.patches += v.layout.patches;
      acc.meanPatch += v.layout.meanPatchAreaKm2;
      acc.medianPatch += v.layout.medianPatchAreaKm2;
      acc.run += v.layout.meanCrossingRunM;
      acc.channels += v.layout.channelsPerPatch;
      mixSamples.push(v.layout.mixErrorPoints);
    }
    const n = seeds;
    rows.push({
      regionM: size,
      landSites: r2(acc.landSites / n),
      sitesPerBiome: r2(acc.landSites / n / 8),
      mixErrPts: r2(acc.mixErr / n),
      maxMixErrPts: r2(acc.maxMixErr / n),
      mixSdPts: r2(spread(mixSamples).sd),
      patches: Math.round(acc.patches / n),
      meanPatchKm2: r2(acc.meanPatch / n),
      medianPatchKm2: r2(acc.medianPatch / n),
      crossingRunM: Math.round(acc.run / n),
      channelsPerRun: r2(acc.channels / n),
    });
  }
  return rows;
}

/** Sweep 2 — what hard rims cost, per §6.2. */
export async function sweepTalus(
  base: WorldParams, values = [1.5, 2.5, 4, 6, 8, 11, 14, 20],
): Promise<Array<Record<string, number | string>>> {
  const rs = await compareVariants(
    base,
    values.map((v) => ({ label: `tan ${v}`, overrides: { hardTalusOverride: v } })),
  );
  return rs.map((v, i) => ({
    talusTan: values[i],
    angleDeg: r2((Math.atan(values[i]) * 180) / Math.PI),
    hardBorder: v.slopeHardBorder,
    interior: v.slopeInterior,
    contrast: v.hardContrast,
    hardEdgeErosionM: r2(v.hardEdgeDelta),
    totalErosionM: r2(v.meanAbsDelta),
  }));
}

/** Sweep 3 — envelope drift against the §7 bands, before and after erosion. */
export async function envelopeDrift(
  base: WorldParams,
): Promise<{ summary: Record<string, number>; biomes: Array<Record<string, number | string>> }> {
  const withEro = await runVariant(base, { label: 'with erosion', overrides: {} });
  return {
    summary: {
      meanDriftBefore: r2(withEro.driftBefore),
      meanDriftAfter: r2(withEro.driftAfter),
    },
    biomes: withEro.biomes.map((b) => ({
      name: b.name,
      band: b.band,
      preErosion: r2(b.meanElevBefore),
      postErosion: r2(b.meanElevAfter),
      changedBy: r2(b.meanElevAfter - b.meanElevBefore),
      driftOutsideBand: r2(b.drift),
    })),
  };
}

/**
 * Sweep 4 — envelope drift as a function of REGION SIZE.
 *
 * §14.4 reported drift as a property of the envelope. That was wrong: stage 2
 * matches biomes to terrain using the §5.4 elevation-rank nudge, so region
 * size changes which ground Mountains actually lands on, which is what sets
 * its mean. Region size turns out to be the larger term — Mountains' mean
 * moves ~90 m across the range against the ~20 m gap the spans would be tuned
 * to close.
 *
 * Three seeds, and the per-seed spread is reported alongside the mean rather
 * than hidden by it: §14.1 established that large regions are a
 * high-variance regime, so a single-seed drift figure there is part lottery.
 * Without the spread column there is no way to tell which rows to trust.
 *
 * The dependency is one-way, which is why this runs before any span is set:
 * the envelope applies at stage 3, after the partition at stage 2, and
 * `elevSpan * u^profile` is non-negative and applied only above sea level —
 * so it cannot move a cell across the waterline. Layout is invariant to the
 * spans; the spans are not invariant to layout.
 */
export async function sweepDriftByRegion(
  base: WorldParams,
  sizes = [500, 620, 760, 820, 900, 1050, 1250, 1400],
  seeds = 3,
): Promise<Array<Record<string, number | string>>> {
  const rows: Array<Record<string, number | string>> = [];

  for (const size of sizes) {
    const perSeed: VariantResult[] = [];
    for (let k = 0; k < seeds; k++) {
      perSeed.push(await runVariant(base, {
        label: `${size}m/s${k}`,
        overrides: {
          biomeCellSpacing: size,
          seed: (base.seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0,
        },
      }));
    }

    const pick = (v: VariantResult, name: string) => v.biomes.find((b) => b.name === name);
    const stat = (vals: number[]) => ({
      mean: vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length),
      min: Math.min(...vals),
      max: Math.max(...vals),
    });

    const mtn = stat(perSeed.map((v) => pick(v, 'Mountains')?.meanElevAfter ?? 0));
    const mtnD = stat(perSeed.map((v) => pick(v, 'Mountains')?.drift ?? 0));
    const ash = stat(perSeed.map((v) => pick(v, 'Ashlands')?.meanElevAfter ?? 0));
    const ashD = stat(perSeed.map((v) => pick(v, 'Ashlands')?.drift ?? 0));
    const all = stat(perSeed.map((v) => v.driftAfter));
    const patches = stat(perSeed.map((v) => v.layout.patches));

    rows.push({
      regionM: size,
      patches: Math.round(patches.mean),
      mtnMean: r2(mtn.mean),
      mtnDrift: r2(mtnD.mean),
      mtnDriftSd: r2(spread(perSeed.map((v) => pick(v, 'Mountains')?.drift ?? 0)).sd),
      ashMean: r2(ash.mean),
      ashDrift: r2(ashD.mean),
      ashDriftSd: r2(spread(perSeed.map((v) => pick(v, 'Ashlands')?.drift ?? 0)).sd),
      meanDrift: r2(all.mean),
      meanDriftSd: r2(spread(perSeed.map((v) => v.driftAfter)).sd),
    });
  }
  return rows;
}

/**
 * Per-biome mean elevation at one region size, over N seeds.
 *
 * Reports mean +/- sd per biome and how many seeds landed inside the §7 band.
 * "Out of band on one draw" and "reliably out of band" are different claims
 * and only the second is actionable; `seedsInBand` is what separates them.
 */
export async function envelopeBySeeds(
  base: WorldParams, regionM: number, seeds = 6,
): Promise<{
  regionM: number;
  seeds: number;
  biomes: Array<Record<string, number | string>>;
}> {
  const runs: VariantResult[] = [];
  for (let k = 0; k < seeds; k++) {
    runs.push(await runVariant(base, {
      label: `${regionM}m/s${k}`,
      overrides: {
        biomeCellSpacing: regionM,
        seed: (base.seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0,
      },
    }));
  }

  const names = runs[0].biomes.map((b) => b.name);
  const biomes = names.map((name) => {
    const rows = runs.map((v) => v.biomes.find((b) => b.name === name));
    const means = rows.map((b) => b?.meanElevAfter ?? 0);
    const drifts = rows.map((b) => b?.drift ?? 0);
    const sm = spread(means);
    const sd = spread(drifts);
    const inBand = drifts.filter((d) => d === 0).length;
    return {
      name,
      band: rows[0]?.band ?? '',
      meanElev: r2(sm.mean),
      elevSd: r2(sm.sd),
      driftMean: r2(sd.mean),
      driftSd: r2(sd.sd),
      seedsInBand: `${inBand}/${seeds}`,
    };
  });

  return { regionM, seeds, biomes };
}

/**
 * Sensitivity of a biome's mean elevation to elevSpan and elevProfile.
 *
 * NOT orthogonal knobs, and the output is shaped to make that explicit rather
 * than to hide it. Mean elevation factorises as
 *
 *     mean  ~  elevSpan * E[u^elevProfile]
 *
 * so the two multiply: changing profile rescales what every span value gives.
 * Each row therefore reports `shapeFactor = mean / span`, which is the
 * measured E[u^profile] at that setting. With it, the mean for ANY span at a
 * given profile is span * shapeFactor — no further bakes needed, and the
 * interaction is visible instead of implied.
 */
export async function sensitivity(
  base: WorldParams,
  regionM: number,
  biomeKey: string,
  biomeName: string,
  spans: number[],
  profiles: number[],
  seeds = 3,
): Promise<{
  axis: string;
  rows: Array<Record<string, number | string>>;
}[]> {
  const measure = async (
    overrides: Partial<WorldParams>, span: number,
  ): Promise<{ mean: number; sd: number }> => {
    const means: number[] = [];
    for (let k = 0; k < seeds; k++) {
      const v = await runVariant(base, {
        label: `${biomeKey}`,
        overrides: {
          ...overrides,
          biomeCellSpacing: regionM,
          seed: (base.seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0,
        },
      });
      means.push(v.biomes.find((b) => b.name === biomeName)?.meanElevAfter ?? 0);
    }
    const s = spread(means);
    void span;
    return { mean: s.mean, sd: s.sd };
  };

  const baseProfile = base.profileOverride[biomeKey];
  const spanRows: Array<Record<string, number | string>> = [];
  for (const span of spans) {
    const r = await measure({ spanOverride: { [biomeKey]: span } }, span);
    spanRows.push({
      elevSpan: span,
      profile: baseProfile ?? 'authored',
      meanElev: r2(r.mean),
      sd: r2(r.sd),
      shapeFactor: r2(r.mean / span),
    });
  }

  const profileRows: Array<Record<string, number | string>> = [];
  for (const prof of profiles) {
    const r = await measure({ profileOverride: { [biomeKey]: prof } }, 0);
    profileRows.push({
      elevProfile: prof,
      meanElev: r2(r.mean),
      sd: r2(r.sd),
    });
  }

  return [
    { axis: `${biomeName}: elevSpan (profile held)`, rows: spanRows },
    { axis: `${biomeName}: elevProfile (span held)`, rows: profileRows },
  ];
}

/**
 * §14.5's alternative: does stabilising WHERE a biome lands beat raising its
 * span? Sweeps radialMean / radialWidth and reports both the elevation spread
 * across seeds and the §14.1 mix error, since widening a radial bias spends
 * mix accuracy to buy placement reliability.
 */
export async function radialSensitivity(
  base: WorldParams,
  regionM: number,
  biomeKey: string,
  biomeName: string,
  variants: Array<{ label: string; radialMean?: number; radialWidth?: number }>,
  seeds = 4,
): Promise<Array<Record<string, number | string>>> {
  const rows: Array<Record<string, number | string>> = [];
  for (const variant of variants) {
    const means: number[] = [];
    const mixes: number[] = [];
    const shares: number[] = [];
    for (let k = 0; k < seeds; k++) {
      const v = await runVariant(base, {
        label: variant.label,
        overrides: {
          biomeCellSpacing: regionM,
          seed: (base.seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0,
          ...(variant.radialMean !== undefined
            ? { radialMeanOverride: { [biomeKey]: variant.radialMean } } : {}),
          ...(variant.radialWidth !== undefined
            ? { radialWidthOverride: { [biomeKey]: variant.radialWidth } } : {}),
        },
      });
      const b = v.biomes.find((x) => x.name === biomeName);
      means.push(b?.meanElevAfter ?? 0);
      shares.push(b?.landSharePct ?? 0);
      mixes.push(v.layout.mixErrorPoints);
    }
    const sm = spread(means);
    const sx = spread(mixes);
    const ss = spread(shares);
    rows.push({
      variant: variant.label,
      meanElev: r2(sm.mean),
      elevSd: r2(sm.sd),
      landSharePct: r2(ss.mean),
      shareSd: r2(ss.sd),
      mixErrPts: r2(sx.mean),
      mixErrSd: r2(sx.sd),
    });
  }
  return rows;
}
