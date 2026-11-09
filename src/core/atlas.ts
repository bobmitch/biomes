/**
 * Tier A — the Atlas. DESIGN.md §2.
 *
 * Structure-of-arrays over the bounding square of the 10 km disc. Holds
 * everything that needs global knowledge or expensive iteration. Cells outside
 * the disc are allocated but meaningless; the rim taper (§4 pass 1) drives them
 * to ocean floor, which is cheaper than masking every pass.
 */

export const BIOME_NONE = 0;

/** Bit flags in Atlas.flags. */
export const FLAG_OCEAN = 1 << 0;
export const FLAG_SHORE = 1 << 1;
export const FLAG_HARD_EDGE = 1 << 2;
export const FLAG_OUTSIDE = 1 << 3;

export class Atlas {
  readonly res: number;
  readonly worldRadius: number;
  /** Metres per cell. */
  readonly cellSize: number;

  // f32 fields
  readonly baseHeight: Float32Array;
  readonly flowAccum: Float32Array;
  readonly boundaryDist: Float32Array;
  readonly erodibility: Float32Array;
  /** tan(max stable slope), blended per cell. Thermal relaxation reads this
   *  instead of deriving it from erodibility — see BiomeDef.talusTan. */
  readonly talus: Float32Array;

  // u16 fields
  readonly biomeId: Uint16Array;
  /** Nearest FOREIGN biome — what this cell blends toward (DESIGN.md §5.3).
   *  Equals biomeId when the whole neighbourhood agrees (deep interior). */
  readonly biomeId2: Uint16Array;
  readonly biomeIdFinal: Uint16Array;
  readonly featureId: Uint16Array;
  readonly flags: Uint16Array;

  constructor(res: number, worldRadius: number) {
    const n = res * res;
    this.res = res;
    this.worldRadius = worldRadius;
    this.cellSize = (2 * worldRadius) / res;

    this.baseHeight = new Float32Array(n);
    this.flowAccum = new Float32Array(n);
    this.boundaryDist = new Float32Array(n);
    this.erodibility = new Float32Array(n);
    this.talus = new Float32Array(n);

    this.biomeId = new Uint16Array(n);
    this.biomeId2 = new Uint16Array(n);
    this.biomeIdFinal = new Uint16Array(n);
    this.featureId = new Uint16Array(n);
    this.flags = new Uint16Array(n);
  }

  get cellCount(): number {
    return this.res * this.res;
  }

  /** Allocated bytes, for the memory claim in DESIGN.md §2. */
  get bytes(): number {
    return this.cellCount * (5 * 4 + 5 * 2);
  }

  index(ix: number, iy: number): number {
    return iy * this.res + ix;
  }

  /** Cell centre in world metres. Origin is the disc centre. */
  worldX(ix: number): number {
    return -this.worldRadius + (ix + 0.5) * this.cellSize;
  }

  worldY(iy: number): number {
    return -this.worldRadius + (iy + 0.5) * this.cellSize;
  }

  /** World metres -> fractional cell coordinate. */
  cellX(wx: number): number {
    return (wx + this.worldRadius) / this.cellSize - 0.5;
  }

  cellY(wy: number): number {
    return (wy + this.worldRadius) / this.cellSize - 0.5;
  }

  /**
   * Bilinear height sample in world space. This is what Tier B reads —
   * the Analytic field never touches raw cells.
   */
  sampleHeight(wx: number, wy: number): number {
    const res = this.res;
    const fx = this.cellX(wx);
    const fy = this.cellY(wy);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const cx0 = x0 < 0 ? 0 : x0 >= res ? res - 1 : x0;
    const cy0 = y0 < 0 ? 0 : y0 >= res ? res - 1 : y0;
    const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= res ? res - 1 : x0 + 1;
    const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= res ? res - 1 : y0 + 1;
    const h = this.baseHeight;
    const a = h[cy0 * res + cx0];
    const b = h[cy0 * res + cx1];
    const c = h[cy1 * res + cx0];
    const d = h[cy1 * res + cx1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }

  /** Nearest-cell height, clamped. Used by the renderer's gradient. */
  heightAt(ix: number, iy: number): number {
    const res = this.res;
    const x = ix < 0 ? 0 : ix >= res ? res - 1 : ix;
    const y = iy < 0 ? 0 : iy >= res ? res - 1 : iy;
    return this.baseHeight[y * res + x];
  }
}
