/**
 * Biome roster — DESIGN.md §7.
 *
 * Most of this table is forward-declared: only `weight`, `radialMean`,
 * `radialWidth`, `forbid` and `colour` are read by M2's partition. The
 * elevation envelope is M3, erodibility is M4, hardEdge is M3 blending, and
 * columnValid is the §3 honesty flag that tells the 3D inspector when the
 * 2.5D fast path is lying. They live here now so the roster is one table
 * rather than five that drift apart.
 */

export interface BiomeDef {
  id: number;
  key: string;
  name: string;
  colour: readonly [number, number, number];

  /** Partition selection weight, before radial bias. 0 = never partitioned. */
  weight: number;
  /** Preferred normalised radius from world centre, and tolerance. */
  radialMean: number;
  radialWidth: number;
  /**
   * Where this biome wants to sit in the world's elevation *rank*, 0 (lowest
   * land) to 1 (highest), with tolerance. Stage 2 runs after stage 1, so the
   * partition can see where the land actually is — without this, radial bias
   * alone decides the mix and a biome can own map area with almost none of it
   * walkable.
   *
   * This is a NUDGE, not a gate — the widths are deliberately wide. Stage 3
   * is what gives a biome its elevation (a Meadows region is flattened, a
   * Mountains region is raised), so requiring the base to already match
   * double-counts: it makes stage 2 demand a condition stage 3 exists to
   * create, and starves the low biomes, because on domed islands low ground
   * is a thin coastal ring with very little area. All this should do is make
   * Mountains prefer ground that is already high, so the result reads as
   * natural rather than arbitrary.
   *
   * Rank rather than metres, deliberately. Absolute thresholds silently break
   * whenever the continental base is retuned: islands are domes, so very
   * little land sits near 0 m, and a Fen asking for "8 m" asks for terrain
   * that does not exist. Rank asks for "the lowest ground there is", which is
   * always well defined and needs no retuning when stage 1's sliders move.
   *
   * This is the base surface, not the §7 envelope — stage 3 applies that on
   * top of whatever the base already is here.
   */
  elevRankMean: number;
  elevRankWidth: number;
  /** Biome keys this must not share a border with. Symmetric. */
  forbid: readonly string[];

  // --- forward declarations, consumed by later milestones ---------------
  /**
   * M3 height envelope. `elevSpan` is the height this biome reaches where the
   * continental base is at its world maximum; `elevProfile` is the exponent
   * on normalised base elevation, so h = elevSpan * u^elevProfile.
   *
   * Anchored at zero, deliberately. The first cut used an elevMin/elevMax
   * band, which made elevMin a floor: Mountains at 200 m could not touch the
   * sea without a 200 m wall, and fading the envelope in over the first few
   * metres of elevation did not remove that wall, it just moved it inland and
   * made it steeper. Measured slope p99 on land was 77 degrees. A biome's
   * character has to live in how fast it rises, not in where it starts.
   *
   * profile > 1 keeps a biome low and lifts it late (Fen is nearly flat at
   * 1.8); profile near 1 is linear. The §7 elevation bands describe the
   * resulting MEAN, which the legend reports so the two can be compared.
   */
  elevSpan: number;
  elevProfile: number;
  /**
   * The §7 elevation RANGE this biome covers: lowest ground to peak.
   *
   * CORRECTED IN M7. These were previously read as a band for the biome's
   * MEAN elevation, and drift was measured against them for three milestones.
   * That reading is wrong by construction, and provably so: `bandMax` equals
   * `elevSpan` for all nine biomes exactly, because §7's top number always WAS
   * the peak. A mean can never equal a maximum, so the top of every band was
   * unreachable and the metric was reporting
   *
   *     bandMin / elevSpan  >  shapeFactor
   *
   * which is a statement about how the roster was written, not about terrain.
   * Checked against the measured seedsInBand results: it predicts all eight
   * partitioned biomes exactly, including why Mountains and Ashlands "failed"
   * and Badlands was marginal.
   *
   * Nothing computes drift against these any more. `bandMax` is compared to
   * the measured p99 elevation (a peak against a peak) and `bandMin` is kept
   * as documentation of intent only.
   */
  bandMin: number;
  bandMax: number;
  /** M4: erosion resistance. 1 = fully weathered, 0 = untouched. */
  erodibility: number;
  /**
   * M4: tan(maximum stable slope) for thermal relaxation.
   *
   * Separate from erodibility, because they are separate rock properties and
   * collapsing them into one scalar made §7's hardEdge flag unachievable.
   * Derived as mix(talusHard, talusSoft, erodibility), a mesa rim at
   * erodibility 0.25 relaxed to 64 degrees, so Badlands rims washed out from
   * 87 deg to 74 within a single bake no matter how resistant the rock was.
   * Raising the global talusHard enough to hold them cut total erosion from
   * 1.99 m to 0.56 m, because the same number also governs how much resistant
   * biomes erode overall.
   *
   * Real rock does behave this way: resistance to dissolution and angle of
   * repose are independent. Sandstone dissolves readily and still stands in
   * vertical cliffs. Splitting them lets Badlands erode at 0.25 while holding
   * a near-vertical rim.
   */
  talusTan: number;
  /** M3: true = no geometric blend at this biome's borders. */
  hardEdge: boolean;
  /** M3: metres of geometric blend this biome wants at its borders.
   *  §5.3 specifies a full per-PAIR table; this reduces it to per-biome and
   *  takes min(a, b) for a pair. The pair table is the better model and can
   *  come back if two specific biomes ever need a width neither wants alone,
   *  but 8x8 hand-tuned numbers is a lot of knobs to earn first. */
  blendWidth: number;
  /** §3: false where sampleColumn() cannot describe the terrain honestly. */
  columnValid: boolean;
}

export const BIOME_UNASSIGNED = 0;
export const BIOME_OCEAN = 9;

export const BIOMES: readonly BiomeDef[] = [
  {
    id: 1, key: 'meadows', name: 'Meadows', colour: [126, 168, 88],
    weight: 1.6, radialMean: 0.16, radialWidth: 0.42,
    elevRankMean: 0.25, elevRankWidth: 0.48,
    forbid: ['ashlands', 'alien'],
    elevSpan: 40, elevProfile: 1.25, bandMin: 5, bandMax: 40, erodibility: 1.0, talusTan: 0.55, blendWidth: 115, hardEdge: false, columnValid: true,
  },
  {
    id: 2, key: 'blackforest', name: 'Blackforest', colour: [54, 94, 70],
    weight: 1.25, radialMean: 0.38, radialWidth: 0.46,
    elevRankMean: 0.5, elevRankWidth: 0.55,
    forbid: [],
    elevSpan: 140, elevProfile: 1.1, bandMin: 40, bandMax: 140, erodibility: 0.85, talusTan: 0.86, blendWidth: 115, hardEdge: false, columnValid: true,
  },
  {
    id: 3, key: 'mountains', name: 'Mountains', colour: [154, 159, 171],
    weight: 0.95, radialMean: 0.44, radialWidth: 0.5,
    elevRankMean: 0.9, elevRankWidth: 0.38,
    forbid: [],
    elevSpan: 600, elevProfile: 1.2, bandMin: 200, bandMax: 600, erodibility: 0.6, talusTan: 1.37, blendWidth: 145, hardEdge: false, columnValid: true,
  },
  {
    id: 4, key: 'karst', name: 'Karst', colour: [198, 190, 158],
    weight: 0.8, radialMean: 0.5, radialWidth: 0.5,
    elevRankMean: 0.32, elevRankWidth: 0.45,
    forbid: [],
    elevSpan: 60, elevProfile: 1.35, bandMin: 10, bandMax: 60, erodibility: 0.5, talusTan: 1.58, blendWidth: 100, hardEdge: false, columnValid: false,
  },
  {
    id: 5, key: 'badlands', name: 'Badlands', colour: [184, 112, 64],
    weight: 0.85, radialMean: 0.62, radialWidth: 0.4,
    elevRankMean: 0.68, elevRankWidth: 0.45,
    forbid: ['fen'],
    elevSpan: 250, elevProfile: 1.15, bandMin: 80, bandMax: 250, erodibility: 0.25, talusTan: 8.0, blendWidth: 70, hardEdge: true, columnValid: true,
  },
  {
    id: 6, key: 'fen', name: 'Fen', colour: [98, 102, 60],
    weight: 0.85, radialMean: 0.3, radialWidth: 0.44,
    elevRankMean: 0.1, elevRankWidth: 0.4,
    forbid: ['ashlands', 'badlands'],
    elevSpan: 15, elevProfile: 1.8, bandMin: -5, bandMax: 15, erodibility: 1.0, talusTan: 0.55, blendWidth: 125, hardEdge: false, columnValid: true,
  },
  {
    id: 7, key: 'ashlands', name: 'Ashlands', colour: [132, 58, 48],
    weight: 0.72, radialMean: 0.84, radialWidth: 0.3,
    elevRankMean: 0.8, elevRankWidth: 0.42,
    forbid: ['meadows', 'fen'],
    elevSpan: 450, elevProfile: 1.25, bandMin: 150, bandMax: 450, erodibility: 0.1, talusTan: 8.0, blendWidth: 70, hardEdge: true, columnValid: true,
  },
  {
    id: 8, key: 'alien', name: 'Alien', colour: [150, 96, 192],
    weight: 0.36, radialMean: 0.78, radialWidth: 0.36,
    elevRankMean: 0.5, elevRankWidth: 1.2,
    forbid: ['meadows'],
    elevSpan: 520, elevProfile: 1.0, bandMin: 0, bandMax: 520, erodibility: 0.0, talusTan: 14.0, blendWidth: 0, hardEdge: true, columnValid: false,
  },
  {
    // Derived at stage 9 from depth, never partitioned. Present so the legend
    // and colour lookup have a single source of truth.
    id: BIOME_OCEAN, key: 'ocean', name: 'Ocean', colour: [40, 86, 126],
    weight: 0.0, radialMean: 1, radialWidth: 1,
    elevRankMean: 0.0, elevRankWidth: 1.0,
    forbid: [],
    elevSpan: -10, elevProfile: 1.0, bandMin: -260, bandMax: -10, erodibility: 1.0, talusTan: 0.6, blendWidth: 110, hardEdge: false, columnValid: true,
  },
];

/** Biomes eligible for the Worley partition, in table order. */
export const PARTITIONED: readonly BiomeDef[] = BIOMES.filter((b) => b.weight > 0);

const BY_ID = new Map<number, BiomeDef>(BIOMES.map((b) => [b.id, b]));

export function biomeById(id: number): BiomeDef | undefined {
  return BY_ID.get(id);
}

/** Symmetric forbidden-adjacency lookup, built once from the `forbid` lists. */
const FORBIDDEN = (() => {
  const set = new Set<number>();
  const byKey = new Map(BIOMES.map((b) => [b.key, b.id]));
  for (const b of BIOMES) {
    for (const other of b.forbid) {
      const oid = byKey.get(other);
      if (oid === undefined) continue;
      set.add(pairKey(b.id, oid));
    }
  }
  return set;
})();

function pairKey(a: number, b: number): number {
  return a < b ? a * 256 + b : b * 256 + a;
}

export function isForbiddenPair(a: number, b: number): boolean {
  return a !== b && FORBIDDEN.has(pairKey(a, b));
}

/** RGB for a biome id; magenta marks an id that should not exist. */
export function biomeColour(id: number): readonly [number, number, number] {
  return BY_ID.get(id)?.colour ?? [255, 0, 255];
}
