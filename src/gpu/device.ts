/**
 * WebGPU device, acquired once and shared.
 *
 * DESIGN.md §1 said the heavy math would move to WGSL compute "if needed";
 * M1 measured 3.3 s for one CPU pass at 2048², and stage 5 runs that kind of
 * work a hundred times over, so it is needed.
 */

export interface GpuContext {
  device: GPUDevice;
  adapterInfo: string;
  limits: {
    maxStorageBufferBindingSize: number;
    maxComputeInvocationsPerWorkgroup: number;
    maxStorageBuffersPerShaderStage: number;
  };
}

let cached: GpuContext | null = null;
let failure: string | null = null;

export async function getGpu(): Promise<GpuContext | null> {
  if (cached) return cached;
  if (failure) return null;

  if (!('gpu' in navigator)) {
    failure = 'navigator.gpu missing (no WebGPU)';
    return null;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { failure = 'no GPU adapter'; return null; }
    const device = await adapter.requestDevice();
    device.lost.then((info) => {
      failure = `device lost: ${info.reason}`;
      cached = null;
    });
    cached = {
      device,
      adapterInfo: 'webgpu',
      limits: {
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup,
        maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage,
      },
    };
    return cached;
  } catch (e) {
    failure = String(e);
    return null;
  }
}

export function gpuFailure(): string | null {
  return failure;
}
