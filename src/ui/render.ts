/**
 * Atlas -> ImageData. Display tier: nothing here touches the bake, so every
 * control in this file redraws in a few ms (DESIGN.md §10).
 */

import { Atlas } from '../core/atlas';
import { biomeColour } from '../core/biomes';
import { clamp01, smoothstep } from '../core/math';
import type { WorldParams } from '../core/params';

export type LayerName =
  | 'hypsometric'
  | 'grayscale'
  | 'slope'
  | 'landmask'
  | 'biome'
  | 'boundary'
  | 'erodibility'
  | 'flow'
  | 'diff';

export interface RenderOptions {
  layer: LayerName;
  hillshade: boolean;
  sunAzimuth: number;
  sunAltitude: number;
  exaggeration: number;
  contours: boolean;
  contourInterval: number;
  shoreLine: boolean;
  /** Draw a 1-sample biome border on any layer — the §5.3 material cut. */
  biomeBorders: boolean;
  /** Show ocean as water in the biome layer rather than the raw partition. */
  maskOcean: boolean;
  /** Metres shown as full white in the boundary-distance layer. */
  boundaryScale: number;
  /** Which stage snapshot to display; null = final. */
  snapshot: Float32Array | null;
  /**
   * Baseline for the 'diff' layer: the height field as of the PREVIOUS stage.
   * The diff layer answers "what did this stage actually change", which the
   * stage scrubber alone cannot — two consecutive snapshots often look
   * identical by eye while differing by metres in a few places.
   */
  diffBase: Float32Array | null;
  /** Metres mapped to full saturation in the diff layer. */
  diffScale: number;
}

export const DEFAULT_RENDER: RenderOptions = {
  layer: 'biome',
  hillshade: true,
  sunAzimuth: 315,
  sunAltitude: 42,
  exaggeration: 2.2,
  contours: false,
  contourInterval: 50,
  shoreLine: true,
  biomeBorders: false,
  maskOcean: true,
  boundaryScale: 400,
  snapshot: null,
  diffBase: null,
  diffScale: 12,
};

type Stop = readonly [number, number, number, number];

// Depth and elevation ramp. Deliberately desaturated — this is an instrument,
// not concept art, and saturated ramps hide the shape of the terrain.
const OCEAN: Stop[] = [
  [-260, 6, 14, 32],
  [-150, 11, 30, 62],
  [-60, 19, 55, 99],
  [-18, 31, 86, 136],
  [0, 54, 119, 163],
];

const LAND: Stop[] = [
  [0, 206, 196, 158],
  [12, 142, 160, 104],
  [45, 94, 134, 80],
  [120, 72, 112, 64],
  [210, 110, 104, 80],
  [310, 146, 138, 124],
  [400, 196, 196, 196],
  [500, 238, 242, 246],
];

function rampLookup(stops: Stop[], v: number, out: [number, number, number]): void {
  if (v <= stops[0][0]) {
    out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3];
    return;
  }
  const last = stops[stops.length - 1];
  if (v >= last[0]) {
    out[0] = last[1]; out[1] = last[2]; out[2] = last[3];
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (v <= b[0]) {
      const a = stops[i - 1];
      const t = (v - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * t;
      out[1] = a[2] + (b[2] - a[2]) * t;
      out[2] = a[3] + (b[3] - a[3]) * t;
      return;
    }
  }
}

export function renderAtlas(
  atlas: Atlas,
  p: WorldParams,
  o: RenderOptions,
  img: ImageData,
): void {
  const res = atlas.res;
  const data = img.data;
  const field = o.snapshot ?? atlas.baseHeight;
  const cell = atlas.cellSize;
  const sea = p.seaLevel;

  const az = (o.sunAzimuth * Math.PI) / 180;
  const alt = (o.sunAltitude * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.sin(az);
  const ly = -Math.cos(alt) * Math.cos(az);
  const lz = Math.sin(alt);

  const rgb: [number, number, number] = [0, 0, 0];
  const invContour = 1 / Math.max(1, o.contourInterval);
  const biome = atlas.biomeId;
  const bdist = atlas.boundaryDist;
  const erod = atlas.erodibility;
  const flow = atlas.flowAccum;
  // Log scale: drainage spans orders of magnitude and a linear ramp shows
  // only the trunk channels.
  let flowMax = 0;
  for (let k = 0; k < flow.length; k++) if (flow[k] > flowMax) flowMax = flow[k];
  const flowNorm = 1 / Math.log1p(Math.max(1e-6, flowMax));

  const at = (ix: number, iy: number): number => {
    const x = ix < 0 ? 0 : ix >= res ? res - 1 : ix;
    const y = iy < 0 ? 0 : iy >= res ? res - 1 : iy;
    return field[y * res + x];
  };

  const biomeAt = (ix: number, iy: number): number => {
    const x = ix < 0 ? 0 : ix >= res ? res - 1 : ix;
    const y = iy < 0 ? 0 : iy >= res ? res - 1 : iy;
    return biome[y * res + x];
  };

  for (let iy = 0; iy < res; iy++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iy * res + ix;
      const h = field[i];

      // Central-difference gradient in metres per metre.
      const dzdx = ((at(ix + 1, iy) - at(ix - 1, iy)) / (2 * cell)) * o.exaggeration;
      const dzdy = ((at(ix, iy + 1) - at(ix, iy - 1)) / (2 * cell)) * o.exaggeration;

      switch (o.layer) {
        case 'hypsometric': {
          if (h < sea) rampLookup(OCEAN, h, rgb);
          else rampLookup(LAND, h, rgb);
          break;
        }
        case 'grayscale': {
          const t = clamp01((h + 260) / 760);
          rgb[0] = rgb[1] = rgb[2] = 18 + t * 230;
          break;
        }
        case 'slope': {
          const slope = Math.atan(Math.hypot(dzdx, dzdy) / o.exaggeration);
          const t = clamp01(slope / (Math.PI * 0.42));
          rgb[0] = 20 + t * 232;
          rgb[1] = 24 + t * 150;
          rgb[2] = 32 + t * 60;
          break;
        }
        case 'landmask': {
          if (h >= sea) { rgb[0] = 198; rgb[1] = 196; rgb[2] = 180; }
          else { rgb[0] = 16; rgb[1] = 28; rgb[2] = 48; }
          break;
        }
        case 'biome': {
          if (o.maskOcean && h < sea) {
            // Stage 9 will make this a real biome id. Until then the ocean is
            // drawn from depth so the partition reads against a familiar map.
            rampLookup(OCEAN, h, rgb);
          } else {
            const c = biomeColour(biome[i]);
            rgb[0] = c[0]; rgb[1] = c[1]; rgb[2] = c[2];
          }
          break;
        }
        case 'erodibility': {
          // 0 (untouched by weather) -> 1 (fully weathered). This is the
          // field the §6 erosion bet runs on, so it gets to be looked at.
          const t = clamp01(erod[i]);
          rgb[0] = 210 - t * 150;
          rgb[1] = 90 + t * 110;
          rgb[2] = 60 + t * 150;
          break;
        }
        case 'flow': {
          const t = clamp01(Math.log1p(flow[i]) * flowNorm);
          rgb[0] = 12 + t * 90;
          rgb[1] = 20 + t * 150;
          rgb[2] = 34 + t * 215;
          break;
        }
        case 'diff': {
          const d = o.diffBase ? h - o.diffBase[i] : 0;
          const t = clamp01(Math.abs(d) / Math.max(0.01, o.diffScale));
          if (d > 0) { rgb[0] = 24 + t * 220; rgb[1] = 26 + t * 90; rgb[2] = 30; }
          else if (d < 0) { rgb[0] = 24; rgb[1] = 30 + t * 110; rgb[2] = 34 + t * 215; }
          else { rgb[0] = 22; rgb[1] = 24; rgb[2] = 28; }
          break;
        }
        case 'boundary': {
          // How far this sample is from the nearest foreign region. This is
          // the field §5.3 blends on, so being able to look at it directly is
          // the point of having it as a layer.
          const t = clamp01(bdist[i] / Math.max(1, o.boundaryScale));
          rgb[0] = 14 + t * 200;
          rgb[1] = 18 + t * 210;
          rgb[2] = 28 + t * 190;
          break;
        }
      }

      if (o.hillshade) {
        const nx = -dzdx;
        const ny = -dzdy;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        let lam = (nx * lx + ny * ly + lz) * inv;
        if (lam < 0) lam = 0;
        // Underwater gets a flatter shade; seafloor relief otherwise shouts
        // louder than the land, which is backwards for auditioning coastlines.
        const strength = h < sea ? 0.45 : 1;
        const shade = 1 - strength + strength * (0.3 + 0.78 * lam);
        rgb[0] *= shade; rgb[1] *= shade; rgb[2] *= shade;
      }

      if (o.contours && h > sea) {
        const b = Math.floor(h * invContour);
        if (b !== Math.floor(at(ix + 1, iy) * invContour) ||
            b !== Math.floor(at(ix, iy + 1) * invContour)) {
          rgb[0] *= 0.62; rgb[1] *= 0.62; rgb[2] *= 0.62;
        }
      }

      // The material cut from §5.3: exactly one sample wide, never blended,
      // regardless of what the geometry does at the same border.
      if (o.biomeBorders) {
        const b0 = biome[i];
        if (b0 !== biomeAt(ix + 1, iy) || b0 !== biomeAt(ix, iy + 1)) {
          rgb[0] = 12; rgb[1] = 12; rgb[2] = 14;
        }
      }

      if (o.shoreLine) {
        const e = smoothstep(2.5, 0, Math.abs(h - sea));
        if (e > 0) {
          rgb[0] += (250 - rgb[0]) * e * 0.75;
          rgb[1] += (248 - rgb[1]) * e * 0.75;
          rgb[2] += (236 - rgb[2]) * e * 0.75;
        }
      }

      const o4 = i * 4;
      data[o4] = rgb[0];
      data[o4 + 1] = rgb[1];
      data[o4 + 2] = rgb[2];
      data[o4 + 3] = 255;
    }
  }
}
