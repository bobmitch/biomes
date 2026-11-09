/**
 * Stage 5 erosion kernels — DESIGN.md §6.
 *
 * Virtual-pipe hydraulic erosion (Mei et al. 2007) plus thermal relaxation.
 * The pipe model is chosen over droplet erosion because it is embarrassingly
 * parallel — every cell reads its four neighbours and writes only itself —
 * where droplets need scattered read-modify-write and would serialise.
 *
 * WHERE §6's BET ACTUALLY LIVES
 *
 * `erodibility` gates two separate mechanisms, and both matter:
 *
 *   1. DISSOLUTION RATE (erode_pass). Resistant rock gives up material more
 *      slowly. This is the obvious one.
 *   2. TALUS ANGLE (thermal_flux). Resistant rock holds a steeper stable
 *      slope. This is the one that decides whether the §7 hardEdge biomes
 *      keep their rims, because thermal relaxation is what rounds a sharp
 *      edge off. Gating only dissolution would let Badlands mesas survive
 *      vertically while still slumping into cones.
 *
 * Deposition is deliberately NOT gated. Sediment that has already been
 * carried and dropped is loose material; how resistant the bedrock under it
 * happens to be says nothing about it. Gating deposition too would make
 * resistant biomes inert rather than resistant, which would pass the §6 test
 * for the wrong reason.
 */

export const EROSION_WGSL = /* wgsl */ `
struct Params {
  res         : u32,
  cellSize    : f32,
  dt          : f32,
  rain        : f32,
  evaporation : f32,
  capacity    : f32,
  dissolve    : f32,
  deposit     : f32,
  minTilt     : f32,
  talusSoft   : f32,
  talusHard   : f32,
  thermalRate : f32,
  seaLevel    : f32,
  minWater    : f32,
  maxVelocity : f32,
  maxCapacity : f32,
  maxDelta    : f32,
  _pad0       : f32,
  _pad1       : f32,
  _pad2       : f32,
};

@group(0) @binding(0) var<storage, read_write> height       : array<f32>;
@group(0) @binding(1) var<storage, read_write> water        : array<f32>;
@group(0) @binding(2) var<storage, read_write> sediment     : array<f32>;
@group(0) @binding(3) var<storage, read_write> sedimentNext : array<f32>;
@group(0) @binding(4) var<storage, read_write> flux         : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> velocity     : array<vec2<f32>>;
@group(0) @binding(6) var<storage, read>       erodibility  : array<f32>;
@group(0) @binding(7) var<storage, read_write> flowAccum    : array<f32>;
@group(1) @binding(0) var<uniform>             P            : Params;

fn idx(x: u32, y: u32) -> u32 { return y * P.res + x; }

// ---------------------------------------------------------------- pass 1
// Rain, then outflow flux to the four neighbours, scaled so a cell can never
// export more water than it holds.
@compute @workgroup_size(16, 16)
fn flux_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);

  let h = height[i];
  // Rain on land only. Raining on the sea just burns simulation on water
  // that can never carve anything.
  var w = water[i];
  if (h > P.seaLevel) { w = w + P.rain * P.dt; }
  let hw = h + w;

  let g = 9.81;
  let l = P.cellSize;
  let area = l * l;
  let f = flux[i];
  var outf = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  if (gid.x > 0u) {
    let j = i - 1u;
    outf.x = max(0.0, f.x + P.dt * area * g * (hw - (height[j] + water[j])) / l);
  }
  if (gid.x + 1u < res) {
    let j = i + 1u;
    outf.y = max(0.0, f.y + P.dt * area * g * (hw - (height[j] + water[j])) / l);
  }
  if (gid.y > 0u) {
    let j = i - res;
    outf.z = max(0.0, f.z + P.dt * area * g * (hw - (height[j] + water[j])) / l);
  }
  if (gid.y + 1u < res) {
    let j = i + res;
    outf.w = max(0.0, f.w + P.dt * area * g * (hw - (height[j] + water[j])) / l);
  }

  let total = outf.x + outf.y + outf.z + outf.w;
  if (total > 0.0) {
    outf = outf * min(1.0, w * area / (total * P.dt));
  }
  flux[i] = outf;
  water[i] = w;
}

// ---------------------------------------------------------------- pass 2
// Apply net flux to water depth, derive velocity, accumulate drainage.
@compute @workgroup_size(16, 16)
fn update_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);

  let fo = flux[i];
  var inL = 0.0; var inR = 0.0; var inT = 0.0; var inB = 0.0;
  if (gid.x > 0u)        { inL = flux[i - 1u].y; }
  if (gid.x + 1u < res)  { inR = flux[i + 1u].x; }
  if (gid.y > 0u)        { inT = flux[i - res].w; }
  if (gid.y + 1u < res)  { inB = flux[i + res].z; }

  let outflow = fo.x + fo.y + fo.z + fo.w;
  let inflow = inL + inR + inT + inB;
  let area = P.cellSize * P.cellSize;

  let w0 = water[i];
  let w1 = max(0.0, w0 + P.dt * (inflow - outflow) / area);
  water[i] = w1;

  let wavg = max(P.minWater, 0.5 * (w0 + w1));
  let dWx = 0.5 * (inL - fo.x + fo.y - inR);
  let dWy = 0.5 * (inT - fo.z + fo.w - inB);
  // Velocity divides by water depth, so a steep cell holding a film of water
  // produces hundreds of m/s and capacity runs away from there. Without this
  // clamp the whole simulation reached 1e31 within a single iteration.
  var vel = vec2<f32>(dWx / (P.cellSize * wavg), dWy / (P.cellSize * wavg));
  let speed = length(vel);
  if (speed > P.maxVelocity) { vel = vel * (P.maxVelocity / speed); }
  velocity[i] = vel;

  // Drainage proxy for stage 6 and for the drainage-density metric: how much
  // water passed through this cell over the whole run, not how much sits here
  // at the end.
  flowAccum[i] = flowAccum[i] + w1;
}

// ---------------------------------------------------------------- pass 3
// Erosion and deposition. This is mechanism 1 of §6's bet.
@compute @workgroup_size(16, 16)
fn erode_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);

  let xm = select(gid.x - 1u, gid.x, gid.x == 0u);
  let xp = select(gid.x + 1u, gid.x, gid.x + 1u >= res);
  let ym = select(gid.y - 1u, gid.y, gid.y == 0u);
  let yp = select(gid.y + 1u, gid.y, gid.y + 1u >= res);

  let dzdx = (height[idx(xp, gid.y)] - height[idx(xm, gid.y)]) / (2.0 * P.cellSize);
  let dzdy = (height[idx(gid.x, yp)] - height[idx(gid.x, ym)]) / (2.0 * P.cellSize);
  let slope = sqrt(dzdx * dzdx + dzdy * dzdy);
  let sinTilt = slope / sqrt(1.0 + slope * slope);

  let v = length(velocity[i]);
  // Shallow water carries nothing; without this, a film of water one step
  // after rain erodes flat ground everywhere.
  let wet = clamp(water[i] / P.minWater, 0.0, 1.0);
  let capacity = min(P.maxCapacity, P.capacity * max(P.minTilt, sinTilt) * v * wet);

  let s = sediment[i];
  let h = height[i];

  if (capacity > s && h > P.seaLevel) {
    // Dissolution: gated by erodibility.
    let amt = clamp(P.dissolve * erodibility[i] * (capacity - s) * P.dt, 0.0, P.maxDelta);
    height[i] = h - amt;
    sediment[i] = s + amt;
  } else {
    // Deposition: NOT gated — see this file's header.
    let amt = clamp(P.deposit * (s - capacity) * P.dt, 0.0, P.maxDelta);
    height[i] = h + amt;
    sediment[i] = max(0.0, s - amt);
  }
}

// ---------------------------------------------------------------- pass 4
// Semi-Lagrangian sediment transport.
fn sampleSediment(px: f32, py: f32) -> f32 {
  let res = P.res;
  let maxc = f32(res) - 1.001;
  let cx = clamp(px, 0.0, maxc);
  let cy = clamp(py, 0.0, maxc);
  let fx = floor(cx);
  let fy = floor(cy);
  let x0 = u32(fx);
  let y0 = u32(fy);
  let x1 = min(x0 + 1u, res - 1u);
  let y1 = min(y0 + 1u, res - 1u);
  let tx = cx - fx;
  let ty = cy - fy;
  let a = sediment[idx(x0, y0)];
  let b = sediment[idx(x1, y0)];
  let c = sediment[idx(x0, y1)];
  let d = sediment[idx(x1, y1)];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

@compute @workgroup_size(16, 16)
fn advect_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);
  let v = velocity[i];
  sedimentNext[i] = sampleSediment(
    f32(gid.x) - v.x * P.dt / P.cellSize,
    f32(gid.y) - v.y * P.dt / P.cellSize,
  );
}

// ---------------------------------------------------------------- pass 5
@compute @workgroup_size(16, 16)
fn finalize_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);
  sediment[i] = sedimentNext[i];
  water[i] = water[i] * (1.0 - P.evaporation * P.dt);
}
`;

/**
 * Thermal relaxation. Separate module and separate bind group because it
 * needs only three buffers; sharing the hydraulic layout would put the
 * pipeline at nine storage buffers, over this adapter's limit of eight.
 */
export const THERMAL_WGSL = /* wgsl */ `
struct Params {
  res         : u32,
  cellSize    : f32,
  dt          : f32,
  rain        : f32,
  evaporation : f32,
  capacity    : f32,
  dissolve    : f32,
  deposit     : f32,
  minTilt     : f32,
  talusSoft   : f32,
  talusHard   : f32,
  thermalRate : f32,
  seaLevel    : f32,
  minWater    : f32,
  maxVelocity : f32,
  maxCapacity : f32,
  maxDelta    : f32,
  _pad0       : f32,
  _pad1       : f32,
  _pad2       : f32,
};

@group(0) @binding(0) var<storage, read_write> height      : array<f32>;
@group(0) @binding(1) var<storage, read>       talus       : array<f32>;
@group(0) @binding(2) var<storage, read_write> scratch     : array<vec4<f32>>;
@group(1) @binding(0) var<uniform>             P           : Params;

fn idx(x: u32, y: u32) -> u32 { return y * P.res + x; }

// Mechanism 2 of §6's bet: resistant rock holds a steeper stable slope, so a
// mesa rim survives instead of slumping into a cone.
@compute @workgroup_size(16, 16)
fn thermal_flux(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);
  let h = height[i];

  var out = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (h <= P.seaLevel) { scratch[i] = out; return; }

  // Per-cell stable slope, authored per biome rather than derived from
  // erodibility — the two are independent rock properties.
  let maxDrop = talus[i] * P.cellSize;

  var dmax = 0.0;
  if (gid.x > 0u) {
    let d = h - height[i - 1u];  out.x = max(0.0, d - maxDrop); dmax = max(dmax, d);
  }
  if (gid.x + 1u < res) {
    let d = h - height[i + 1u];  out.y = max(0.0, d - maxDrop); dmax = max(dmax, d);
  }
  if (gid.y > 0u) {
    let d = h - height[i - res]; out.z = max(0.0, d - maxDrop); dmax = max(dmax, d);
  }
  if (gid.y + 1u < res) {
    let d = h - height[i + res]; out.w = max(0.0, d - maxDrop); dmax = max(dmax, d);
  }

  let total = out.x + out.y + out.z + out.w;
  if (total > 0.0) {
    // Move at most HALF THE LARGEST excess, not a fraction of their SUM.
    //
    // Summing across four directions lets a cell shed more than it was ever
    // above its neighbours — four excesses of 9 m sum to 36, half of which
    // is 18, so a cell 10 m proud drops 8 m below the ground around it. The
    // next step reverses it, larger. That oscillation is what reached 1e31;
    // the per-step erosion clamps could not catch it because the divergence
    // was never in the hydraulic passes at all.
    let allowed = P.thermalRate * 0.5 * max(0.0, dmax - maxDrop);
    out = out * (min(total, allowed) / total);
  }
  scratch[i] = out;
}

@compute @workgroup_size(16, 16)
fn thermal_apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = P.res;
  if (gid.x >= res || gid.y >= res) { return; }
  let i = idx(gid.x, gid.y);

  let mine = scratch[i];
  var delta = -(mine.x + mine.y + mine.z + mine.w);
  if (gid.x > 0u)       { delta = delta + scratch[i - 1u].y; }
  if (gid.x + 1u < res) { delta = delta + scratch[i + 1u].x; }
  if (gid.y > 0u)       { delta = delta + scratch[i - res].w; }
  if (gid.y + 1u < res) { delta = delta + scratch[i + res].z; }
  height[i] = height[i] + delta;
}
`;
