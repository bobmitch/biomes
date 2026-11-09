/**
 * Stage 5 — Global erosion. DESIGN.md §4, §6.
 *
 * Writes: baseHeight, flowAccum.
 *
 * Runs on the GPU. One CPU pass at 2048² measured 3.3 s in M1 and this runs
 * ~6 kernels per iteration for a hundred-plus iterations, so there is no CPU
 * version to fall back to — if WebGPU is unavailable the stage reports that
 * and leaves the terrain untouched rather than pretending.
 *
 * Erosion is global and unconditional, exactly as §6 argues it must be. What
 * varies per biome is material resistance, carried in the `erodibility` field
 * that stage 4 already wrote. Nothing here knows what a biome is.
 */

import { Atlas } from '../atlas';
import type { WorldParams } from '../params';
import { getGpu, gpuFailure } from '../../gpu/device';
import { EROSION_WGSL, THERMAL_WGSL } from '../../gpu/erosionShaders';

export const PASS_EROSION = 5;

export const erosionStats = {
  ran: false,
  reason: '' as string,
  iterations: 0,
  gpuMs: 0,
  readbackMs: 0,
  /** Mean |height change| over land, metres. */
  meanAbsDelta: 0,
  /** Net mean height change — near zero means material was moved, not lost. */
  netDelta: 0,
};

const WG = 16;

function uniformData(p: WorldParams, atlas: Atlas): ArrayBuffer {
  const buf = new ArrayBuffer(80);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  u32[0] = atlas.res;
  f32[1] = atlas.cellSize;
  f32[2] = p.eroDt;
  f32[3] = p.eroRain;
  f32[4] = p.eroEvaporation;
  f32[5] = p.eroCapacity;
  f32[6] = p.eroDissolve;
  f32[7] = p.eroDeposit;
  f32[8] = p.eroMinTilt;
  f32[9] = p.eroTalusSoft;
  f32[10] = p.eroTalusHard;
  f32[11] = p.eroThermalRate;
  f32[12] = p.seaLevel;
  f32[13] = p.eroMinWater;
  f32[14] = p.eroMaxVelocity;
  f32[15] = p.eroMaxCapacity;
  f32[16] = p.eroMaxDelta;
  return buf;
}

export async function globalErosion(atlas: Atlas, p: WorldParams): Promise<void> {
  erosionStats.ran = false;
  erosionStats.reason = '';
  erosionStats.iterations = 0;
  erosionStats.gpuMs = 0;
  erosionStats.readbackMs = 0;
  erosionStats.meanAbsDelta = 0;
  erosionStats.netDelta = 0;

  if (p.eroIterations <= 0) {
    erosionStats.reason = 'iterations = 0';
    return;
  }

  const gpu = await getGpu();
  if (!gpu) {
    erosionStats.reason = gpuFailure() ?? 'WebGPU unavailable';
    return;
  }
  const { device } = gpu;

  const n = atlas.cellCount;
  const res = atlas.res;
  const before = new Float32Array(atlas.baseHeight);

  const t0 = performance.now();

  // --- buffers -----------------------------------------------------------
  const mk = (bytes: number, extra: GPUBufferUsageFlags = 0): GPUBuffer =>
    device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | extra });

  const fBytes = n * 4;
  const heightBuf = mk(fBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
  const waterBuf = mk(fBytes);
  const sedBuf = mk(fBytes);
  const sedNextBuf = mk(fBytes);
  const fluxBuf = mk(n * 16);
  const velBuf = mk(n * 8);
  const erodBuf = mk(fBytes, GPUBufferUsage.COPY_DST);
  const flowBuf = mk(fBytes, GPUBufferUsage.COPY_SRC);
  const talusBuf = mk(fBytes, GPUBufferUsage.COPY_DST);
  const thermalBuf = mk(n * 16);

  const uniform = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(heightBuf, 0, before.buffer as ArrayBuffer, before.byteOffset, before.byteLength);
  // The §6 bracket test substitutes a constant field for the real one.
  const erodSrc =
    p.eroErodibilityOverride >= 0
      ? new Float32Array(n).fill(p.eroErodibilityOverride)
      : atlas.erodibility;
  device.queue.writeBuffer(erodBuf, 0, erodSrc.buffer as ArrayBuffer, erodSrc.byteOffset, erodSrc.byteLength);
  const talusSrc = atlas.talus;
  device.queue.writeBuffer(talusBuf, 0, talusSrc.buffer as ArrayBuffer, talusSrc.byteOffset, talusSrc.byteLength);
  device.queue.writeBuffer(uniform, 0, uniformData(p, atlas));

  // --- pipelines ---------------------------------------------------------
  // EXPLICIT bind group layouts, not `layout: "auto"`.
  //
  // With "auto", each pipeline's layout contains only the bindings that
  // shader actually references — finalize_pass touches three of the eight —
  // so binding all eight against it is a validation error. WebGPU reports
  // that asynchronously and discards the command buffer, which meant the
  // readback returned a zero-filled staging buffer and the stage silently
  // produced flat terrain. The bracket test caught it; nothing else would
  // have, because "all heights became 0" still looks like a plausible number
  // until you check that it equals mean land elevation exactly.
  device.pushErrorScope('validation');

  const storageEntry = (binding: number, readOnly: boolean): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? ('read-only-storage' as const) : ('storage' as const) },
  });

  const hydroLayout = device.createBindGroupLayout({
    entries: [
      storageEntry(0, false), storageEntry(1, false), storageEntry(2, false),
      storageEntry(3, false), storageEntry(4, false), storageEntry(5, false),
      storageEntry(6, true), storageEntry(7, false),
    ],
  });
  const thermalLayout = device.createBindGroupLayout({
    entries: [storageEntry(0, false), storageEntry(1, true), storageEntry(2, false)],
  });
  const uniformLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform' as const },
    }],
  });

  const hydroModule = device.createShaderModule({ code: EROSION_WGSL });
  const thermalModule = device.createShaderModule({ code: THERMAL_WGSL });

  const hydroPl = device.createPipelineLayout({
    bindGroupLayouts: [hydroLayout, uniformLayout],
  });
  const thermalPl = device.createPipelineLayout({
    bindGroupLayouts: [thermalLayout, uniformLayout],
  });

  const hydroPipe = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ layout: hydroPl, compute: { module: hydroModule, entryPoint } });
  const thermalPipe = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ layout: thermalPl, compute: { module: thermalModule, entryPoint } });

  const pFlux = hydroPipe('flux_pass');
  const pUpdate = hydroPipe('update_pass');
  const pErode = hydroPipe('erode_pass');
  const pAdvect = hydroPipe('advect_pass');
  const pFinal = hydroPipe('finalize_pass');
  const pThermalFlux = thermalPipe('thermal_flux');
  const pThermalApply = thermalPipe('thermal_apply');

  // One bind group each, shared by every pipeline using that layout.
  const hydroBind = device.createBindGroup({
    layout: hydroLayout,
    entries: [
      { binding: 0, resource: { buffer: heightBuf } },
      { binding: 1, resource: { buffer: waterBuf } },
      { binding: 2, resource: { buffer: sedBuf } },
      { binding: 3, resource: { buffer: sedNextBuf } },
      { binding: 4, resource: { buffer: fluxBuf } },
      { binding: 5, resource: { buffer: velBuf } },
      { binding: 6, resource: { buffer: erodBuf } },
      { binding: 7, resource: { buffer: flowBuf } },
    ],
  });
  const thermalBind = device.createBindGroup({
    layout: thermalLayout,
    entries: [
      { binding: 0, resource: { buffer: heightBuf } },
      { binding: 1, resource: { buffer: talusBuf } },
      { binding: 2, resource: { buffer: thermalBuf } },
    ],
  });
  const uniformBind = device.createBindGroup({
    layout: uniformLayout,
    entries: [{ binding: 0, resource: { buffer: uniform } }],
  });

  const groups = Math.ceil(res / WG);
  const encoder = device.createCommandEncoder();

  const run = (
    pass: GPUComputePassEncoder, pipe: GPUComputePipeline, bind: GPUBindGroup,
  ): void => {
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.setBindGroup(1, uniformBind);
    pass.dispatchWorkgroups(groups, groups);
  };

  const pass = encoder.beginComputePass();
  for (let it = 0; it < p.eroIterations; it++) {
    run(pass, pFlux, hydroBind);
    run(pass, pUpdate, hydroBind);
    run(pass, pErode, hydroBind);
    run(pass, pAdvect, hydroBind);
    run(pass, pFinal, hydroBind);
    if (p.eroThermalEvery > 0 && it % p.eroThermalEvery === 0) {
      run(pass, pThermalFlux, thermalBind);
      run(pass, pThermalApply, thermalBind);
    }
  }
  pass.end();

  // --- readback ----------------------------------------------------------
  const stageH = device.createBuffer({
    size: fBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const stageF = device.createBuffer({
    size: fBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyBufferToBuffer(heightBuf, 0, stageH, 0, fBytes);
  encoder.copyBufferToBuffer(flowBuf, 0, stageF, 0, fBytes);
  device.queue.submit([encoder.finish()]);

  const tSubmit = performance.now();
  const validationError = await device.popErrorScope();
  if (validationError) {
    erosionStats.reason = `GPU validation: ${validationError.message}`;
    return;
  }
  await device.queue.onSubmittedWorkDone();
  erosionStats.gpuMs = performance.now() - tSubmit;

  const tRead = performance.now();
  await stageH.mapAsync(GPUMapMode.READ);
  await stageF.mapAsync(GPUMapMode.READ);
  atlas.baseHeight.set(new Float32Array(stageH.getMappedRange()));
  atlas.flowAccum.set(new Float32Array(stageF.getMappedRange()));
  stageH.unmap();
  stageF.unmap();
  erosionStats.readbackMs = performance.now() - tRead;

  for (const b of [heightBuf, waterBuf, sedBuf, sedNextBuf, fluxBuf, velBuf,
    erodBuf, flowBuf, talusBuf, thermalBuf, uniform, stageH, stageF]) b.destroy();

  // --- summary -----------------------------------------------------------
  let absSum = 0;
  let netSum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (before[i] <= p.seaLevel) continue;
    const d = atlas.baseHeight[i] - before[i];
    absSum += Math.abs(d);
    netSum += d;
    count++;
  }
  erosionStats.ran = true;
  erosionStats.iterations = p.eroIterations;
  erosionStats.meanAbsDelta = count ? absSum / count : 0;
  erosionStats.netDelta = count ? netSum / count : 0;
  void t0;
}
