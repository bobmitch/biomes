/**
 * Top-down map — the primary audit view (DESIGN.md §10).
 * Pan with drag, zoom at cursor with the wheel, live height readout.
 */

import { Atlas } from '../core/atlas';
import type { WorldParams } from '../core/params';

export interface Cursor {
  wx: number;
  wy: number;
  height: number;
  biomeId: number;
  boundaryDist: number;
  inside: boolean;
}

export class MapView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;

  private atlas: Atlas | null = null;
  private params: WorldParams | null = null;
  private field: Float32Array | null = null;

  /** Screen pixels per atlas cell. */
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private fitted = false;

  onCursor: ((c: Cursor | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;

    this.buffer = document.createElement('canvas');
    const bctx = this.buffer.getContext('2d');
    if (!bctx) throw new Error('2d buffer context unavailable');
    this.bufferCtx = bctx;

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => this.onCursor?.(null));
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setAtlas(atlas: Atlas, params: WorldParams, img: ImageData, field: Float32Array): void {
    this.atlas = atlas;
    this.params = params;
    this.field = field;
    const resChanged = this.buffer.width !== atlas.res;
    if (resChanged) {
      this.buffer.width = atlas.res;
      this.buffer.height = atlas.res;
    }
    this.bufferCtx.putImageData(img, 0, 0);
    // Zoom is screen pixels per atlas cell, so a resolution change would
    // otherwise appear as a 2x jump in world scale.
    if (!this.fitted || resChanged) {
      this.fit();
      this.fitted = true;
    }
    this.draw();
  }

  /** Swap pixels without touching the camera — used on display-tier changes. */
  setImage(img: ImageData, field: Float32Array): void {
    this.field = field;
    this.bufferCtx.putImageData(img, 0, 0);
    this.draw();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  fit(): void {
    if (!this.atlas) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.zoom = (Math.min(w, h) * 0.94) / this.atlas.res;
    this.panX = (w - this.atlas.res * this.zoom) / 2;
    this.panY = (h - this.atlas.res * this.zoom) / 2;
    this.draw();
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onUp = (): void => {
    this.dragging = false;
  };

  private onMove = (e: PointerEvent): void => {
    if (this.dragging) {
      this.panX += e.clientX - this.lastX;
      this.panY += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.draw();
    }
    this.emitCursor(e);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0014);
    const next = Math.min(24, Math.max(0.05, this.zoom * factor));
    const k = next / this.zoom;
    this.panX = mx - (mx - this.panX) * k;
    this.panY = my - (my - this.panY) * k;
    this.zoom = next;
    this.draw();
    this.emitCursor(e);
  };

  private emitCursor(e: { clientX: number; clientY: number }): void {
    if (!this.atlas || !this.params || !this.field || !this.onCursor) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left - this.panX) / this.zoom;
    const cy = (e.clientY - rect.top - this.panY) / this.zoom;
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    if (ix < 0 || iy < 0 || ix >= this.atlas.res || iy >= this.atlas.res) {
      this.onCursor(null);
      return;
    }
    const wx = this.atlas.worldX(ix);
    const wy = this.atlas.worldY(iy);
    const r = Math.sqrt(wx * wx + wy * wy);
    const i = iy * this.atlas.res + ix;
    this.onCursor({
      wx,
      wy,
      height: this.field[i],
      biomeId: this.atlas.biomeId[i],
      boundaryDist: this.atlas.boundaryDist[i],
      inside: r <= this.params.worldRadius,
    });
  }

  draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, w, h);
    if (!this.atlas || !this.params) return;

    const res = this.atlas.res;
    const size = res * this.zoom;
    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.drawImage(this.buffer, 0, 0, res, res, this.panX, this.panY, size, size);

    // World boundary and range rings, in world metres.
    const R = this.params.worldRadius;
    const cell = this.atlas.cellSize;
    const cxPix = this.panX + (R / cell) * this.zoom;
    const cyPix = this.panY + (R / cell) * this.zoom;
    const pxPerMetre = this.zoom / cell;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    for (let ring = 1000; ring < R; ring += 1000) {
      ctx.beginPath();
      ctx.arc(cxPix, cyPix, ring * pxPerMetre, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(88,166,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cxPix, cyPix, R * pxPerMetre, 0, Math.PI * 2);
    ctx.stroke();

    // Scale bar — a 10 km world is hard to read without one.
    const targets = [100, 250, 500, 1000, 2000, 5000];
    let barM = targets[targets.length - 1];
    for (const t of targets) {
      if (t * pxPerMetre > 70) { barM = t; break; }
    }
    const barPx = barM * pxPerMetre;
    const bx = w - barPx - 18;
    const by = h - 22;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
    ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, bx + barPx / 2, by - 8);
    ctx.textAlign = 'left';
  }
}
