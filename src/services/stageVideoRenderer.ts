import { Muxer as Mp4Muxer, StreamTarget as Mp4StreamTarget } from 'mp4-muxer';
import { Muxer as WebmMuxer, StreamTarget as WebmStreamTarget } from 'webm-muxer';
import { MvExportCheckpointMeta, MvExportChunkBatch } from '../types/ai';
import {
  AnimationIntensity,
  AudioAnalysisFrame,
  FontPresetId,
  LyricLine,
  MvMidBreakRange,
  MvTheaterPhase,
  TrackColorPalette,
  TrackMetadata,
  TrackMvRecord,
} from '../types/music';
import {
  deriveFluidBackgroundColors,
  FluidBackgroundColors,
} from '../utils/colorExtractor';
import { formatTime } from '../utils/constants';
import { findActiveLyricIndex, parseLrc } from '../utils/lrcParser';
import {
  computeSyncedMvTime,
  computeTheaterVisualState,
  createDefaultMvTimeline,
  findTriggeredMidBreak,
  normalizeMidBreaks,
} from '../utils/mvTimeline';

export type StageVideoQuality = '720p' | '1080p' | '1440p' | '2160p';

const QUALITY_DIMENSIONS: Record<StageVideoQuality, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
};

function getTargetBitrate(width: number, fps: number): number {
  // Prioritize visual quality & smooth high-motion encoding across 720p-2160p
  if (width >= 3840) {
    return fps >= 100 ? 64_000_000 : fps >= 60 ? 48_000_000 : 32_000_000;
  }
  if (width >= 2560) {
    return fps >= 100 ? 40_000_000 : fps >= 60 ? 28_000_000 : 20_000_000;
  }
  if (width >= 1920) {
    return fps >= 100 ? 24_000_000 : fps >= 60 ? 18_000_000 : 12_000_000;
  }
  return fps >= 100 ? 14_000_000 : fps >= 60 ? 10_000_000 : 7_000_000;
}

/**
 * Yields to the browser event loop without the 4ms minimum clamp of setTimeout(0).
 */
function yieldImmediate(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 4 MiB Blob-backed paged stream sink for MP4/WebM StreamTarget.
 * Instead of growing a single 500MB+ contiguous ArrayBuffer in V8 heap (which spikes >1.5GB during resize/slice
 * and crashes mobile/tablet tabs at ~98% finalize), completed 4 MiB pages are sealed into Blink Blobs
 * immediately and small header back-patches (mdat size / WebM header) are applied only to affected pages.
 */
class PagedBlobSink {
  private readonly pageSize = 4 * 1024 * 1024;
  private sealedBlobs: Blob[] = [];
  private activePageIndex = 0;
  private activeBuf: Uint8Array<ArrayBuffer> | null = new Uint8Array(4 * 1024 * 1024);
  private totalBytes = 0;
  private patches = new Map<number, Array<{ offset: number; bytes: Uint8Array<ArrayBuffer> }>>();

  write(position: number, data: Uint8Array): void {
    if (!data || data.byteLength === 0) return;

    const endPos = position + data.byteLength;
    if (endPos > this.totalBytes) {
      this.totalBytes = endPos;
    }

    let srcOffset = 0;
    while (srcOffset < data.byteLength) {
      const absPos = position + srcOffset;
      const pageIdx = Math.floor(absPos / this.pageSize);
      const offsetInPage = absPos - pageIdx * this.pageSize;
      const writeLen = Math.min(data.byteLength - srcOffset, this.pageSize - offsetInPage);
      const slice = data.subarray(srcOffset, srcOffset + writeLen);

      if (pageIdx < this.activePageIndex) {
        let list = this.patches.get(pageIdx);
        if (!list) {
          list = [];
          this.patches.set(pageIdx, list);
        }
        list.push({ offset: offsetInPage, bytes: new Uint8Array(slice) });
      } else {
        while (this.activePageIndex < pageIdx) {
          this.sealActivePage(this.pageSize);
          this.activePageIndex++;
          this.activeBuf = new Uint8Array(this.pageSize);
        }
        if (!this.activeBuf) {
          this.activeBuf = new Uint8Array(this.pageSize);
        }
        this.activeBuf.set(slice, offsetInPage);
      }

      srcOffset += writeLen;
    }
  }

  private sealActivePage(validLength: number): void {
    if (!this.activeBuf) return;
    if (validLength > 0) {
      if (validLength === this.activeBuf.byteLength) {
        this.sealedBlobs.push(new Blob([this.activeBuf]));
      } else {
        this.sealedBlobs.push(new Blob([this.activeBuf.slice(0, validLength)]));
      }
    }
    this.activeBuf = null;
  }

  async toBlob(mimeType: string): Promise<Blob> {
    if (this.totalBytes === 0) {
      this.dispose();
      return new Blob([], { type: mimeType });
    }

    const lastPageStart = this.activePageIndex * this.pageSize;
    const remaining = Math.max(0, this.totalBytes - lastPageStart);
    if (this.activeBuf && remaining > 0) {
      this.sealActivePage(Math.min(this.pageSize, remaining));
    } else {
      this.activeBuf = null;
    }

    if (this.patches.size > 0) {
      for (const [pageIdx, list] of this.patches.entries()) {
        const origBlob = this.sealedBlobs[pageIdx];
        if (!origBlob) continue;
        const pageBuf = new Uint8Array(await origBlob.arrayBuffer());
        for (const p of list) {
          pageBuf.set(p.bytes, p.offset);
        }
        this.sealedBlobs[pageIdx] = new Blob([pageBuf]);
      }
      this.patches.clear();
    }

    const finalBlob = new Blob(this.sealedBlobs, { type: mimeType });
    this.sealedBlobs = [];
    return finalBlob;
  }

  dispose(): void {
    this.sealedBlobs = [];
    this.activeBuf = null;
    this.patches.clear();
  }
}

export class StageRenderPausedError extends Error {
  constructor(message = '已暂停导出并保存断点进度') {
    super(message);
    this.name = 'StageRenderPausedError';
  }
}

export interface StageRenderOptions {
  track: TrackMetadata;
  audioBlob: Blob;
  mvRecord?: TrackMvRecord | null;
  includeMvInVideo: boolean;
  includeMvIntro?: boolean;
  includeMvMidBreaks?: boolean;
  includeMvOutro?: boolean;
  showBilingual: boolean;
  showWordSync: boolean;
  fontPreset?: FontPresetId;
  animationIntensity: AnimationIntensity;
  quality: StageVideoQuality;
  fps?: number; // 30 .. 120
  startOffsetSec?: number; // Custom start offset in seconds (default 0)
  clipDurationSec?: number | null; // null/undefined = full duration from startOffsetSec
  mvUiFadeInSec?: number;
  mvUiFadeOutSec?: number;
  previewCanvas?: HTMLCanvasElement | null;
  monitorMuted?: boolean;
  checkpointTaskId?: string;
  resumeCheckpoint?: {
    meta: MvExportCheckpointMeta;
    batches: MvExportChunkBatch[];
  } | null;
  onCheckpoint?: (
    meta: MvExportCheckpointMeta,
    newBatch: MvExportChunkBatch | null
  ) => Promise<void>;
  onProgress?: (info: StageRenderProgress) => void;
}

export interface StageRenderProgress {
  percent: number; // 0..100
  elapsedSec: number;
  totalSec: number;
  phaseLabel: string;
  engineLabel: string;
  fps?: number;
}

export interface StageRenderResult {
  videoBlob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  engineUsed: 'webcodecs-mp4' | 'webcodecs-webm' | 'mediarecorder';
}

export interface StageRenderController {
  promise: Promise<StageRenderResult>;
  cancel: () => void;
  pause: () => void;
  finishEarly: () => void;
  setMonitorMuted: (muted: boolean) => void;
}

interface StageDrawContextState {
  timeSec: number;
  audioTime: number;
  audioDuration: number;
  mvPhase: MvTheaterPhase;
  mvPhaseTime: number;
  uiOpacity: number;
  isTheaterClarity: boolean;
  frame: AudioAnalysisFrame;
  smoothBass: number;
  smoothMid: number;
  smoothVol: number;
  activeIdx: number;
  prevIdx: number;
  lineTransitionElapsedSec: number;
  stepDirection: 'forward' | 'backward' | 'none';
}

function getFontStack(fontPreset?: FontPresetId): string {
  switch (fontPreset) {
    case 'editorial':
      return '"Fraunces", "Lora", "Songti SC", "SimSun", serif';
    case 'rounded':
      return '"DM Sans", "Outfit", "PingFang SC", "Noto Sans SC", sans-serif';
    case 'mono':
      return '"JetBrains Mono", "PingFang SC", "Noto Sans SC", monospace';
    case 'classic':
      return 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    case 'modern':
    default:
      return '"Outfit", "Plus Jakarta Sans", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
  }
}

const MONO_STACK = '"JetBrains Mono", ui-monospace, monospace';

function loadImageElement(src?: string): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const clean = (text || '').trim();
  if (!clean) return [];
  const rows: string[] = [];
  let cur = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = cur + ch;
    if (ctx.measureText(next).width > maxWidth && cur.length > 0) {
      const lastSpace = cur.lastIndexOf(' ');
      if (lastSpace > cur.length * 0.45 && ch !== ' ') {
        rows.push(cur.slice(0, lastSpace));
        cur = cur.slice(lastSpace + 1) + ch;
      } else {
        rows.push(cur);
        cur = ch === ' ' ? '' : ch;
      }
    } else {
      cur = next;
    }
  }
  if (cur.trim()) rows.push(cur.trim());
  return rows;
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawTruncatedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number
) {
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}...`).width > maxWidth) {
    s = s.slice(0, -1);
  }
  ctx.fillText(`${s}...`, x, y);
}

function cubicBezierEaseOut(t: number): number {
  const p = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - p, 3.2);
}

/**
 * Lightweight 256-point Radix-2 Cooley-Tukey FFT with precomputed twiddle & bit-reversal tables.
 */
class OfflineAudioAnalyzer {
  private monoSamples: Float32Array;
  private sampleRate: number;
  private readonly fftSize = 256;
  private hannWindow: Float32Array;
  private bitRev: Uint8Array;
  private twCos: Float32Array;
  private twSin: Float32Array;
  private real: Float32Array;
  private imag: Float32Array;
  private frequencies = new Uint8Array(128);
  private waveform = new Uint8Array(128);

  constructor(buffer: AudioBuffer) {
    this.sampleRate = buffer.sampleRate;
    const len = buffer.length;
    const ch0 = buffer.getChannelData(0);
    if (buffer.numberOfChannels > 1) {
      const ch1 = buffer.getChannelData(1);
      const mixed = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        mixed[i] = (ch0[i] + ch1[i]) * 0.5;
      }
      this.monoSamples = mixed;
    } else {
      this.monoSamples = ch0;
    }

    const N = this.fftSize;
    this.hannWindow = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    this.bitRev = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < 8; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.bitRev[i] = r;
    }

    this.twCos = new Float32Array(N / 2);
    this.twSin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      const angle = (-2 * Math.PI * i) / N;
      this.twCos[i] = Math.cos(angle);
      this.twSin[i] = Math.sin(angle);
    }

    this.real = new Float32Array(N);
    this.imag = new Float32Array(N);
  }

  sampleAt(timeSec: number): AudioAnalysisFrame {
    const N = this.fftSize;
    const center = Math.floor(timeSec * this.sampleRate);
    const start = Math.max(0, center - N / 2);
    const mono = this.monoSamples;
    const monoLen = mono.length;

    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const sample = idx < monoLen ? mono[idx] : 0;
      sumSq += sample * sample;
      const rev = this.bitRev[i];
      this.real[rev] = sample * this.hannWindow[i];
      this.imag[rev] = 0;
    }

    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let k = 0; k < half; k++) {
          const twIdx = k * step;
          const cos = this.twCos[twIdx];
          const sin = this.twSin[twIdx];
          const evenIdx = i + k;
          const oddIdx = evenIdx + half;
          const or = this.real[oddIdx];
          const oi = this.imag[oddIdx];
          const tReal = cos * or - sin * oi;
          const tImag = sin * or + cos * oi;
          this.real[oddIdx] = this.real[evenIdx] - tReal;
          this.imag[oddIdx] = this.imag[evenIdx] - tImag;
          this.real[evenIdx] += tReal;
          this.imag[evenIdx] += tImag;
        }
      }
    }

    let bassSum = 0;
    let midSum = 0;
    let highSum = 0;
    const invNorm = 1 / (N * 0.25);

    for (let k = 0; k < 128; k++) {
      const r = this.real[k];
      const im = this.imag[k];
      const mag = Math.sqrt(r * r + im * im) * invNorm;
      const dbScaled = mag <= 0 ? 0 : Math.min(1, Math.pow(mag, 0.55));
      this.frequencies[k] = Math.round(dbScaled * 255);
      if (k < 10) bassSum += dbScaled;
      else if (k < 44) midSum += dbScaled;
      else highSum += dbScaled;
    }

    const rms = Math.sqrt(sumSq / N);
    return {
      bass: Math.min(1, (bassSum / 10) * 1.15),
      mid: Math.min(1, (midSum / 34) * 1.2),
      high: Math.min(1, (highSum / 84) * 1.45),
      volume: Math.min(1, rms * 2.2),
      frequencies: this.frequencies,
      waveform: this.waveform,
    };
  }
}

/**
 * Draws the Clean Exported Stage:
 * - Left half: Stationary rounded-square album cover + Title + Composer/Artist + Progress bar (NO prev/pause/next buttons)
 * - Right half: Unboxed 3-Line Real-Time Synced Lyrics (`FullscreenThreeLineLyrics`) matching exact font preset & glow
 * Uses offscreen caches for static cover/shadows, radial fluid textures, and steady-state lyrics for high-speed 720p-2160p export.
 */
class StageCanvasPainter {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private s: number;
  private track: TrackMetadata;
  private palette: TrackColorPalette;
  private fluidColors: FluidBackgroundColors;
  private coverImg: HTMLImageElement | null;
  private parsed: ReturnType<typeof parseLrc>;
  private showBilingual: boolean;
  private showWordSync: boolean;
  private fontStack: string;
  private hasMvVideo: boolean;

  // Offscreen performance caches
  private staticBgCanvas: HTMLCanvasElement | null = null;
  private blob1Canvas: HTMLCanvasElement | null = null;
  private blob2Canvas: HTMLCanvasElement | null = null;
  private lastValidMvCanvas: HTMLCanvasElement | null = null;
  private lastValidMvCtx: CanvasRenderingContext2D | null = null;
  private mvReadabilityScrim: HTMLCanvasElement | null = null;
  private staticLeftCanvas: HTMLCanvasElement;
  private thumbDotCanvas: HTMLCanvasElement;
  private readonly thumbDotHalfSize: number;
  private barFillGrad: CanvasGradient;
  private lyricsCacheCanvas: HTMLCanvasElement;
  private lyricsCacheCtx: CanvasRenderingContext2D;
  private readonly lyricsCacheX: number;
  private cachedLyricsKey: string | null = null;
  private lastPreviewMirrorMs = -1000;

  constructor(params: {
    width: number;
    height: number;
    track: TrackMetadata;
    coverImg: HTMLImageElement | null;
    showBilingual: boolean;
    showWordSync?: boolean;
    fontPreset?: FontPresetId;
    hasMvVideo: boolean;
  }) {
    this.width = params.width;
    this.height = params.height;
    this.s = params.width / 1280;
    this.track = params.track;
    this.palette = params.track.palette;
    this.fluidColors = deriveFluidBackgroundColors(this.palette);
    this.coverImg = params.coverImg;
    this.showBilingual = params.showBilingual;
    this.showWordSync = Boolean(params.showWordSync);
    this.fontStack = getFontStack(params.fontPreset);
    this.hasMvVideo = params.hasMvVideo;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法初始化 2D 渲染画布');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this.ctx = ctx;

    this.parsed = parseLrc(this.track.lyricsRaw);

    if (!this.hasMvVideo) {
      this.initBackdropCaches();
    } else {
      const snapW = Math.min(this.width, 1920);
      const snapH = Math.round((snapW * this.height) / this.width);
      this.lastValidMvCanvas = document.createElement('canvas');
      this.lastValidMvCanvas.width = snapW;
      this.lastValidMvCanvas.height = snapH;
      const sCtx = this.lastValidMvCanvas.getContext('2d', { alpha: false });
      if (sCtx) {
        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = 'high';
        this.lastValidMvCtx = sCtx;
      }

      const scrim = document.createElement('canvas');
      scrim.width = 256;
      scrim.height = 144;
      const scCtx = scrim.getContext('2d');
      if (scCtx) {
        const grad = scCtx.createLinearGradient(0, 0, 256, 0);
        grad.addColorStop(0, 'rgba(6, 2, 10, 0.28)');
        grad.addColorStop(0.5, 'rgba(6, 2, 10, 0.16)');
        grad.addColorStop(1, 'rgba(6, 2, 10, 0.34)');
        scCtx.fillStyle = grad;
        scCtx.fillRect(0, 0, 256, 144);
        this.mvReadabilityScrim = scrim;
      }
    }

    this.staticLeftCanvas = this.buildStaticLeftDeckCache();

    // Pre-render progress thumb + glow once to avoid per-frame shadowBlur filter overhead
    const dotSize = Math.max(32, Math.ceil(48 * this.s));
    this.thumbDotHalfSize = dotSize / 2;
    this.thumbDotCanvas = document.createElement('canvas');
    this.thumbDotCanvas.width = dotSize;
    this.thumbDotCanvas.height = dotSize;
    const dCtx = this.thumbDotCanvas.getContext('2d');
    if (dCtx) {
      dCtx.save();
      dCtx.shadowColor = this.palette.primary;
      dCtx.shadowBlur = 12 * this.s;
      dCtx.beginPath();
      dCtx.arc(this.thumbDotHalfSize, this.thumbDotHalfSize, 8 * this.s, 0, Math.PI * 2);
      dCtx.fillStyle = '#ffffff';
      dCtx.fill();
      dCtx.restore();
    }

    const barW = Math.min(390 * this.s, this.width * 0.32);
    const barX = this.width * 0.25 - barW / 2;
    this.barFillGrad = this.ctx.createLinearGradient(barX, 0, barX + barW, 0);
    this.barFillGrad.addColorStop(0, this.palette.primary);
    this.barFillGrad.addColorStop(1, this.palette.secondary);

    this.lyricsCacheX = Math.floor(this.width * 0.48);
    this.lyricsCacheCanvas = document.createElement('canvas');
    this.lyricsCacheCanvas.width = this.width - this.lyricsCacheX;
    this.lyricsCacheCanvas.height = this.height;
    const lCtx = this.lyricsCacheCanvas.getContext('2d');
    if (!lCtx) throw new Error('无法初始化歌词缓存画布');
    lCtx.imageSmoothingEnabled = true;
    lCtx.imageSmoothingQuality = 'high';
    this.lyricsCacheCtx = lCtx;
  }

  private initBackdropCaches(): void {
    const W = this.width;
    const H = this.height;
    const c = this.fluidColors;

    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    const bCtx = bg.getContext('2d', { alpha: false });
    if (bCtx) {
      const [ar, ag, ab] = c.abyssRgb.map((v) => Math.round(v * 0.45));
      const [dr, dg, db] = c.deepRgb.map((v) => Math.round(v * 0.55));
      const baseGrad = bCtx.createLinearGradient(0, 0, W, H);
      baseGrad.addColorStop(0, `rgb(${ar}, ${ag}, ${ab})`);
      baseGrad.addColorStop(0.5, `rgb(${dr}, ${dg}, ${db})`);
      baseGrad.addColorStop(1, `rgb(${ar}, ${ag}, ${ab})`);
      bCtx.fillStyle = baseGrad;
      bCtx.fillRect(0, 0, W, H);
      this.staticBgCanvas = bg;
    }

    const makeBlob = (rgb: [number, number, number]): HTMLCanvasElement => {
      const size = 512;
      const half = size / 2;
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const gCtx = cv.getContext('2d');
      if (gCtx) {
        const rr = Math.round(rgb[0]);
        const rg = Math.round(rgb[1]);
        const rb = Math.round(rgb[2]);
        const g = gCtx.createRadialGradient(half, half, 0, half, half, half);
        g.addColorStop(0, `rgba(${rr}, ${rg}, ${rb}, 1)`);
        g.addColorStop(0.5, `rgba(${rr}, ${rg}, ${rb}, 0.32)`);
        g.addColorStop(1, `rgba(${rr}, ${rg}, ${rb}, 0)`);
        gCtx.fillStyle = g;
        gCtx.fillRect(0, 0, size, size);
      }
      return cv;
    };

    this.blob1Canvas = makeBlob(c.silkRgb);
    this.blob2Canvas = makeBlob(c.secondaryRgb);
  }

  private buildStaticLeftDeckCache(): HTMLCanvasElement {
    const W = this.width;
    const H = this.height;
    const s = this.s;
    const cx = W * 0.25;
    const coverSize = Math.round(Math.min(H * 0.38, W * 0.225));
    const coverX = cx - coverSize / 2;
    const coverY = H * 0.175;
    const cornerRadius = 26 * s;

    const cv = document.createElement('canvas');
    cv.width = Math.ceil(W * 0.52);
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. Stationary Square Album Cover + Drop Shadow (rendered once!)
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
    ctx.shadowBlur = 46 * s;
    ctx.shadowOffsetY = 18 * s;
    drawRoundedRectPath(ctx, coverX, coverY, coverSize, coverSize, cornerRadius);
    ctx.fillStyle = '#160812';
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRectPath(ctx, coverX, coverY, coverSize, coverSize, cornerRadius);
    ctx.clip();
    if (this.coverImg) {
      const iw = this.coverImg.naturalWidth || 1;
      const ih = this.coverImg.naturalHeight || 1;
      const scale = Math.max(coverSize / iw, coverSize / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.drawImage(
        this.coverImg,
        coverX + (coverSize - dw) / 2,
        coverY + (coverSize - dh) / 2,
        dw,
        dh
      );
    } else {
      const fb = ctx.createLinearGradient(coverX, coverY, coverX + coverSize, coverY + coverSize);
      fb.addColorStop(0, 'rgba(255,255,255,0.1)');
      fb.addColorStop(1, 'rgba(0,0,0,0.58)');
      ctx.fillStyle = fb;
      ctx.fillRect(coverX, coverY, coverSize, coverSize);
    }
    ctx.restore();

    // 2. Song Title + Composer/Artist
    const titleY = coverY + coverSize + 30 * s;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 10 * s;
    ctx.shadowOffsetY = 2 * s;

    ctx.font = `600 ${Math.round(21 * s)}px ${this.fontStack}`;
    ctx.fillStyle = '#ffffff';
    drawTruncatedText(ctx, this.track.title || 'LUMINA MUSIC', cx, titleY, W * 0.36);

    const artistDisplay = (this.track.artist || '').trim() || (this.track.composer || '').trim();
    if (artistDisplay) {
      ctx.font = `400 ${Math.round(14 * s)}px ${this.fontStack}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      drawTruncatedText(ctx, artistDisplay, cx, titleY + 25 * s, W * 0.36);
    }
    ctx.restore();

    return cv;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getLines(): LyricLine[] {
    return this.parsed.lines;
  }

  getHasSynced(): boolean {
    return this.parsed.hasSyncedTimestamps;
  }

  private hasDrawnValidMvFrame = false;

  dispose(): void {
    const releaseCanvas = (cv: HTMLCanvasElement | null) => {
      if (!cv) return;
      try {
        cv.width = 0;
        cv.height = 0;
      } catch {
        // ignore
      }
    };
    releaseCanvas(this.canvas);
    releaseCanvas(this.staticBgCanvas);
    releaseCanvas(this.blob1Canvas);
    releaseCanvas(this.blob2Canvas);
    releaseCanvas(this.lastValidMvCanvas);
    releaseCanvas(this.mvReadabilityScrim);
    releaseCanvas(this.staticLeftCanvas);
    releaseCanvas(this.thumbDotCanvas);
    releaseCanvas(this.lyricsCacheCanvas);
    this.staticBgCanvas = null;
    this.blob1Canvas = null;
    this.blob2Canvas = null;
    this.lastValidMvCanvas = null;
    this.lastValidMvCtx = null;
    this.mvReadabilityScrim = null;
    this.coverImg = null;
  }

  drawFrame(
    state: StageDrawContextState,
    mvVideoEl?: HTMLVideoElement | null,
    previewCanvas?: HTMLCanvasElement | null,
    forcePreview = false
  ) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const s = this.s;

    const hasLiveMvFrame = Boolean(
      mvVideoEl && mvVideoEl.readyState >= 2 && mvVideoEl.videoWidth > 0 && mvVideoEl.videoHeight > 0
    );

    // 1. Background + MV Theater Video Layer
    let drewMvFrame = false;
    if (hasLiveMvFrame && mvVideoEl) {
      try {
        const vw = mvVideoEl.videoWidth || W;
        const vh = mvVideoEl.videoHeight || H;
        const scale = Math.max(W / vw, H / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (W - dw) / 2;
        const dy = (H - dh) / 2;

        ctx.drawImage(mvVideoEl, dx, dy, dw, dh);
        drewMvFrame = true;

        if (this.lastValidMvCtx && this.lastValidMvCanvas) {
          const sw = this.lastValidMvCanvas.width;
          const sh = this.lastValidMvCanvas.height;
          this.lastValidMvCtx.drawImage(this.canvas, 0, 0, sw, sh);
          this.hasDrawnValidMvFrame = true;
        }
      } catch {
        drewMvFrame = false;
      }
    }

    if (!drewMvFrame) {
      if (this.hasMvVideo && this.hasDrawnValidMvFrame && this.lastValidMvCanvas) {
        ctx.drawImage(this.lastValidMvCanvas, 0, 0, W, H);
      } else {
        this.drawBackdrop(ctx, W, H, state);
      }
    }

    // 3. Fullscreen 50/50 Split Player Stage (fades smoothly with uiOpacity during MV intro/mid-break/outro)
    if (state.uiOpacity > 0.01) {
      const clampedAlpha = Math.max(0, Math.min(1, state.uiOpacity));
      const needsAlpha = clampedAlpha < 0.999;
      if (needsAlpha) {
        ctx.save();
        ctx.globalAlpha = clampedAlpha;
      }

      if (this.hasMvVideo && this.mvReadabilityScrim) {
        ctx.drawImage(this.mvReadabilityScrim, 0, 0, W, H);
      }

      this.drawLeftFullscreenDeck(ctx, W, H, s, state);
      this.drawRightThreeLineLyrics(ctx, W, H, s, state);

      if (needsAlpha) {
        ctx.restore();
      }
    }

    // 4. Mirror live composition onto on-screen preview canvas (throttled & downscaled for speed!)
    if (previewCanvas) {
      const nowMs = performance.now();
      if (forcePreview || nowMs - this.lastPreviewMirrorMs >= 100) {
        this.lastPreviewMirrorMs = nowMs;
        const previewW = Math.min(W, 960);
        const previewH = Math.round((previewW * H) / W);
        if (previewCanvas.width !== previewW || previewCanvas.height !== previewH) {
          previewCanvas.width = previewW;
          previewCanvas.height = previewH;
        }
        const pCtx = previewCanvas.getContext('2d');
        if (pCtx) {
          pCtx.imageSmoothingEnabled = true;
          pCtx.imageSmoothingQuality = 'high';
          pCtx.drawImage(this.canvas, 0, 0, previewW, previewH);
        }
      }
    }
  }

  private drawBackdrop(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    state: StageDrawContextState
  ) {
    if (this.hasMvVideo) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      return;
    }

    if (this.staticBgCanvas) {
      ctx.drawImage(this.staticBgCanvas, 0, 0);
    } else {
      ctx.fillStyle = '#0a0408';
      ctx.fillRect(0, 0, W, H);
    }

    const t = state.timeSec;
    if (this.blob1Canvas) {
      const cx1 = W * (0.22 + Math.sin(t * 0.21) * 0.08);
      const cy1 = H * (0.26 + Math.cos(t * 0.19) * 0.08);
      const r1 = Math.max(W, H) * (0.48 + state.smoothBass * 0.06);
      ctx.save();
      ctx.globalAlpha = 0.24 + state.smoothVol * 0.08;
      ctx.drawImage(this.blob1Canvas, cx1 - r1, cy1 - r1, r1 * 2, r1 * 2);
      ctx.restore();
    }

    if (this.blob2Canvas) {
      const cx2 = W * (0.78 + Math.cos(t * 0.18) * 0.08);
      const cy2 = H * (0.74 + Math.sin(t * 0.22) * 0.08);
      const r2 = Math.max(W, H) * (0.46 + state.smoothMid * 0.05);
      ctx.save();
      ctx.globalAlpha = 0.2 + state.smoothVol * 0.07;
      ctx.drawImage(this.blob2Canvas, cx2 - r2, cy2 - r2, r2 * 2, r2 * 2);
      ctx.restore();
    }
  }

  private drawLeftFullscreenDeck(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    s: number,
    state: StageDrawContextState
  ) {
    // 1. Pre-rendered stationary cover + drop shadow + title + composer/artist
    ctx.drawImage(this.staticLeftCanvas, 0, 0);

    // 2. Progress Bar + Timecodes ONLY (transport prev/pause/next buttons intentionally omitted)
    const cx = W * 0.25;
    const barW = Math.min(390 * s, W * 0.32);
    const barX = cx - barW / 2;
    const barY = H * 0.785;
    const barH = 5.5 * s;
    const pct =
      state.audioDuration > 0
        ? Math.max(0, Math.min(1, state.audioTime / state.audioDuration))
        : 0;

    drawRoundedRectPath(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fill();

    if (pct > 0) {
      const fillW = Math.max(barH, barW * pct);
      drawRoundedRectPath(ctx, barX, barY, fillW, barH, barH / 2);
      ctx.fillStyle = this.barFillGrad;
      ctx.fill();
    }

    const thumbX = barX + barW * pct;
    ctx.drawImage(
      this.thumbDotCanvas,
      thumbX - this.thumbDotHalfSize,
      barY + barH / 2 - this.thumbDotHalfSize
    );

    ctx.save();
    ctx.font = `400 ${Math.round(11 * s)}px ${MONO_STACK}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(state.audioTime), barX, barY + 14 * s);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(state.audioDuration), barX + barW, barY + 14 * s);
    ctx.restore();
  }

  private drawRightThreeLineLyrics(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    s: number,
    state: StageDrawContextState
  ) {
    const activeIdx = this.parsed.hasSyncedTimestamps ? state.activeIdx : 0;
    const activeLine = activeIdx >= 0 ? this.parsed.lines[activeIdx] : null;
    const activeHasWordKaraoke = Boolean(
      this.showWordSync &&
        this.parsed.hasWordTimestamps &&
        activeLine?.words &&
        activeLine.words.length > 0
    );
    const animDur = 0.54;
    const isAnimating =
      this.parsed.lines.length > 0 &&
      state.stepDirection !== 'none' &&
      state.lineTransitionElapsedSec < animDur + 0.095;

    // Fast path: blit cached steady-state lyrics canvas when not animating or word-karaoke highlighting
    if (!isAnimating && !activeHasWordKaraoke) {
      const cacheKey = this.parsed.lines.length === 0 ? 'empty' : `steady:${activeIdx}`;
      if (this.cachedLyricsKey !== cacheKey) {
        this.lyricsCacheCtx.clearRect(
          0,
          0,
          this.lyricsCacheCanvas.width,
          this.lyricsCacheCanvas.height
        );
        this.renderLyricsIntoContext(
          this.lyricsCacheCtx,
          W,
          H,
          s,
          state,
          -this.lyricsCacheX,
          false
        );
        this.cachedLyricsKey = cacheKey;
      }
      ctx.drawImage(this.lyricsCacheCanvas, this.lyricsCacheX, 0);
      return;
    }

    this.renderLyricsIntoContext(ctx, W, H, s, state, 0, isAnimating);
  }

  private renderLyricsIntoContext(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    s: number,
    state: StageDrawContextState,
    offsetX: number,
    withEntranceAnim: boolean
  ) {
    const xStart = W * 0.53 + offsetX;
    const maxTextWidth = W * 0.41;
    const centerY = H * 0.5;

    if (this.parsed.lines.length === 0) {
      ctx.save();
      ctx.font = `400 ${Math.round(20 * s)}px ${this.fontStack}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无歌词', xStart, centerY);
      ctx.restore();
      return;
    }

    const activeIdx = this.parsed.hasSyncedTimestamps ? state.activeIdx : 0;
    const isIntroWaiting = this.parsed.hasSyncedTimestamps && activeIdx < 0;

    const prevLine: LyricLine | null =
      !isIntroWaiting && activeIdx > 0 ? this.parsed.lines[activeIdx - 1] : null;
    const currentLine: LyricLine | null =
      !isIntroWaiting && activeIdx >= 0 ? this.parsed.lines[activeIdx] : null;
    const nextLine: LyricLine | null = isIntroWaiting
      ? this.parsed.lines[0] || null
      : activeIdx + 1 < this.parsed.lines.length
      ? this.parsed.lines[activeIdx + 1]
      : null;

    const slotGap = 112 * s;
    const slots: {
      line: LyricLine | null;
      role: 'prev' | 'current' | 'next';
      baseY: number;
      staggerSec: number;
    }[] = [
      {
        line: prevLine,
        role: 'prev',
        baseY: centerY - slotGap,
        staggerSec: state.stepDirection === 'backward' ? 0.09 : 0,
      },
      {
        line: currentLine,
        role: 'current',
        baseY: centerY,
        staggerSec: 0.045,
      },
      {
        line: nextLine,
        role: 'next',
        baseY: centerY + slotGap,
        staggerSec: state.stepDirection === 'backward' ? 0 : 0.09,
      },
    ];

    const animDur = 0.54;
    const [r1, g1, b1] = this.palette.rgbPrimary;

    for (const slot of slots) {
      if (!slot.line) {
        if (isIntroWaiting && slot.role === 'current') {
          ctx.save();
          ctx.font = `400 ${Math.round(22 * s)}px ${this.fontStack}`;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText('·  ·  ·', xStart, slot.baseY);
          ctx.restore();
        }
        continue;
      }

      const isCurrent = slot.role === 'current';
      const targetOpacity = isCurrent ? 1 : slot.role === 'prev' ? 0.35 : 0.48;
      const targetScale = isCurrent ? 1.02 : slot.role === 'prev' ? 0.96 : 0.97;
      const targetShiftX = isCurrent ? 6 * s : 0;

      let animT = 1;
      if (
        withEntranceAnim &&
        state.stepDirection !== 'none' &&
        state.lineTransitionElapsedSec < animDur + slot.staggerSec
      ) {
        const localElapsed = Math.max(0, state.lineTransitionElapsedSec - slot.staggerSec);
        animT = cubicBezierEaseOut(localElapsed / animDur);
      }

      const dirSign = state.stepDirection === 'backward' ? -1 : 1;
      const useAnim = withEntranceAnim && state.stepDirection !== 'none';
      const enterOffsetY = useAnim ? dirSign * 24 * s * (1 - animT) : 0;
      const enterScale = useAnim ? 0.968 + 0.032 * animT : 1;
      const enterAlpha = useAnim ? 0.12 + 0.88 * animT : 1;

      const slotOpacity = targetOpacity * enterAlpha;
      const slotScale = targetScale * enterScale;

      ctx.save();
      ctx.globalAlpha *= slotOpacity;
      ctx.translate(xStart + targetShiftX, slot.baseY + enterOffsetY);
      ctx.scale(slotScale, slotScale);

      const mainFontSize = isCurrent ? Math.round(33 * s) : Math.round(20 * s);
      const transFontSize = isCurrent ? Math.round(17 * s) : Math.round(14.5 * s);

      ctx.font = `${isCurrent ? 600 : 400} ${mainFontSize}px ${this.fontStack}`;
      const mainRows = wrapTextLines(ctx, slot.line.text, maxTextWidth);

      let transRows: string[] = [];
      if (this.showBilingual && slot.line.translation) {
        ctx.font = `${isCurrent ? 400 : 300} ${transFontSize}px ${this.fontStack}`;
        transRows = wrapTextLines(ctx, slot.line.translation, maxTextWidth);
      }

      const mainLineH = mainFontSize * 1.32;
      const transLineH = transFontSize * 1.45;
      const totalBlockH =
        mainRows.length * mainLineH +
        (transRows.length > 0 ? 8 * s + transRows.length * transLineH : 0);

      let cursorY = -totalBlockH / 2;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `${isCurrent ? 600 : 400} ${mainFontSize}px ${this.fontStack}`;

      const hasWordKaraoke = Boolean(
        isCurrent &&
          this.showWordSync &&
          this.parsed.hasWordTimestamps &&
          slot.line.words &&
          slot.line.words.length > 0
      );

      if (hasWordKaraoke && slot.line.words) {
        const words = slot.line.words;
        const effectiveAudioTime =
          state.audioTime + (this.track.lyricsOffsetMs || 0) / 1000;

        // Build wrapped rows preserving individual word timing
        type WordRun = {
          text: string;
          isSung: boolean;
          isCurrentWord: boolean;
          width: number;
        };
        const wordRows: WordRun[][] = [];
        let curRow: WordRun[] = [];
        let curRowWidth = 0;

        for (let wi = 0; wi < words.length; wi++) {
          const w = words[wi];
          const nextW = words[wi + 1];
          const isSung = effectiveAudioTime >= w.time;
          const isCurrentWord = isSung && (!nextW || effectiveAudioTime < nextW.time);
          const token = w.text || '';
          if (!token) continue;
          const tokenW = ctx.measureText(token).width;

          if (curRow.length > 0 && curRowWidth + tokenW > maxTextWidth) {
            wordRows.push(curRow);
            curRow = [];
            curRowWidth = 0;
          }
          curRow.push({
            text: token,
            isSung,
            isCurrentWord,
            width: tokenW,
          });
          curRowWidth += tokenW;
        }
        if (curRow.length > 0) {
          wordRows.push(curRow);
        }

        // Re-center vertically when word wrapping produces a different row count than plain wrapTextLines
        const adjustedTotalH =
          wordRows.length * mainLineH +
          (transRows.length > 0 ? 8 * s + transRows.length * transLineH : 0);
        cursorY = -adjustedTotalH / 2;

        for (const wRow of wordRows) {
          let xWord = 0;
          for (const run of wRow) {
            ctx.save();
            if (run.isCurrentWord) {
              ctx.shadowColor = this.palette.primary;
              ctx.shadowBlur = 22 * s;
              ctx.fillStyle = '#ffffff';
              ctx.fillText(run.text, xWord, cursorY);
              ctx.shadowColor = 'rgba(0, 0, 0, 0.88)';
              ctx.shadowBlur = 14 * s;
              ctx.shadowOffsetY = 3 * s;
              ctx.fillText(run.text, xWord, cursorY);
            } else if (run.isSung) {
              ctx.shadowColor = `rgba(${r1}, ${g1}, ${b1}, 0.65)`;
              ctx.shadowBlur = 24 * s;
              ctx.fillStyle = '#ffffff';
              ctx.fillText(run.text, xWord, cursorY);
              ctx.shadowColor = 'rgba(0, 0, 0, 0.86)';
              ctx.shadowBlur = 14 * s;
              ctx.shadowOffsetY = 3 * s;
              ctx.fillText(run.text, xWord, cursorY);
            } else {
              ctx.shadowColor = 'rgba(0, 0, 0, 0.82)';
              ctx.shadowBlur = 12 * s;
              ctx.shadowOffsetY = 2 * s;
              ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
              ctx.fillText(run.text, xWord, cursorY);
            }
            ctx.restore();
            xWord += run.width;
          }
          cursorY += mainLineH;
        }
      } else {
        for (const row of mainRows) {
          ctx.save();
          if (isCurrent) {
            ctx.shadowColor = `rgba(${r1}, ${g1}, ${b1}, 0.72)`;
            ctx.shadowBlur = 30 * s;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(row, 0, cursorY);
            ctx.shadowColor = 'rgba(0, 0, 0, 0.88)';
            ctx.shadowBlur = 16 * s;
            ctx.shadowOffsetY = 4 * s;
            ctx.fillText(row, 0, cursorY);
          } else {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.82)';
            ctx.shadowBlur = 12 * s;
            ctx.shadowOffsetY = 2 * s;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.fillText(row, 0, cursorY);
          }
          ctx.restore();
          cursorY += mainLineH;
        }
      }

      if (transRows.length > 0) {
        cursorY += 8 * s;
        ctx.font = `${isCurrent ? 400 : 300} ${transFontSize}px ${this.fontStack}`;
        for (const tr of transRows) {
          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
          ctx.shadowBlur = 10 * s;
          ctx.shadowOffsetY = 2 * s;
          ctx.fillStyle = isCurrent
            ? 'rgba(255, 241, 245, 0.88)'
            : 'rgba(255, 255, 255, 0.6)';
          ctx.fillText(tr, 0, cursorY);
          ctx.restore();
          cursorY += transLineH;
        }
      }

      ctx.restore();
    }
  }
}

function advanceFlowState(
  state: StageDrawContextState,
  parsedLines: LyricLine[],
  hasSynced: boolean,
  lyricsOffsetMs: number,
  dt: number
) {
  const f = state.frame;
  const lerpSlow = 1 - Math.exp(-dt * 6.5);
  state.smoothBass += (f.bass - state.smoothBass) * lerpSlow;
  state.smoothMid += (f.mid - state.smoothMid) * lerpSlow;
  state.smoothVol += (f.volume - state.smoothVol) * lerpSlow;

  const nextIdx = hasSynced
    ? findActiveLyricIndex(parsedLines, state.audioTime, lyricsOffsetMs)
    : parsedLines.length > 0
    ? 0
    : -1;

  if (nextIdx !== state.activeIdx) {
    state.stepDirection =
      state.activeIdx >= 0 && nextIdx < state.activeIdx ? 'backward' : 'forward';
    state.prevIdx = state.activeIdx;
    state.activeIdx = nextIdx;
    state.lineTransitionElapsedSec = 0;
  } else {
    state.lineTransitionElapsedSec += dt;
  }
}

async function probeWebCodecsSupport(
  width: number,
  height: number,
  sampleRate: number,
  fps: number
) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    return null;
  }

  const targetBitrate = getTargetBitrate(width, fps);
  const audioBitrate = 256_000;

  // Check audio support once per codec
  const [aacSup, opusSup] = await Promise.all([
    AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      numberOfChannels: 2,
      sampleRate,
      bitrate: audioBitrate,
    }).catch(() => ({ supported: false })),
    AudioEncoder.isConfigSupported({
      codec: 'opus',
      numberOfChannels: 2,
      sampleRate: 48000,
      bitrate: audioBitrate,
    }).catch(() => ({ supported: false })),
  ]);

  // Higher H.264 levels (6.2, 6.1, 6.0, 5.2, 5.1, 5.0, 4.2) support 720p..2160p@30-120fps
  const avcCandidates = [
    'avc1.64003e', // High Profile Level 6.2 (2160p@120fps)
    'avc1.64003d', // High Profile Level 6.1
    'avc1.64003c', // High Profile Level 6.0 (2160p@60fps+)
    'avc1.640034', // High Profile Level 5.2 (2160p@60fps / 1080p@120fps)
    'avc1.640033', // High Profile Level 5.1 (1440p@60fps)
    'avc1.640032', // High Profile Level 5.0
    'avc1.4d0032', // Main Profile Level 5.0
    'avc1.64002a', // High Profile Level 4.2 (1080p@60fps)
    'avc1.4d002a', // Main Profile Level 4.2
    'avc1.4d001f', // Main Profile Level 3.1
  ];

  // Strictly prioritize 'quality' latencyMode + VBR for stutter-free frame pacing and crisp visuals
  const encoderProfiles: Array<{
    hardwareAcceleration: HardwareAcceleration;
    latencyMode?: LatencyMode;
    bitrateMode?: VideoEncoderBitrateMode;
  }> = [
    { hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', bitrateMode: 'variable' },
    { hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality' },
    { hardwareAcceleration: 'prefer-hardware' },
    { hardwareAcceleration: 'no-preference', latencyMode: 'quality', bitrateMode: 'variable' },
    { hardwareAcceleration: 'no-preference', latencyMode: 'quality' },
    { hardwareAcceleration: 'no-preference' },
  ];

  if (aacSup.supported) {
    for (const profile of encoderProfiles) {
      for (const avcCodec of avcCandidates) {
        try {
          const vSup = await VideoEncoder.isConfigSupported({
            codec: avcCodec,
            width,
            height,
            bitrate: targetBitrate,
            framerate: fps,
            hardwareAcceleration: profile.hardwareAcceleration,
            ...(profile.latencyMode ? { latencyMode: profile.latencyMode } : {}),
            ...(profile.bitrateMode ? { bitrateMode: profile.bitrateMode } : {}),
          });
          if (vSup.supported) {
            return {
              container: 'mp4' as const,
              videoCodec: avcCodec,
              audioCodec: 'mp4a.40.2',
              bitrate: targetBitrate,
              audioBitrate,
              hardwareAcceleration: profile.hardwareAcceleration,
              latencyMode: profile.latencyMode,
              bitrateMode: profile.bitrateMode,
            };
          }
        } catch {
          // try next
        }
      }
    }
  }

  // Fallback to WebM (VP9 Level 6.1 / 6.0 / 5.1 / 5.0 / VP8 + Opus)
  if (opusSup.supported) {
    const vpCandidates = [
      'vp09.00.61.08',
      'vp09.00.60.08',
      'vp09.00.51.08',
      'vp09.00.50.08',
      'vp09.00.41.08',
      'vp8',
    ];
    for (const profile of encoderProfiles) {
      for (const vpCodec of vpCandidates) {
        try {
          const vSup = await VideoEncoder.isConfigSupported({
            codec: vpCodec,
            width,
            height,
            bitrate: targetBitrate,
            framerate: fps,
            hardwareAcceleration: profile.hardwareAcceleration,
            ...(profile.latencyMode ? { latencyMode: profile.latencyMode } : {}),
            ...(profile.bitrateMode ? { bitrateMode: profile.bitrateMode } : {}),
          });
          if (vSup.supported) {
            return {
              container: 'webm' as const,
              videoCodec: vpCodec,
              audioCodec: 'opus',
              bitrate: targetBitrate,
              audioBitrate,
              hardwareAcceleration: profile.hardwareAcceleration,
              latencyMode: profile.latencyMode,
              bitrateMode: profile.bitrateMode,
            };
          }
        } catch {
          // try next
        }
      }
    }
  }

  return null;
}

function resampleStereoAudioBuffer(
  source: AudioBuffer,
  targetSampleRate: number
): Promise<AudioBuffer> {
  if (source.sampleRate === targetSampleRate && source.numberOfChannels >= 2) {
    return Promise.resolve(source);
  }
  const length = Math.max(1, Math.ceil(source.duration * targetSampleRate));
  const offline = new OfflineAudioContext(2, length, targetSampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = source;
  srcNode.connect(offline.destination);
  srcNode.start(0);
  return offline.startRendering();
}

async function seekVideoExact(
  videoEl: HTMLVideoElement,
  targetSec: number
): Promise<void> {
  if (!Number.isFinite(targetSec)) return;
  const maxDur =
    Number.isFinite(videoEl.duration) && videoEl.duration > 0
      ? videoEl.duration
      : targetSec;
  const clamped = Math.max(0, Math.min(Math.max(0, maxDur - 0.015), targetSec));

  if (
    !videoEl.seeking &&
    Math.abs(videoEl.currentTime - clamped) < 0.0005 &&
    videoEl.readyState >= 2
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      videoEl.removeEventListener('seeked', onSeeked);
      videoEl.removeEventListener('canplay', done);
      videoEl.removeEventListener('error', done);
      resolve();
    };
    const onSeeked = () => {
      if (videoEl.readyState >= 2) {
        done();
      } else {
        videoEl.addEventListener('canplay', done, { once: true });
      }
    };
    const timer = window.setTimeout(done, 3000);
    videoEl.addEventListener('seeked', onSeeked, { once: true });
    videoEl.addEventListener('error', done, { once: true });
    try {
      videoEl.currentTime = clamped;
    } catch {
      done();
    }
  });
}

type VideoElementWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (
      now: number,
      metadata: { mediaTime: number; presentedFrames: number }
    ) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Advances an offscreen HTMLVideoElement sequentially using adaptive playbackRate (0.25x..2.5x)
 * and requestVideoFrameCallback presented-frame tracking so canvas.drawImage() never paints
 * compositor-buffered frames lagging behind HTMLVideoElement.currentTime.
 */
class SequentialMvVideoReader {
  private videoEl: VideoElementWithRvfc;
  private maxSeekableSec: number;
  private hasDoneInitialSeek = false;
  private playPromise: Promise<void> | null = null;
  private rvfcHandle: number | null = null;
  private hasRvfcFrameSinceSeek = false;
  private lastRvfcMediaTime = 0;
  private disposed = false;
  private frameWaiters = new Set<() => void>();

  constructor(videoEl: HTMLVideoElement, fallbackDurSec: number) {
    this.videoEl = videoEl as VideoElementWithRvfc;
    const rawDur =
      Number.isFinite(videoEl.duration) && videoEl.duration > 0
        ? videoEl.duration
        : fallbackDurSec;
    this.maxSeekableSec = Math.max(0, rawDur - 0.02);
    this.scheduleNextRvfc();
  }

  private scheduleNextRvfc() {
    if (this.disposed || typeof this.videoEl.requestVideoFrameCallback !== 'function') {
      return;
    }
    this.rvfcHandle = this.videoEl.requestVideoFrameCallback((_now, metadata) => {
      if (this.disposed) return;
      if (Number.isFinite(metadata.mediaTime)) {
        this.lastRvfcMediaTime = metadata.mediaTime;
        this.hasRvfcFrameSinceSeek = true;
      }
      if (this.frameWaiters.size > 0) {
        const waiters = Array.from(this.frameWaiters);
        this.frameWaiters.clear();
        for (const w of waiters) w();
      }
      this.scheduleNextRvfc();
    });
  }

  public dispose() {
    this.disposed = true;
    if (
      this.rvfcHandle !== null &&
      typeof this.videoEl.cancelVideoFrameCallback === 'function'
    ) {
      try {
        this.videoEl.cancelVideoFrameCallback(this.rvfcHandle);
      } catch {
        // ignore
      }
      this.rvfcHandle = null;
    }
    const waiters = Array.from(this.frameWaiters);
    this.frameWaiters.clear();
    for (const w of waiters) w();
  }

  private getEffectiveVideoTime(): number {
    const clockT = this.videoEl.currentTime || 0;
    if (!this.hasRvfcFrameSinceSeek || this.videoEl.paused) {
      return clockT;
    }
    // Use actual presented GPU frame timestamp when playing so compositor lag never slips through
    return Math.min(clockT, this.lastRvfcMediaTime);
  }

  private waitForNextFrameOrTick(maxMs = 6): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.frameWaiters.delete(done);
        resolve();
      };
      this.frameWaiters.add(done);
      const timer = window.setTimeout(done, maxMs);
    });
  }

  private safePlay() {
    if (!this.videoEl.paused || this.videoEl.ended || this.playPromise) return;
    const p = this.videoEl
      .play()
      .catch(() => {})
      .finally(() => {
        if (this.playPromise === p) this.playPromise = null;
      });
    this.playPromise = p;
  }

  private safePause() {
    if (!this.videoEl.paused) {
      try {
        this.videoEl.pause();
      } catch {
        // ignore
      }
    }
  }

  private tunePlaybackRate(measuredRenderFps: number, outputFps: number, diffSec: number) {
    const baseRatio = Math.max(
      0.25,
      Math.min(2.2, measuredRenderFps / Math.max(1, outputFps))
    );
    // Smooth proportional servo around target time to keep GPU texture phase-locked without deep buffering:
    let targetRate = baseRatio;
    if (diffSec < -0.006) {
      targetRate = baseRatio * 0.5;
    } else if (diffSec > 0.025) {
      targetRate = baseRatio * 1.35 + 0.15;
    }
    const clampedRate = Math.max(0.25, Math.min(2.5, targetRate));
    if (Math.abs(this.videoEl.playbackRate - clampedRate) > 0.05) {
      try {
        this.videoEl.playbackRate = clampedRate;
      } catch {
        // ignore
      }
    }
  }

  async syncTo(
    targetSec: number,
    measuredRenderFps: number,
    outputFps: number,
    isCancelled: () => boolean
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(this.maxSeekableSec, targetSec));

    // Hold final frame cleanly once MV finishes (for MVs shorter than the song)
    if (
      this.hasDoneInitialSeek &&
      clamped >= this.maxSeekableSec - 0.002 &&
      Math.abs(this.getEffectiveVideoTime() - this.maxSeekableSec) < 0.05
    ) {
      this.safePause();
      return;
    }

    const cur = this.getEffectiveVideoTime();
    const diff = clamped - cur;

    // 1. Initial frame OR large timeline jump (intro -> normal, mid-break jump, outro jump)
    if (!this.hasDoneInitialSeek || diff < -0.15 || diff > 0.5) {
      this.safePause();
      this.hasRvfcFrameSinceSeek = false;
      await seekVideoExact(this.videoEl, clamped);
      this.lastRvfcMediaTime = this.videoEl.currentTime || clamped;
      this.hasDoneInitialSeek = true;
      return;
    }

    // 2. Hard pause immediately if video got > 14ms ahead of target
    if (diff < -0.014) {
      this.safePause();
      return;
    }

    // 3. Real presented frame is already inside [-14ms .. +4ms] sync window -> zero-wait immediate frame!
    if (diff <= 0.004 && this.videoEl.readyState >= 2) {
      this.tunePlaybackRate(measuredRenderFps, outputFps, diff);
      this.safePlay();
      return;
    }

    // 4. Advance sequentially until actual presented GPU frame catches up to target
    this.tunePlaybackRate(measuredRenderFps, outputFps, diff);
    this.safePlay();

    const deadline = performance.now() + 260;
    while (
      !isCancelled() &&
      !this.videoEl.ended &&
      this.getEffectiveVideoTime() < clamped - 0.004
    ) {
      if (performance.now() >= deadline) {
        this.safePause();
        this.hasRvfcFrameSinceSeek = false;
        await seekVideoExact(this.videoEl, clamped);
        this.lastRvfcMediaTime = this.videoEl.currentTime || clamped;
        return;
      }
      await this.waitForNextFrameOrTick(4);
    }

    if (this.getEffectiveVideoTime() > clamped + 0.014) {
      this.safePause();
    }
  }
}

async function prepareOfflineMvAssets(mvRecord: TrackMvRecord): Promise<{
  videoEl: HTMLVideoElement;
  mvAudioBuffer: AudioBuffer | null;
  dispose: () => void;
} | null> {
  let blobUrl: string | null = null;
  const srcUrl = mvRecord.videoBlob
    ? (blobUrl = URL.createObjectURL(mvRecord.videoBlob))
    : mvRecord.externalUrl || '';

  if (!srcUrl) return null;

  const videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.defaultMuted = true;
  videoEl.playsInline = true;
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');
  videoEl.preload = 'auto';
  if (!mvRecord.videoBlob && mvRecord.sourceType === 'url') {
    videoEl.crossOrigin = 'anonymous';
  }
  // CRITICAL: Keep the video inside the viewport behind stage layers so mobile/desktop Chromium
  // never culls or suspends hardware video decoding as off-screen (-9999px) content.
  videoEl.style.position = 'fixed';
  videoEl.style.left = '0';
  videoEl.style.top = '0';
  videoEl.style.width = '64px';
  videoEl.style.height = '36px';
  videoEl.style.opacity = '0.002';
  videoEl.style.zIndex = '-1';
  videoEl.style.visibility = 'visible';
  videoEl.style.pointerEvents = 'none';
  document.body.appendChild(videoEl);
  videoEl.src = srcUrl;
  try {
    videoEl.load();
  } catch {
    // ignore
  }

  const dispose = () => {
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch {
      // ignore
    }
    try {
      videoEl.remove();
    } catch {
      // ignore
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
  };

  try {
    const loadedOk = await new Promise<boolean>((resolve) => {
      if (videoEl.readyState >= 2) return resolve(true);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        videoEl.removeEventListener('loadeddata', onData);
        videoEl.removeEventListener('canplay', onData);
        videoEl.removeEventListener('loadedmetadata', onMeta);
        videoEl.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onData = () => finish(true);
      const onMeta = () => {
        if (videoEl.readyState >= 2) {
          finish(true);
        } else {
          // Wake up hardware decoder on mobile Chrome if preload stalled at HAVE_METADATA
          videoEl
            .play()
            .then(() => {
              videoEl.pause();
              if (videoEl.readyState >= 2) finish(true);
            })
            .catch(() => {});
        }
      };
      const onErr = () => finish(false);
      const timer = window.setTimeout(() => finish(videoEl.readyState >= 2), 25000);
      videoEl.addEventListener('loadeddata', onData, { once: true });
      videoEl.addEventListener('canplay', onData, { once: true });
      videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
      videoEl.addEventListener('error', onErr, { once: true });
    });

    if (videoEl.readyState < 2) {
      await videoEl.play().catch(() => {});
      videoEl.pause();
      await seekVideoExact(videoEl, 0);
    }

    if (!loadedOk && videoEl.readyState < 2) {
      dispose();
      return null;
    }

    // Verify drawImage won't taint the canvas only for external URLs (local videoBlob is always same-origin)
    if (!mvRecord.videoBlob) {
      try {
        const testCanvas = document.createElement('canvas');
        testCanvas.width = 4;
        testCanvas.height = 4;
        const tCtx = testCanvas.getContext('2d');
        if (tCtx) {
          tCtx.drawImage(videoEl, 0, 0, 4, 4);
          tCtx.getImageData(0, 0, 1, 1);
        }
      } catch {
        dispose();
        return null;
      }
    }

    // Decode MV audio track if present (silent fallback if MV has no audio or CORS blocks fetch)
    let mvAudioBuffer: AudioBuffer | null = null;
    try {
      let arrBuf: ArrayBuffer | null = null;
      if (mvRecord.videoBlob) {
        arrBuf = await mvRecord.videoBlob.arrayBuffer();
      } else if (mvRecord.externalUrl) {
        const res = await fetch(mvRecord.externalUrl);
        if (res.ok) arrBuf = await res.arrayBuffer();
      }
      if (arrBuf && arrBuf.byteLength > 0) {
        const mvDecodeCtx = new AudioContext();
        try {
          const decodedMv = await mvDecodeCtx.decodeAudioData(arrBuf);
          arrBuf = null;
          mvAudioBuffer = await resampleStereoAudioBuffer(decodedMv, 48000);
        } finally {
          await mvDecodeCtx.close().catch(() => {});
        }
      }
    } catch {
      mvAudioBuffer = null;
    }

    return { videoEl, mvAudioBuffer, dispose };
  } catch {
    dispose();
    return null;
  }
}

function pickBestMediaRecorderMime(): {
  mimeType: string;
  extension: 'mp4' | 'webm';
} {
  const candidates: { mime: string; ext: 'mp4' | 'webm' }[] = [
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) {
      return { mimeType: c.mime, extension: c.ext };
    }
  }
  return { mimeType: 'video/webm', extension: 'webm' };
}

/**
 * Renders the exact Fullscreen Webpage Player Stage (Square non-rotating cover,
 * Title + Composer/Artist only, Unboxed 3-Line flowing synced lyrics in active font,
 * plus optional MV theater integration) at custom FPS (30-120) and custom time range.
 * Always prefers deterministic offline WebCodecs rendering (including MV!) for zero-drop quality.
 */
export function startStageVideoRender(
  options: StageRenderOptions
): StageRenderController {
  let cancelled = false;
  let pauseRequested = false;
  let finishEarlyRequested = false;
  let monitorGainRef: GainNode | null = null;
  let isMonitorMuted = Boolean(options.monitorMuted ?? true);

  const dims = QUALITY_DIMENSIONS[options.quality] || QUALITY_DIMENSIONS['720p'];
  const width = dims.width;
  const height = dims.height;
  const fps = Math.max(30, Math.min(120, Math.round(options.fps || 60)));
  const requestedStartSec = Math.max(0, options.startOffsetSec || 0);
  const allowIntro = options.includeMvIntro !== false;
  const allowMidBreaks = options.includeMvMidBreaks !== false;
  const allowOutro = options.includeMvOutro !== false;

  const cloneBuf = (src?: AllowSharedBufferSource): ArrayBuffer | undefined => {
    if (!src) return undefined;
    const out = new ArrayBuffer(src.byteLength);
    if (ArrayBuffer.isView(src)) {
      new Uint8Array(out).set(
        new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
      );
    } else {
      new Uint8Array(out).set(new Uint8Array(src));
    }
    return out;
  };

  const promise = (async (): Promise<StageRenderResult> => {
    try {
      await document.fonts?.ready;
    } catch {
      // ignore if fonts api unavailable
    }

    const coverImg = await loadImageElement(options.track.coverDataUrl);
    const hasUsableMv = Boolean(
      options.includeMvInVideo &&
        options.mvRecord &&
        (options.mvRecord.videoBlob || options.mvRecord.externalUrl)
    );

    const validResumeCp =
      options.resumeCheckpoint &&
      options.resumeCheckpoint.meta &&
      options.resumeCheckpoint.meta.width === width &&
      options.resumeCheckpoint.meta.height === height &&
      options.resumeCheckpoint.meta.fps === fps &&
      options.resumeCheckpoint.meta.nextFrameIdx > 0 &&
      options.resumeCheckpoint.batches.length > 0
        ? options.resumeCheckpoint
        : null;

    const codecSupport = validResumeCp
      ? validResumeCp.meta.codecSupport
      : await probeWebCodecsSupport(width, height, 48000, fps);

    // Path A: Deterministic Offline Frame-by-Frame WebCodecs Render (Stage-only AND Stage + MV!)
    // Exact constant frame timestamps + interleaved audio + quality rate-control = zero stutter.
    if (codecSupport) {
      let offlineMv: Awaited<ReturnType<typeof prepareOfflineMvAssets>> = null;
      if (hasUsableMv && options.mvRecord) {
        options.onProgress?.({
          percent: validResumeCp
            ? Math.min(96, Math.round((validResumeCp.meta.nextFrameIdx / validResumeCp.meta.totalFrames) * 96))
            : 1,
          elapsedSec: validResumeCp ? validResumeCp.meta.nextFrameIdx / fps : 0,
          totalSec: Math.max(3, Math.round(options.track.duration || 30)),
          phaseLabel: validResumeCp
            ? '正在恢复 MV 视频流与已保存编码断点...'
            : '正在准备 MV 视频流与高精度音频轨道...',
          engineLabel: `WebCodecs ${codecSupport.container.toUpperCase()} · ${fps} fps`,
        });
        offlineMv = await prepareOfflineMvAssets(options.mvRecord);
      }

      // If MV was requested and offline canvas access was possible (or no MV was requested), run Path A
      if (!hasUsableMv || offlineMv) {
        const painter = new StageCanvasPainter({
          width,
          height,
          track: options.track,
          coverImg,
          showBilingual: options.showBilingual,
          showWordSync: options.showWordSync,
          fontPreset: options.fontPreset,
          hasMvVideo: Boolean(offlineMv),
        });
        const parsedLines = painter.getLines();
        const hasSynced = painter.getHasSynced();

        let mp4Muxer: Mp4Muxer<Mp4StreamTarget> | null = null;
        let webmMuxer: WebmMuxer<WebmStreamTarget> | null = null;
        let videoEncoder: VideoEncoder | null = null;
        let audioEncoder: AudioEncoder | null = null;
        let sequentialMvReader: SequentialMvVideoReader | null = null;
        const sink = new PagedBlobSink();

        try {
          const decodeCtx = new AudioContext();
          let decodedSongBuffer: AudioBuffer | null;
          try {
            const arrBuf = await options.audioBlob.arrayBuffer();
            decodedSongBuffer = await decodeCtx.decodeAudioData(arrBuf);
          } finally {
            await decodeCtx.close().catch(() => {});
          }

          let songResampled: AudioBuffer | null = await resampleStereoAudioBuffer(
            decodedSongBuffer,
            48000
          );
          decodedSongBuffer = null;

          const mvVideoEl = offlineMv?.videoEl || null;
          let songAnalyzer: OfflineAudioAnalyzer | null = mvVideoEl
            ? null
            : new OfflineAudioAnalyzer(songResampled);

          const songDuration = songResampled.duration || options.track.duration || 10;
          const safeStart = Math.min(Math.max(0, songDuration - 1), requestedStartSec);

          const timeline = options.mvRecord?.timeline || createDefaultMvTimeline();
          const sortedBreaks = normalizeMidBreaks(timeline.midBreaks || []);
          const mvDuration =
            (mvVideoEl && Number.isFinite(mvVideoEl.duration) && mvVideoEl.duration > 0
              ? mvVideoEl.duration
              : options.mvRecord?.durationSec) || 0;

          const visualTimeline = {
            ...timeline,
            introEnabled: allowIntro && timeline.introEnabled,
            midBreaks: allowMidBreaks ? timeline.midBreaks : [],
            outroEnabled: allowOutro && timeline.outroEnabled,
          };

          const hasIntro = Boolean(
            mvVideoEl &&
              allowIntro &&
              safeStart <= 0.1 &&
              timeline.introEnabled &&
              timeline.introEndSec > 0.35
          );
          const completedBreaks = new Set<string>();
          if (safeStart > 0.1 && mvVideoEl) {
            for (const brk of sortedBreaks) {
              if (safeStart > brk.audioTriggerSec + 0.15) {
                completedBreaks.add(brk.id);
              }
            }
          }

          const introLen = hasIntro ? timeline.introEndSec : 0;
          const breaksLen =
            mvVideoEl && allowMidBreaks
              ? sortedBreaks
                  .filter((b) => !completedBreaks.has(b.id))
                  .reduce((acc, b) => acc + (b.mvEndSec - b.mvStartSec), 0)
              : 0;
          const endSyncMv = computeSyncedMvTime(
            songDuration,
            timeline,
            new Set(sortedBreaks.map((b) => b.id))
          );
          const outroEnd = timeline.outroEndSec || mvDuration;
          const outroLen =
            mvVideoEl && allowOutro && timeline.outroEnabled && outroEnd > endSyncMv + 0.4
              ? outroEnd - endSyncMv
              : 0;

          const fullRemainingTheater =
            introLen + Math.max(1, songDuration - safeStart) + breaksLen + outroLen;
          const targetDuration = validResumeCp
            ? validResumeCp.meta.targetDuration
            : options.clipDurationSec && options.clipDurationSec > 1
            ? Math.min(fullRemainingTheater, options.clipDurationSec)
            : fullRemainingTheater;

          const totalFrames = validResumeCp
            ? validResumeCp.meta.totalFrames
            : Math.max(1, Math.ceil(targetDuration * fps));
          let encodeError: Error | null = null;
          const isMp4 = codecSupport.container === 'mp4';

          if (isMp4) {
            mp4Muxer = new Mp4Muxer({
              target: new Mp4StreamTarget({
                onData: (data, pos) => sink.write(pos, data),
                chunked: false,
              }),
              video: { codec: 'avc', width, height, frameRate: fps },
              audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 },
              fastStart: false,
              firstTimestampBehavior: 'cross-track-offset',
            });
          } else {
            webmMuxer = new WebmMuxer({
              target: new WebmStreamTarget({
                onData: (data, pos) => sink.write(pos, data),
                chunked: false,
              }),
              video: {
                codec: codecSupport.videoCodec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
                width,
                height,
                frameRate: fps,
              },
              audio: { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: 48000 },
              firstTimestampBehavior: 'offset',
            });
          }

          const checkpointingEnabled = Boolean(options.checkpointTaskId && options.onCheckpoint);
          let batchVideoChunks: MvExportChunkBatch['videoChunks'] = [];
          let batchAudioChunks: MvExportChunkBatch['audioChunks'] = [];
          let chunkBatchIndex = validResumeCp ? validResumeCp.meta.chunkBatchCount : 0;

          let capturedVideoDecoderConfig: MvExportCheckpointMeta['videoDecoderConfig'] =
            validResumeCp?.meta.videoDecoderConfig;
          let capturedAudioDecoderConfig: MvExportCheckpointMeta['audioDecoderConfig'] =
            validResumeCp?.meta.audioDecoderConfig;

          // Rehydrate any saved GOP chunk batches straight into the fresh muxer
          if (validResumeCp) {
            let sentVideoMeta = false;
            let sentAudioMeta = false;
            const vMeta = capturedVideoDecoderConfig
              ? ({
                  decoderConfig: {
                    ...capturedVideoDecoderConfig,
                    description: capturedVideoDecoderConfig.description
                      ? new Uint8Array(capturedVideoDecoderConfig.description)
                      : undefined,
                  },
                } as EncodedVideoChunkMetadata)
              : undefined;
            const aMeta = capturedAudioDecoderConfig
              ? ({
                  decoderConfig: {
                    ...capturedAudioDecoderConfig,
                    description: capturedAudioDecoderConfig.description
                      ? new Uint8Array(capturedAudioDecoderConfig.description)
                      : undefined,
                  },
                } as EncodedAudioChunkMetadata)
              : undefined;

            for (const batch of validResumeCp.batches) {
              for (const vc of batch.videoChunks) {
                const raw = new Uint8Array(vc.data);
                const m = !sentVideoMeta ? vMeta : undefined;
                sentVideoMeta = true;
                if (mp4Muxer) {
                  mp4Muxer.addVideoChunkRaw(raw, vc.type, vc.timestamp, vc.duration, m, vc.cts);
                } else if (webmMuxer) {
                  webmMuxer.addVideoChunkRaw(raw, vc.type, vc.timestamp, m);
                }
              }
              for (const ac of batch.audioChunks) {
                const raw = new Uint8Array(ac.data);
                const m = !sentAudioMeta ? aMeta : undefined;
                sentAudioMeta = true;
                if (mp4Muxer) {
                  mp4Muxer.addAudioChunkRaw(raw, ac.type, ac.timestamp, ac.duration, m);
                } else if (webmMuxer) {
                  webmMuxer.addAudioChunkRaw(raw, ac.type, ac.timestamp, m);
                }
              }
            }
          }

          // Monotonic DTS + non-negative CTS guard + sample-exact audio alignment for B-frame H.264 encoders.
          const encodedVideoInputTsQueue: number[] = [];
          const pendingVideoInitChunks: Array<{
            chunk: EncodedVideoChunk;
            meta?: EncodedVideoChunkMetadata;
            dts: number;
          }> = [];
          const initReorderInspectCount = Math.min(totalFrames, Math.max(18, fps + 2));
          let reorderResolved = validResumeCp ? true : !isMp4;
          let audioReleaseReady = validResumeCp ? true : !isMp4;
          let reorderShiftUs = validResumeCp ? validResumeCp.meta.reorderShiftUs : 0;
          let lastEmittedVideoDtsUs = validResumeCp
            ? validResumeCp.meta.lastEmittedVideoDtsUs
            : -1;

          const AUDIO_CHUNK_SAMPLES = 2048;
          const pendingAudioL = new Float32Array(AUDIO_CHUNK_SAMPLES);
          const pendingAudioR = new Float32Array(AUDIO_CHUNK_SAMPLES);
          let pendingAudioCount = 0;
          let totalAudioSamplesEncoded = 0;
          let sessionAckedAudioSamples = 0;
          const isResumedAudioSession = Boolean(validResumeCp);
          const resumedAudioBaseUs = validResumeCp ? validResumeCp.meta.emittedAudioEndUs : 0;
          let emittedAudioEndUs = validResumeCp ? validResumeCp.meta.emittedAudioEndUs : 0;
          let lastEmittedAudioTsUs = validResumeCp ? validResumeCp.meta.lastEmittedAudioTsUs : -1;

          const queuedRawAudio: Array<{ l: Float32Array; r: Float32Array; count: number }> = [];
          const recentAudioPcmQueue: Array<{
            startSample: number;
            l: Float32Array;
            r: Float32Array;
            count: number;
          }> = [];

          const encodeAudioBlockNow = (lBuf: Float32Array, rBuf: Float32Array, count: number) => {
            if (!audioEncoder || count <= 0) return;
            const startSample = totalAudioSamplesEncoded;
            if (checkpointingEnabled) {
              recentAudioPcmQueue.push({
                startSample,
                l: lBuf.slice(0, count),
                r: rBuf.slice(0, count),
                count,
              });
              while (
                recentAudioPcmQueue.length > 0 &&
                recentAudioPcmQueue[0].startSample + recentAudioPcmQueue[0].count <=
                  sessionAckedAudioSamples
              ) {
                recentAudioPcmQueue.shift();
              }
            }
            const planar = new Float32Array(count * 2);
            planar.set(lBuf.subarray(0, count), 0);
            planar.set(rBuf.subarray(0, count), count);
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: 48000,
              numberOfFrames: count,
              numberOfChannels: 2,
              timestamp: Math.round((totalAudioSamplesEncoded * 1_000_000) / 48000),
              data: planar,
            });
            audioEncoder.encode(audioData);
            audioData.close();
            totalAudioSamplesEncoded += count;
          };

          const recordEncodedVideoChunk = (
            chunk: EncodedVideoChunk,
            meta: EncodedVideoChunkMetadata | undefined,
            ptsUs: number,
            ctsUs: number
          ) => {
            if (!checkpointingEnabled) return;
            if (!capturedVideoDecoderConfig && meta?.decoderConfig) {
              capturedVideoDecoderConfig = {
                codec: meta.decoderConfig.codec,
                codedWidth: meta.decoderConfig.codedWidth,
                codedHeight: meta.decoderConfig.codedHeight,
                displayAspectWidth: meta.decoderConfig.displayAspectWidth,
                displayAspectHeight: meta.decoderConfig.displayAspectHeight,
                description: cloneBuf(meta.decoderConfig.description),
              };
            }
            const data = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(data);
            batchVideoChunks.push({
              data,
              type: chunk.type,
              timestamp: ptsUs,
              duration: chunk.duration ?? Math.round(1_000_000 / fps),
              cts: ctsUs,
            });
          };

          const flushResolvedInitialChunks = () => {
            if (reorderResolved) return;
            reorderResolved = true;
            let minDiff = 0;
            for (const item of pendingVideoInitChunks) {
              const diff = item.chunk.timestamp - item.dts;
              if (diff < minDiff) minDiff = diff;
            }
            reorderShiftUs = minDiff < 0 ? -minDiff : 0;

            for (const item of pendingVideoInitChunks) {
              const shiftedPts = item.chunk.timestamp + reorderShiftUs;
              const safeDts =
                lastEmittedVideoDtsUs >= 0
                  ? Math.max(lastEmittedVideoDtsUs + 1, item.dts)
                  : item.dts;
              const safePts = Math.max(safeDts, shiftedPts);
              const cts = Math.max(0, safePts - safeDts);
              lastEmittedVideoDtsUs = safeDts;
              const muxMeta = isResumedAudioSession ? undefined : item.meta;
              mp4Muxer?.addVideoChunk(item.chunk, muxMeta, safePts, cts);
              recordEncodedVideoChunk(item.chunk, item.meta, safePts, cts);
            }
            pendingVideoInitChunks.length = 0;

            let leadSilenceSamples =
              reorderShiftUs > 0 ? Math.round((reorderShiftUs * 48000) / 1_000_000) : 0;
            if (leadSilenceSamples > 0) {
              const zeroL = new Float32Array(AUDIO_CHUNK_SAMPLES);
              const zeroR = new Float32Array(AUDIO_CHUNK_SAMPLES);
              while (leadSilenceSamples > 0) {
                const n = Math.min(AUDIO_CHUNK_SAMPLES, leadSilenceSamples);
                encodeAudioBlockNow(zeroL, zeroR, n);
                leadSilenceSamples -= n;
              }
            }

            audioReleaseReady = true;
            for (const block of queuedRawAudio) {
              encodeAudioBlockNow(block.l, block.r, block.count);
            }
            queuedRawAudio.length = 0;
          };

          videoEncoder = new VideoEncoder({
            output: (chunk, meta) => {
              if (!isMp4) {
                const muxMeta = validResumeCp ? undefined : meta;
                webmMuxer?.addVideoChunk(chunk, muxMeta);
                recordEncodedVideoChunk(chunk, meta, chunk.timestamp, 0);
                return;
              }
              const dts = encodedVideoInputTsQueue.shift() ?? chunk.timestamp;
              if (!reorderResolved) {
                pendingVideoInitChunks.push({ chunk, meta, dts });
                if (pendingVideoInitChunks.length >= initReorderInspectCount) {
                  flushResolvedInitialChunks();
                }
                return;
              }
              const shiftedPts = chunk.timestamp + reorderShiftUs;
              const safeDts =
                lastEmittedVideoDtsUs >= 0
                  ? Math.max(lastEmittedVideoDtsUs + 1, dts)
                  : dts;
              const safePts = Math.max(safeDts, shiftedPts);
              const cts = Math.max(0, safePts - safeDts);
              lastEmittedVideoDtsUs = safeDts;
              const muxMeta = validResumeCp ? undefined : meta;
              mp4Muxer?.addVideoChunk(chunk, muxMeta, safePts, cts);
              recordEncodedVideoChunk(chunk, meta, safePts, cts);
            },
            error: (e) => {
              encodeError = e instanceof Error ? e : new Error(String(e));
            },
          });

          audioEncoder = new AudioEncoder({
            output: (chunk, meta) => {
              const rawTs = isResumedAudioSession
                ? Math.max(
                    lastEmittedAudioTsUs + 1,
                    resumedAudioBaseUs + Math.max(0, chunk.timestamp)
                  )
                : Math.max(0, chunk.timestamp);
              lastEmittedAudioTsUs = rawTs;
              const durUs = chunk.duration ?? Math.round((1024 * 1_000_000) / 48000);
              emittedAudioEndUs = Math.max(emittedAudioEndUs, rawTs + durUs);
              sessionAckedAudioSamples += Math.max(0, Math.round((durUs * 48000) / 1_000_000));

              const muxMeta = validResumeCp ? undefined : meta;
              if (!isMp4) {
                webmMuxer?.addAudioChunk(chunk, muxMeta, rawTs);
              } else {
                mp4Muxer?.addAudioChunk(chunk, muxMeta, rawTs);
              }

              if (checkpointingEnabled) {
                if (!capturedAudioDecoderConfig && meta?.decoderConfig) {
                  capturedAudioDecoderConfig = {
                    codec: meta.decoderConfig.codec,
                    numberOfChannels: meta.decoderConfig.numberOfChannels,
                    sampleRate: meta.decoderConfig.sampleRate,
                    description: cloneBuf(meta.decoderConfig.description),
                  };
                }
                const data = new ArrayBuffer(chunk.byteLength);
                chunk.copyTo(data);
                batchAudioChunks.push({
                  data,
                  type: chunk.type,
                  timestamp: rawTs,
                  duration: durUs,
                });
              }
            },
            error: (e) => {
              encodeError = e instanceof Error ? e : new Error(String(e));
            },
          });

          videoEncoder.configure({
            codec: codecSupport.videoCodec,
            width,
            height,
            bitrate: codecSupport.bitrate,
            framerate: fps,
            hardwareAcceleration: codecSupport.hardwareAcceleration,
            ...(codecSupport.latencyMode
              ? { latencyMode: codecSupport.latencyMode }
              : {}),
            ...(codecSupport.bitrateMode
              ? { bitrateMode: codecSupport.bitrateMode }
              : {}),
          });

          audioEncoder.configure({
            codec: codecSupport.audioCodec,
            numberOfChannels: 2,
            sampleRate: 48000,
            bitrate: codecSupport.audioBitrate,
          });

          let songL: Float32Array | null = songResampled.getChannelData(0);
          let songR: Float32Array | null =
            songResampled.numberOfChannels > 1 ? songResampled.getChannelData(1) : songL;
          let mvL: Float32Array | null = offlineMv?.mvAudioBuffer
            ? offlineMv.mvAudioBuffer.getChannelData(0)
            : null;
          let mvR: Float32Array | null = offlineMv?.mvAudioBuffer
            ? offlineMv.mvAudioBuffer.numberOfChannels > 1
              ? offlineMv.mvAudioBuffer.getChannelData(1)
              : mvL
            : null;

          const flushAudioChunk = (force = false) => {
            if (!audioEncoder || pendingAudioCount === 0) return;
            if (!force && pendingAudioCount < AUDIO_CHUNK_SAMPLES) return;
            const count = pendingAudioCount;
            if (!audioReleaseReady) {
              queuedRawAudio.push({
                l: pendingAudioL.slice(0, count),
                r: pendingAudioR.slice(0, count),
                count,
              });
            } else {
              encodeAudioBlockNow(pendingAudioL, pendingAudioR, count);
            }
            pendingAudioCount = 0;
          };

          const pushMixedStereoSamples = (
            phaseVal: MvTheaterPhase,
            songStartSample: number,
            mvStartSample: number,
            songGainVal: number,
            mvGainVal: number,
            sampleCount: number
          ) => {
            const isSongActive =
              phaseVal === 'normal' && songGainVal > 0.0001 && Boolean(songL && songR);
            const isMvActive = Boolean(mvL && mvR) && mvGainVal > 0.0001;

            for (let i = 0; i < sampleCount; i++) {
              let l = 0;
              let r = 0;
              if (isSongActive && songL && songR) {
                const si = songStartSample + i;
                if (si >= 0 && si < songL.length) {
                  l += songL[si] * songGainVal;
                  r += songR[si] * songGainVal;
                }
              }
              if (isMvActive && mvL && mvR) {
                const mi = mvStartSample + i;
                if (mi >= 0 && mi < mvL.length) {
                  l += mvL[mi] * mvGainVal;
                  r += mvR[mi] * mvGainVal;
                }
              }
              pendingAudioL[pendingAudioCount] = l > 1 ? 1 : l < -1 ? -1 : l;
              pendingAudioR[pendingAudioCount] = r > 1 ? 1 : r < -1 ? -1 : r;
              pendingAudioCount++;
              if (pendingAudioCount === AUDIO_CHUNK_SAMPLES) {
                flushAudioChunk(true);
              }
            }
          };

          // Pre-load unacked audio tail from resumed checkpoint so zero samples are lost across pause/crash
          if (validResumeCp && validResumeCp.meta.rewindAudioCount > 0) {
            const rwL = new Float32Array(validResumeCp.meta.rewindAudioL);
            const rwR = new Float32Array(validResumeCp.meta.rewindAudioR);
            const rwCount = Math.min(validResumeCp.meta.rewindAudioCount, rwL.length, rwR.length);
            for (let i = 0; i < rwCount; i++) {
              pendingAudioL[pendingAudioCount] = rwL[i];
              pendingAudioR[pendingAudioCount] = rwR[i];
              pendingAudioCount++;
              if (pendingAudioCount === AUDIO_CHUNK_SAMPLES) {
                flushAudioChunk(true);
              }
            }
          }

          let phase: MvTheaterPhase = validResumeCp
            ? validResumeCp.meta.phase
            : hasIntro
            ? 'intro'
            : 'normal';
          let mvPhaseTime = validResumeCp ? validResumeCp.meta.mvPhaseTime : 0;
          let curAudioTime = validResumeCp
            ? validResumeCp.meta.curAudioTime
            : hasIntro
            ? 0
            : safeStart;
          if (validResumeCp) {
            completedBreaks.clear();
            for (const bid of validResumeCp.meta.completedBreakIds) {
              completedBreaks.add(bid);
            }
          }
          let activeMidBreak: MvMidBreakRange | null = validResumeCp
            ? validResumeCp.meta.activeMidBreak
            : null;
          let outroStartMvSec = validResumeCp ? validResumeCp.meta.outroStartMvSec : 0;

          const initIdx = validResumeCp
            ? validResumeCp.meta.drawState.activeIdx
            : hasSynced
            ? findActiveLyricIndex(
                parsedLines,
                curAudioTime,
                options.track.lyricsOffsetMs || 0
              )
            : parsedLines.length > 0
            ? 0
            : -1;

          const emptyAudioFrame: AudioAnalysisFrame = {
            bass: 0,
            mid: 0,
            high: 0,
            volume: 0,
            frequencies: new Uint8Array(128),
            waveform: new Uint8Array(128),
          };

          const drawState: StageDrawContextState = validResumeCp
            ? {
                timeSec: validResumeCp.meta.nextFrameIdx / fps,
                audioTime: curAudioTime,
                audioDuration: songDuration,
                mvPhase: phase,
                mvPhaseTime,
                uiOpacity: 1,
                isTheaterClarity: Boolean(mvVideoEl),
                frame: songAnalyzer ? songAnalyzer.sampleAt(curAudioTime) : emptyAudioFrame,
                smoothBass: validResumeCp.meta.drawState.smoothBass,
                smoothMid: validResumeCp.meta.drawState.smoothMid,
                smoothVol: validResumeCp.meta.drawState.smoothVol,
                activeIdx: validResumeCp.meta.drawState.activeIdx,
                prevIdx: validResumeCp.meta.drawState.prevIdx,
                lineTransitionElapsedSec: validResumeCp.meta.drawState.lineTransitionElapsedSec,
                stepDirection: validResumeCp.meta.drawState.stepDirection,
              }
            : {
                timeSec: curAudioTime,
                audioTime: curAudioTime,
                audioDuration: songDuration,
                mvPhase: phase,
                mvPhaseTime: 0,
                uiOpacity: hasIntro ? 0 : 1,
                isTheaterClarity: Boolean(mvVideoEl),
                frame: songAnalyzer ? songAnalyzer.sampleAt(curAudioTime) : emptyAudioFrame,
                smoothBass: 0,
                smoothMid: 0,
                smoothVol: 0,
                activeIdx: initIdx,
                prevIdx: initIdx,
                lineTransitionElapsedSec: 1,
                stepDirection: 'none',
              };

          const renderStartPerf = performance.now();
          let lastYieldPerf = renderStartPerf;
          let lastProgressPerf = -1000;
          let actualRenderedSec = targetDuration;
          const dt = 1 / fps;
          const keyframeInterval = fps; // 1-second GOP for smooth scrubbing & zero decode stalls
          const checkpointIntervalFrames = Math.max(fps * 6, 180);
          const lyricsOffsetMs = options.track.lyricsOffsetMs || 0;
          const containerLabel =
            codecSupport.container === 'mp4'
              ? `WebCodecs MP4 (高画质) · ${fps} fps`
              : `WebCodecs WebM (高画质) · ${fps} fps`;

          sequentialMvReader = mvVideoEl
            ? new SequentialMvVideoReader(mvVideoEl, mvDuration)
            : null;

          let songSampleCursor = validResumeCp
            ? validResumeCp.meta.songSampleCursor
            : Math.round(curAudioTime * 48000);
          let mvSampleCursor = validResumeCp
            ? validResumeCp.meta.mvSampleCursor
            : hasIntro
            ? 0
            : Math.round(
                (computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                  (timeline.syncOffsetSec || 0)) *
                  48000
              );

          const resumeStartFrameIdx = validResumeCp ? validResumeCp.meta.nextFrameIdx : 0;

          const buildAndEmitCheckpoint = async (completedFrameIdx: number) => {
            if (!checkpointingEnabled || !options.checkpointTaskId || !options.onCheckpoint) return;
            await videoEncoder?.flush();
            flushResolvedInitialChunks();
            for (let w = 0; w < 10 && audioEncoder && audioEncoder.encodeQueueSize > 0; w++) {
              await yieldImmediate();
            }

            // Collect unacked PCM samples + any sub-chunk residual in pendingAudioL/R
            const unackedPartsL: Float32Array[] = [];
            const unackedPartsR: Float32Array[] = [];
            let unackedTotal = 0;
            for (const blk of recentAudioPcmQueue) {
              const blkEnd = blk.startSample + blk.count;
              if (blkEnd <= sessionAckedAudioSamples) continue;
              const sliceFrom = Math.max(0, sessionAckedAudioSamples - blk.startSample);
              const sliceCount = blk.count - sliceFrom;
              if (sliceCount > 0) {
                unackedPartsL.push(blk.l.subarray(sliceFrom, blk.count));
                unackedPartsR.push(blk.r.subarray(sliceFrom, blk.count));
                unackedTotal += sliceCount;
              }
            }
            if (pendingAudioCount > 0) {
              unackedPartsL.push(pendingAudioL.subarray(0, pendingAudioCount));
              unackedPartsR.push(pendingAudioR.subarray(0, pendingAudioCount));
              unackedTotal += pendingAudioCount;
            }
            const rwL = new Float32Array(unackedTotal);
            const rwR = new Float32Array(unackedTotal);
            let rwCursor = 0;
            for (let i = 0; i < unackedPartsL.length; i++) {
              rwL.set(unackedPartsL[i], rwCursor);
              rwR.set(unackedPartsR[i], rwCursor);
              rwCursor += unackedPartsL[i].length;
            }

            const hasNewChunks = batchVideoChunks.length > 0 || batchAudioChunks.length > 0;
            const batchToPersist: MvExportChunkBatch | null = hasNewChunks
              ? {
                  id: `${options.checkpointTaskId}:${chunkBatchIndex}`,
                  taskId: options.checkpointTaskId,
                  batchIndex: chunkBatchIndex,
                  videoChunks: batchVideoChunks,
                  audioChunks: batchAudioChunks,
                }
              : null;

            if (hasNewChunks) {
              chunkBatchIndex++;
              batchVideoChunks = [];
              batchAudioChunks = [];
            }

            const cpMeta: MvExportCheckpointMeta = {
              taskId: options.checkpointTaskId,
              engineKind: isMp4 ? 'webcodecs-mp4' : 'webcodecs-webm',
              codecSupport: { ...codecSupport },
              width,
              height,
              fps,
              songDuration,
              mvDuration,
              targetDuration,
              totalFrames,
              safeStart,
              hasIntro,
              includeMvIntro: allowIntro,
              includeMvMidBreaks: allowMidBreaks,
              includeMvOutro: allowOutro,
              hasMvVideo: Boolean(mvVideoEl),
              nextFrameIdx: completedFrameIdx + 1,
              phase,
              mvPhaseTime,
              curAudioTime,
              completedBreakIds: Array.from(completedBreaks),
              activeMidBreak,
              outroStartMvSec,
              songSampleCursor,
              mvSampleCursor,
              lastEmittedVideoDtsUs,
              reorderShiftUs,
              totalAudioSamplesEncoded,
              emittedAudioEndUs,
              lastEmittedAudioTsUs,
              rewindAudioL: rwL.buffer,
              rewindAudioR: rwR.buffer,
              rewindAudioCount: unackedTotal,
              drawState: {
                smoothBass: drawState.smoothBass,
                smoothMid: drawState.smoothMid,
                smoothVol: drawState.smoothVol,
                activeIdx: drawState.activeIdx,
                prevIdx: drawState.prevIdx,
                lineTransitionElapsedSec: drawState.lineTransitionElapsedSec,
                stepDirection: drawState.stepDirection,
              },
              videoDecoderConfig: capturedVideoDecoderConfig,
              audioDecoderConfig: capturedAudioDecoderConfig,
              chunkBatchCount: chunkBatchIndex,
              updatedAt: Date.now(),
            };

            await options.onCheckpoint(cpMeta, batchToPersist);
          };

          for (let frameIdx = resumeStartFrameIdx; frameIdx < totalFrames; frameIdx++) {
            if (cancelled) {
              throw new Error('已取消导出渲染');
            }
            if (encodeError) throw encodeError;

            const relTime = frameIdx / fps;
            if (finishEarlyRequested && frameIdx > fps * 2) {
              actualRenderedSec = relTime;
              break;
            }

            const curMvSeekTime = mvVideoEl
              ? phase === 'normal'
                ? computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                  (timeline.syncOffsetSec || 0)
                : mvPhaseTime
              : 0;

            const visual = mvVideoEl
              ? computeTheaterVisualState({
                  phase,
                  mvPhaseTime,
                  timeline: visualTimeline,
                  activeMidBreak,
                  audioTime: curAudioTime,
                  audioDuration: songDuration,
                  mvDurationSec: mvDuration,
                  completedBreakIds: completedBreaks,
                  fadeInSec: options.mvUiFadeInSec ?? timeline.fadeTransitionSec,
                  fadeOutSec: options.mvUiFadeOutSec ?? timeline.fadeTransitionSec,
                  outroStartMvSec,
                  allowIntroTailCrossfade: hasIntro,
                })
              : {
                  uiOpacity: 1,
                  isTheaterClarity: false,
                  skipLabel: null,
                  skipSubLabel: null,
                  songAudioGain: 1,
                  mvAudioGain: 0,
                };

            // Sample exact frame-aligned audio spectrum & synthesize mixed PCM samples
            const outSampleStart = Math.round((frameIdx * 48000) / fps);
            const outSampleEnd = Math.round(((frameIdx + 1) * 48000) / fps);
            const frameSampleCount = Math.max(0, outSampleEnd - outSampleStart);
            pushMixedStereoSamples(
              phase,
              songSampleCursor,
              mvSampleCursor,
              visual.songAudioGain,
              visual.mvAudioGain,
              frameSampleCount
            );
            if (phase === 'normal') {
              songSampleCursor += frameSampleCount;
            }
            mvSampleCursor += frameSampleCount;

            // Sync MV video sequentially at adaptive encoder-matched speed (zero per-frame keyframe flushes)
            if (sequentialMvReader) {
              const localRenderedCount = frameIdx - resumeStartFrameIdx;
              const elapsedSoFar = (performance.now() - renderStartPerf) / 1000;
              const estRenderFps =
                localRenderedCount >= 8 && elapsedSoFar > 0.08
                  ? (localRenderedCount + 1) / elapsedSoFar
                  : Math.max(fps, 90);
              await sequentialMvReader.syncTo(
                curMvSeekTime,
                estRenderFps,
                fps,
                () => cancelled
              );
              if (cancelled) throw new Error('已取消导出渲染');
            }

            drawState.timeSec = relTime;
            drawState.audioTime = curAudioTime;
            drawState.mvPhase = phase;
            drawState.mvPhaseTime = mvPhaseTime;
            drawState.uiOpacity = visual.uiOpacity;
            drawState.isTheaterClarity = visual.isTheaterClarity;
            drawState.frame =
              !mvVideoEl && songAnalyzer
                ? songAnalyzer.sampleAt(curAudioTime)
                : emptyAudioFrame;

            advanceFlowState(
              drawState,
              parsedLines,
              hasSynced,
              lyricsOffsetMs,
              dt
            );

            const isLastFrame = frameIdx === totalFrames - 1;
            painter.drawFrame(
              drawState,
              mvVideoEl,
              options.previewCanvas,
              frameIdx === resumeStartFrameIdx || isLastFrame
            );

            const tsUs = Math.round((frameIdx * 1_000_000) / fps);
            const nextTsUs = Math.round(((frameIdx + 1) * 1_000_000) / fps);
            const durUs = Math.max(1, nextTsUs - tsUs);

            const vf = new VideoFrame(painter.getCanvas(), {
              timestamp: tsUs,
              duration: durUs,
            });
            if (isMp4) {
              encodedVideoInputTsQueue.push(tsUs);
            }
            const forceKeyFrame =
              frameIdx === resumeStartFrameIdx ||
              frameIdx % keyframeInterval === 0;
            videoEncoder.encode(vf, { keyFrame: forceKeyFrame });
            vf.close();

            // Advance theater timeline state deterministically by 1 frame (dt)
            let reachedEnd = false;
            if (phase === 'intro' && mvVideoEl) {
              mvPhaseTime += dt;
              if (mvPhaseTime >= timeline.introEndSec - 1e-4) {
                phase = 'normal';
                curAudioTime = 0;
                songSampleCursor = 0;
                mvSampleCursor = Math.round(
                  (computeSyncedMvTime(0, timeline, completedBreaks) +
                    (timeline.syncOffsetSec || 0)) *
                    48000
                );
              }
            } else if (phase === 'mid-break' && activeMidBreak && mvVideoEl) {
              mvPhaseTime += dt;
              if (mvPhaseTime >= activeMidBreak.mvEndSec - 1e-4) {
                completedBreaks.add(activeMidBreak.id);
                curAudioTime = activeMidBreak.audioTriggerSec + 0.03;
                songSampleCursor = Math.round(curAudioTime * 48000);
                mvSampleCursor = Math.round(
                  (computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                    (timeline.syncOffsetSec || 0)) *
                    48000
                );
                activeMidBreak = null;
                phase = 'normal';
              }
            } else if (phase === 'outro' && mvVideoEl) {
              mvPhaseTime += dt;
              if (outroEnd > 0 && mvPhaseTime >= outroEnd - 1e-4) {
                reachedEnd = true;
              }
            } else {
              if (mvVideoEl) {
                if (!allowMidBreaks) {
                  // Mark skipped mid-breaks as passed once song time crosses trigger so MV stays song-aligned
                  for (const brk of sortedBreaks) {
                    if (!completedBreaks.has(brk.id) && curAudioTime >= brk.audioTriggerSec) {
                      completedBreaks.add(brk.id);
                      mvSampleCursor = Math.round(
                        (computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                          (timeline.syncOffsetSec || 0)) *
                          48000
                      );
                    }
                  }
                }
                const triggered = allowMidBreaks
                  ? findTriggeredMidBreak(curAudioTime, timeline, completedBreaks)
                  : null;
                if (triggered) {
                  activeMidBreak = triggered;
                  phase = 'mid-break';
                  mvPhaseTime = triggered.mvStartSec;
                  mvSampleCursor = Math.round(triggered.mvStartSec * 48000);
                } else if (curAudioTime + dt >= songDuration - 0.02) {
                  if (outroLen > 0.3) {
                    phase = 'outro';
                    outroStartMvSec = endSyncMv;
                    mvPhaseTime = endSyncMv;
                    mvSampleCursor = Math.round(endSyncMv * 48000);
                  } else {
                    reachedEnd = true;
                  }
                } else {
                  curAudioTime += dt;
                }
              } else {
                if (curAudioTime + dt >= songDuration - 0.01) {
                  reachedEnd = true;
                } else {
                  curAudioTime += dt;
                }
              }
            }

            if (pauseRequested && !isLastFrame && !reachedEnd) {
              await buildAndEmitCheckpoint(frameIdx);
              throw new StageRenderPausedError();
            }

            if (
              checkpointingEnabled &&
              reorderResolved &&
              !isLastFrame &&
              !reachedEnd &&
              frameIdx > resumeStartFrameIdx &&
              (frameIdx - resumeStartFrameIdx) % checkpointIntervalFrames === 0
            ) {
              await buildAndEmitCheckpoint(frameIdx);
            }

            if (reachedEnd) {
              actualRenderedSec = (frameIdx + 1) / fps;
              break;
            }

            const nowPerf = performance.now();
            const needsVideoBackpressure = videoEncoder.encodeQueueSize > 8;
            const needsAudioBackpressure = audioEncoder.encodeQueueSize > 24;
            const needsUiTick = nowPerf - lastYieldPerf >= 32 || frameIdx === resumeStartFrameIdx;

            if (needsVideoBackpressure || needsAudioBackpressure || needsUiTick || isLastFrame) {
              if (nowPerf - lastProgressPerf >= 90 || frameIdx === resumeStartFrameIdx || isLastFrame) {
                lastProgressPerf = nowPerf;
                const elapsedWall = (nowPerf - renderStartPerf) / 1000;
                const localDone = frameIdx - resumeStartFrameIdx + 1;
                const phaseLabel = mvVideoEl
                  ? phase === 'intro'
                    ? `正在逐帧无丢帧合成 MV 前瞻片段 (${fps} fps)...`
                    : phase === 'mid-break'
                    ? `正在逐帧无丢帧合成 MV 中段剧情 (${fps} fps)...`
                    : phase === 'outro'
                    ? `正在逐帧无丢帧合成 MV 后段尾声 (${fps} fps)...`
                    : `正在逐帧高精度合成 MV + 网页舞台 (${fps} fps)...`
                  : `正在以 ${fps} fps 高画质离线合成画面...`;

                options.onProgress?.({
                  percent: Math.min(98, ((frameIdx + 1) / totalFrames) * 96),
                  elapsedSec: relTime,
                  totalSec: targetDuration,
                  phaseLabel,
                  engineLabel: containerLabel,
                  fps: elapsedWall > 0.1 ? Math.round(localDone / elapsedWall) : undefined,
                });
              }

              if (needsVideoBackpressure || needsAudioBackpressure) {
                while (
                  (videoEncoder.encodeQueueSize > 4 || audioEncoder.encodeQueueSize > 16) &&
                  !cancelled &&
                  !encodeError
                ) {
                  await yieldImmediate();
                }
              } else {
                await yieldImmediate();
              }
              lastYieldPerf = performance.now();
            }
          }

          flushAudioChunk(true);

          options.onProgress?.({
            percent: 98,
            elapsedSec: actualRenderedSec,
            totalSec: targetDuration,
            phaseLabel: '正在完成编解码并释放渲染内存...',
            engineLabel: `${codecSupport.container.toUpperCase()} · ${fps} fps`,
          });

          await videoEncoder.flush();
          flushResolvedInitialChunks();
          await audioEncoder.flush();
          if (encodeError) throw encodeError;

          // Release heavy codec instances, audio PCM arrays, and offscreen canvases before finalizing Blob
          try {
            if (videoEncoder.state !== 'closed') videoEncoder.close();
          } catch {
            // ignore
          }
          try {
            if (audioEncoder.state !== 'closed') audioEncoder.close();
          } catch {
            // ignore
          }
          videoEncoder = null;
          audioEncoder = null;
          encodedVideoInputTsQueue.length = 0;
          pendingVideoInitChunks.length = 0;
          queuedRawAudio.length = 0;
          sequentialMvReader?.dispose();
          offlineMv?.dispose();
          if (offlineMv) offlineMv.mvAudioBuffer = null;
          offlineMv = null;
          decodedSongBuffer = null;
          songResampled = null;
          songL = null;
          songR = null;
          mvL = null;
          mvR = null;
          songAnalyzer = null;
          painter.dispose();

          // Give browser GC a clean macrotask tick before finalizing container boxes
          await new Promise<void>((r) => setTimeout(r, 20));

          options.onProgress?.({
            percent: 98.8,
            elapsedSec: actualRenderedSec,
            totalSec: targetDuration,
            phaseLabel: '正在流式写入视频索引并生成最终文件...',
            engineLabel: `${codecSupport.container.toUpperCase()} · ${fps} fps`,
          });

          if (mp4Muxer) {
            mp4Muxer.finalize();
            mp4Muxer = null;
            const videoBlob = await sink.toBlob('video/mp4');
            return {
              videoBlob,
              mimeType: 'video/mp4',
              extension: 'mp4',
              durationSec: actualRenderedSec,
              width,
              height,
              fps,
              engineUsed: 'webcodecs-mp4',
            };
          }

          webmMuxer!.finalize();
          webmMuxer = null;
          const videoBlob = await sink.toBlob('video/webm');
          return {
            videoBlob,
            mimeType: 'video/webm',
            extension: 'webm',
            durationSec: actualRenderedSec,
            width,
            height,
            fps,
            engineUsed: 'webcodecs-webm',
          };
        } finally {
          try {
            if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close();
          } catch {
            // ignore
          }
          try {
            if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
          } catch {
            // ignore
          }
          sequentialMvReader?.dispose();
          sequentialMvReader = null;
          offlineMv?.dispose();
          painter.dispose();
          sink.dispose();
        }
      }
    }

    // Path B Fallback: Only used if WebCodecs is unsupported or an external URL MV blocks canvas CORS
    const painter = new StageCanvasPainter({
      width,
      height,
      track: options.track,
      coverImg,
      showBilingual: options.showBilingual,
      showWordSync: options.showWordSync,
      fontPreset: options.fontPreset,
      hasMvVideo: hasUsableMv,
    });
    const parsedLines = painter.getLines();
    const hasSynced = painter.getHasSynced();

    // Path B: Synchronized Real-Time MV Theater + Audio Compositing via MediaRecorder
    const audioUrl = URL.createObjectURL(options.audioBlob);
    let mvUrl: string | null = null;
    if (hasUsableMv && options.mvRecord) {
      mvUrl = options.mvRecord.videoBlob
        ? URL.createObjectURL(options.mvRecord.videoBlob)
        : options.mvRecord.externalUrl || null;
    }

    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.src = audioUrl;

    let videoEl: HTMLVideoElement | null = null;
    if (mvUrl) {
      videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.defaultMuted = true;
      videoEl.playsInline = true;
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', '');
      videoEl.preload = 'auto';
      if (options.mvRecord?.sourceType === 'url') {
        videoEl.crossOrigin = 'anonymous';
      }
      videoEl.style.position = 'fixed';
      videoEl.style.left = '0';
      videoEl.style.top = '0';
      videoEl.style.width = '64px';
      videoEl.style.height = '36px';
      videoEl.style.opacity = '0.002';
      videoEl.style.zIndex = '-1';
      videoEl.style.visibility = 'visible';
      videoEl.style.pointerEvents = 'none';
      document.body.appendChild(videoEl);
      videoEl.src = mvUrl;
      try {
        videoEl.load();
      } catch {
        // ignore
      }
    }

    const isoCtx = new AudioContext();
    const analyser = isoCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.78;
    const freqArr = new Uint8Array(analyser.frequencyBinCount);
    const waveArr = new Uint8Array(analyser.frequencyBinCount);

    const songGain = isoCtx.createGain();
    const mvGain = isoCtx.createGain();
    const mixBus = isoCtx.createGain();
    const dest = isoCtx.createMediaStreamDestination();
    const monitorGain = isoCtx.createGain();
    monitorGain.gain.value = isMonitorMuted ? 0 : 1;
    monitorGainRef = monitorGain;

    let songAudioBuffer: AudioBuffer | null = null;
    try {
      const ab = await options.audioBlob.arrayBuffer();
      songAudioBuffer = await isoCtx.decodeAudioData(ab);
    } catch {
      songAudioBuffer = null;
    }

    if (!songAudioBuffer) {
      const audioSource = isoCtx.createMediaElementSource(audioEl);
      audioSource.connect(songGain);
    }
    songGain.connect(mixBus);

    let mvSourceAttached = false;
    if (videoEl) {
      try {
        const mvSource = isoCtx.createMediaElementSource(videoEl);
        mvSource.connect(mvGain);
        mvGain.connect(mixBus);
        mvSourceAttached = true;
      } catch {
        mvSourceAttached = false;
      }
    }

    mixBus.connect(analyser);
    analyser.connect(dest);
    mixBus.connect(monitorGain);
    monitorGain.connect(isoCtx.destination);

    let activeSongSource: AudioBufferSourceNode | null = null;
    let songPlayCtxStart = 0;
    let songPlayOffsetSec = 0;
    let songSourcePlaying = false;
    let songEnded = false;

    const cleanup = () => {
      monitorGainRef = null;
      if (activeSongSource) {
        activeSongSource.onended = null;
        try {
          activeSongSource.stop();
        } catch {
          // ignore
        }
        try {
          activeSongSource.disconnect();
        } catch {
          // ignore
        }
        activeSongSource = null;
      }
      songAudioBuffer = null;
      try {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
      } catch {
        // ignore
      }
      if (videoEl) {
        try {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.load();
          videoEl.remove();
        } catch {
          // ignore
        }
      }
      URL.revokeObjectURL(audioUrl);
      if (mvUrl && options.mvRecord?.videoBlob) {
        URL.revokeObjectURL(mvUrl);
      }
      isoCtx.close().catch(() => {});
    };

    try {
      await Promise.all([
        songAudioBuffer
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              if (audioEl.readyState >= 1) return resolve();
              const onReady = () => resolve();
              audioEl.addEventListener('loadedmetadata', onReady, { once: true });
              audioEl.addEventListener('error', onReady, { once: true });
              setTimeout(resolve, 4000);
            }),
        videoEl
          ? new Promise<void>((resolve) => {
              if (videoEl!.readyState >= 2) return resolve();
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                videoEl!.removeEventListener('loadeddata', finish);
                videoEl!.removeEventListener('canplay', finish);
                videoEl!.removeEventListener('loadedmetadata', onMeta);
                videoEl!.removeEventListener('error', finish);
                resolve();
              };
              const onMeta = () => {
                if (videoEl!.readyState >= 2) {
                  finish();
                } else {
                  videoEl!
                    .play()
                    .then(() => {
                      videoEl!.pause();
                      if (videoEl!.readyState >= 2) finish();
                    })
                    .catch(() => {});
                }
              };
              const timer = setTimeout(finish, 18000);
              videoEl!.addEventListener('loadeddata', finish, { once: true });
              videoEl!.addEventListener('canplay', finish, { once: true });
              videoEl!.addEventListener('loadedmetadata', onMeta, { once: true });
              videoEl!.addEventListener('error', finish, { once: true });
            })
          : Promise.resolve(),
      ]);

      if (videoEl && videoEl.readyState < 2) {
        await videoEl.play().catch(() => {});
        videoEl.pause();
        await seekVideoExact(videoEl, 0);
      }

      await isoCtx.resume().catch(() => {});

      const songDuration =
        songAudioBuffer && songAudioBuffer.duration > 0
          ? songAudioBuffer.duration
          : Number.isFinite(audioEl.duration) && audioEl.duration > 0
          ? audioEl.duration
          : options.track.duration || 10;
      const timeline = options.mvRecord?.timeline || createDefaultMvTimeline();
      const sortedBreaks = normalizeMidBreaks(timeline.midBreaks || []);
      const mvDuration =
        (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0
          ? videoEl.duration
          : options.mvRecord?.durationSec) || 0;

      const visualTimeline = {
        ...timeline,
        introEnabled: allowIntro && timeline.introEnabled,
        midBreaks: allowMidBreaks ? timeline.midBreaks : [],
        outroEnabled: allowOutro && timeline.outroEnabled,
      };

      const safeStart = Math.min(Math.max(0, songDuration - 1), requestedStartSec);
      songPlayOffsetSec = safeStart;
      const hasIntro = Boolean(
        videoEl &&
          allowIntro &&
          safeStart <= 0.1 &&
          timeline.introEnabled &&
          timeline.introEndSec > 0.35
      );
      const completedBreaks = new Set<string>();
      if (safeStart > 0.1) {
        for (const brk of sortedBreaks) {
          if (safeStart > brk.audioTriggerSec + 0.15) {
            completedBreaks.add(brk.id);
          }
        }
      }

      let phase: MvTheaterPhase = hasIntro ? 'intro' : 'normal';
      let mvPhaseTime = 0;
      let activeMidBreak: MvMidBreakRange | null = null;
      let outroStartMvSec = 0;

      const introLen = hasIntro ? timeline.introEndSec : 0;
      const breaksLen =
        videoEl && allowMidBreaks
          ? sortedBreaks
              .filter((b) => !completedBreaks.has(b.id))
              .reduce((acc, b) => acc + (b.mvEndSec - b.mvStartSec), 0)
          : 0;
      const endSyncMv = computeSyncedMvTime(
        songDuration,
        timeline,
        new Set(sortedBreaks.map((b) => b.id))
      );
      const outroEnd = timeline.outroEndSec || mvDuration;
      const outroLen =
        videoEl && allowOutro && timeline.outroEnabled && outroEnd > endSyncMv + 0.4
          ? outroEnd - endSyncMv
          : 0;
      const fullRemainingTheater =
        introLen + Math.max(1, songDuration - safeStart) + breaksLen + outroLen;
      const targetDuration =
        options.clipDurationSec && options.clipDurationSec > 1
          ? Math.min(fullRemainingTheater, options.clipDurationSec)
          : fullRemainingTheater;

      const { mimeType, extension } = pickBestMediaRecorderMime();
      const canvasStream = painter.getCanvas().captureStream(fps);
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: getTargetBitrate(width, fps),
        audioBitsPerSecond: 192_000,
      });
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      const recorderStopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      const initIdx = hasSynced
        ? findActiveLyricIndex(parsedLines, safeStart, options.track.lyricsOffsetMs || 0)
        : parsedLines.length > 0
        ? 0
        : -1;

      const drawState: StageDrawContextState = {
        timeSec: safeStart,
        audioTime: safeStart,
        audioDuration: songDuration,
        mvPhase: phase,
        mvPhaseTime: 0,
        uiOpacity: hasIntro ? 0 : 1,
        isTheaterClarity: Boolean(videoEl),
        frame: {
          bass: 0,
          mid: 0,
          high: 0,
          volume: 0,
          frequencies: freqArr,
          waveform: waveArr,
        },
        smoothBass: 0,
        smoothMid: 0,
        smoothVol: 0,
        activeIdx: initIdx,
        prevIdx: initIdx,
        lineTransitionElapsedSec: 1,
        stepDirection: 'none',
      };

      const stopSongPlayback = () => {
        if (songAudioBuffer) {
          if (songSourcePlaying) {
            songPlayOffsetSec = Math.min(
              songDuration,
              songPlayOffsetSec + Math.max(0, isoCtx.currentTime - songPlayCtxStart)
            );
            songSourcePlaying = false;
          }
          if (activeSongSource) {
            activeSongSource.onended = null;
            try {
              activeSongSource.stop();
            } catch {
              // ignore
            }
            try {
              activeSongSource.disconnect();
            } catch {
              // ignore
            }
            activeSongSource = null;
          }
        } else {
          audioEl.pause();
        }
      };

      const startSongPlaybackAt = (offsetSec: number) => {
        const clamped = Math.max(0, Math.min(songDuration, offsetSec));
        if (songAudioBuffer) {
          stopSongPlayback();
          songPlayOffsetSec = clamped;
          if (clamped >= songDuration - 0.02) {
            songEnded = true;
            return;
          }
          songEnded = false;
          const src = isoCtx.createBufferSource();
          src.buffer = songAudioBuffer;
          src.connect(songGain);
          src.onended = () => {
            if (activeSongSource === src) {
              songSourcePlaying = false;
              songPlayOffsetSec = songDuration;
              songEnded = true;
              activeSongSource = null;
            }
          };
          if (isoCtx.state === 'suspended') {
            isoCtx.resume().catch(() => {});
          }
          songPlayCtxStart = isoCtx.currentTime;
          songSourcePlaying = true;
          src.start(0, clamped);
          activeSongSource = src;
        } else {
          songEnded = false;
          audioEl.currentTime = clamped;
          audioEl.play().catch(() => {});
        }
      };

      const getCurSongTime = (): number => {
        if (songAudioBuffer) {
          if (songEnded) return songDuration;
          if (!songSourcePlaying) return songPlayOffsetSec;
          return Math.min(
            songDuration,
            songPlayOffsetSec + Math.max(0, isoCtx.currentTime - songPlayCtxStart)
          );
        }
        return audioEl.currentTime || 0;
      };

      if (hasIntro && videoEl) {
        songGain.gain.value = 0;
        mvGain.gain.value = 1;
        videoEl.muted = mvSourceAttached;
        videoEl.currentTime = 0;
        if (!songAudioBuffer) {
          // Unlock fallback audioEl while songGain is 0 so later intro->normal play isn't blocked
          await audioEl.play().catch(() => {});
          audioEl.pause();
          audioEl.currentTime = 0;
        }
        await videoEl.play().catch(() => {});
      } else {
        songGain.gain.value = 1;
        mvGain.gain.value = 0;
        if (videoEl) {
          videoEl.muted = true;
          videoEl.currentTime =
            computeSyncedMvTime(safeStart, timeline, completedBreaks) +
            (timeline.syncOffsetSec || 0);
          await videoEl.play().catch(() => {});
        }
        startSongPlaybackAt(safeStart);
      }

      recorder.start(250);

      let wallElapsed = 0;
      let lastTick = performance.now();
      if (!songAudioBuffer) {
        audioEl.onended = () => {
          songEnded = true;
        };
      }

      let pathBLastPresentedMvTime: number | null = null;
      let pathBRvfcHandle: number | null = null;
      const videoRvfc = videoEl as VideoElementWithRvfc | null;
      const startPathBRvfc = () => {
        if (!videoRvfc || typeof videoRvfc.requestVideoFrameCallback !== 'function') return;
        pathBRvfcHandle = videoRvfc.requestVideoFrameCallback((_now, metadata) => {
          if (finishedPathB) return;
          if (Number.isFinite(metadata.mediaTime)) {
            pathBLastPresentedMvTime = metadata.mediaTime;
          }
          startPathBRvfc();
        });
      };
      let finishedPathB = false;
      const getPathBMvTime = (): number => {
        if (!videoEl) return 0;
        const clockT = videoEl.currentTime || 0;
        if (pathBLastPresentedMvTime !== null && !videoEl.paused) {
          return Math.min(clockT, pathBLastPresentedMvTime);
        }
        return clockT;
      };
      const syncPathBVideoServo = (expectedMv: number) => {
        if (!videoEl) return;
        const curMv = getPathBMvTime();
        const diff = expectedMv - curMv;
        if (Math.abs(diff) > 0.14) {
          try {
            pathBLastPresentedMvTime = null;
            videoEl.currentTime = expectedMv;
            videoEl.playbackRate = 1;
          } catch {
            // ignore
          }
        } else if (Math.abs(diff) > 0.012) {
          const targetRate = Math.max(0.9, Math.min(1.1, 1 + diff * 0.9));
          if (Math.abs(videoEl.playbackRate - targetRate) > 0.005) {
            try {
              videoEl.playbackRate = targetRate;
            } catch {
              // ignore
            }
          }
        } else if (Math.abs(videoEl.playbackRate - 1) > 0.005) {
          try {
            videoEl.playbackRate = 1;
          } catch {
            // ignore
          }
        }
      };

      await new Promise<void>((resolve, reject) => {
        const frameIntervalMs = Math.max(8, Math.round(1000 / fps));
        let finished = false;
        startPathBRvfc();

        const finishRecording = (wasCancelled: boolean, wasPaused = false) => {
          if (finished) return;
          finished = true;
          finishedPathB = true;
          if (
            pathBRvfcHandle !== null &&
            videoRvfc &&
            typeof videoRvfc.cancelVideoFrameCallback === 'function'
          ) {
            try {
              videoRvfc.cancelVideoFrameCallback(pathBRvfcHandle);
            } catch {
              // ignore
            }
          }
          stopSongPlayback();
          canvasStream.getTracks().forEach((t) => t.stop());
          if (wasCancelled || wasPaused) {
            try {
              if (recorder.state !== 'inactive') recorder.stop();
            } catch {
              // ignore
            }
            reject(
              wasPaused
                ? new StageRenderPausedError()
                : new Error('已取消导出渲染')
            );
          } else {
            resolve();
          }
        };

        const tick = () => {
          if (cancelled) {
            finishRecording(true, false);
            return;
          }
          if (pauseRequested) {
            finishRecording(false, true);
            return;
          }

          const now = performance.now();
          const dt = Math.min(0.1, Math.max(0.004, (now - lastTick) / 1000));
          lastTick = now;
          wallElapsed += dt;

          if (finishEarlyRequested || wallElapsed >= targetDuration) {
            finishRecording(false);
            return;
          }

          let curAudioTime = getCurSongTime();

          if (phase === 'intro' && videoEl) {
            const actualMv = getPathBMvTime();
            // Lock intro progress to actual presented MV frames so song never triggers before MV arrives
            mvPhaseTime = actualMv > 0.01 ? actualMv : Math.min(mvPhaseTime + dt, 0.08);
            if (mvPhaseTime >= timeline.introEndSec - 0.03 || videoEl.ended) {
              phase = 'normal';
              startSongPlaybackAt(0);
              curAudioTime = getCurSongTime();
              const expectedMv =
                computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                (timeline.syncOffsetSec || 0);
              syncPathBVideoServo(expectedMv);
            }
          } else if (phase === 'mid-break' && activeMidBreak && videoEl) {
            const actualMv = getPathBMvTime();
            mvPhaseTime =
              actualMv >= activeMidBreak.mvStartSec - 0.05
                ? actualMv
                : Math.min(mvPhaseTime + dt, activeMidBreak.mvStartSec + 0.08);
            if (mvPhaseTime >= activeMidBreak.mvEndSec - 0.03 || videoEl.ended) {
              completedBreaks.add(activeMidBreak.id);
              const resumeAt = activeMidBreak.audioTriggerSec + 0.03;
              activeMidBreak = null;
              phase = 'normal';
              startSongPlaybackAt(resumeAt);
              curAudioTime = getCurSongTime();
              const expectedMv =
                computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                (timeline.syncOffsetSec || 0);
              syncPathBVideoServo(expectedMv);
            }
          } else if (phase === 'outro' && videoEl) {
            const actualMv = getPathBMvTime();
            mvPhaseTime =
              actualMv >= outroStartMvSec - 0.05
                ? actualMv
                : Math.min(mvPhaseTime + dt, outroStartMvSec + 0.08);
            if (
              videoEl.ended ||
              (outroEnd > 0 && mvPhaseTime >= outroEnd - 0.03)
            ) {
              finishRecording(false);
              return;
            }
          } else {
            if (videoEl) {
              if (!allowMidBreaks) {
                for (const brk of sortedBreaks) {
                  if (!completedBreaks.has(brk.id) && curAudioTime >= brk.audioTriggerSec) {
                    completedBreaks.add(brk.id);
                  }
                }
              }
              const triggered = allowMidBreaks
                ? findTriggeredMidBreak(curAudioTime, timeline, completedBreaks)
                : null;
              if (triggered) {
                activeMidBreak = triggered;
                phase = 'mid-break';
                mvPhaseTime = triggered.mvStartSec;
                stopSongPlayback();
                pathBLastPresentedMvTime = null;
                videoEl.playbackRate = 1;
                videoEl.currentTime = triggered.mvStartSec;
                videoEl.play().catch(() => {});
              } else if (songEnded || curAudioTime >= songDuration - 0.05) {
                if (outroLen > 0.3) {
                  phase = 'outro';
                  outroStartMvSec = endSyncMv;
                  mvPhaseTime = endSyncMv;
                  stopSongPlayback();
                  pathBLastPresentedMvTime = null;
                  videoEl.playbackRate = 1;
                  videoEl.currentTime = endSyncMv;
                  videoEl.play().catch(() => {});
                } else {
                  finishRecording(false);
                  return;
                }
              } else {
                const expectedMv =
                  computeSyncedMvTime(curAudioTime, timeline, completedBreaks) +
                  (timeline.syncOffsetSec || 0);
                syncPathBVideoServo(expectedMv);
              }
            } else if (songEnded || curAudioTime >= songDuration - 0.05) {
              finishRecording(false);
              return;
            }
          }

          const visual = videoEl
            ? computeTheaterVisualState({
                phase,
                mvPhaseTime,
                timeline: visualTimeline,
                activeMidBreak,
                audioTime: curAudioTime,
                audioDuration: songDuration,
                mvDurationSec: mvDuration,
                completedBreakIds: completedBreaks,
                fadeInSec: options.mvUiFadeInSec ?? timeline.fadeTransitionSec,
                fadeOutSec: options.mvUiFadeOutSec ?? timeline.fadeTransitionSec,
                outroStartMvSec,
                allowIntroTailCrossfade: hasIntro,
              })
            : {
                uiOpacity: 1,
                isTheaterClarity: false,
                skipLabel: null,
                skipSubLabel: null,
                songAudioGain: 1,
                mvAudioGain: 0,
              };

          songGain.gain.setTargetAtTime(visual.songAudioGain, isoCtx.currentTime, 0.018);
          if (mvSourceAttached) {
            mvGain.gain.setTargetAtTime(visual.mvAudioGain, isoCtx.currentTime, 0.018);
          } else if (videoEl) {
            videoEl.muted = visual.mvAudioGain <= 0.02;
            videoEl.volume = Math.max(0, Math.min(1, visual.mvAudioGain));
          }

          analyser.getByteFrequencyData(freqArr);
          analyser.getByteTimeDomainData(waveArr);
          let bassS = 0;
          let midS = 0;
          let highS = 0;
          for (let k = 0; k < 12; k++) bassS += freqArr[k] / 255;
          for (let k = 12; k < 56; k++) midS += freqArr[k] / 255;
          for (let k = 56; k < 140; k++) highS += freqArr[k] / 255;
          let sq = 0;
          for (let k = 0; k < waveArr.length; k++) {
            const v = (waveArr[k] - 128) / 128;
            sq += v * v;
          }

          drawState.timeSec = wallElapsed;
          drawState.audioTime = curAudioTime;
          drawState.mvPhase = phase;
          drawState.mvPhaseTime = mvPhaseTime;
          drawState.uiOpacity = visual.uiOpacity;
          drawState.isTheaterClarity = visual.isTheaterClarity;
          drawState.frame = {
            bass: Math.min(1, bassS / 12),
            mid: Math.min(1, midS / 44),
            high: Math.min(1, highS / 84),
            volume: Math.min(1, Math.sqrt(sq / waveArr.length) * 2.1),
            frequencies: freqArr,
            waveform: waveArr,
          };

          advanceFlowState(
            drawState,
            parsedLines,
            hasSynced,
            options.track.lyricsOffsetMs || 0,
            dt
          );
          painter.drawFrame(drawState, videoEl, options.previewCanvas);

          const phaseLabel =
            phase === 'intro'
              ? '正在同步录制 MV 前瞻片段...'
              : phase === 'mid-break'
              ? '正在同步录制 MV 中段剧情...'
              : phase === 'outro'
              ? '正在同步录制 MV 后段尾声...'
              : videoEl
              ? '正在实时合成 MV + 网页全屏同款画面...'
              : '正在实时渲染网页全屏同款画面...';

          options.onProgress?.({
            percent: Math.min(98, (wallElapsed / Math.max(1, targetDuration)) * 98),
            elapsedSec: wallElapsed,
            totalSec: targetDuration,
            phaseLabel,
            engineLabel: `MediaRecorder · ${fps} fps`,
            fps,
          });

          setTimeout(tick, frameIntervalMs);
        };

        setTimeout(tick, 20);
      });

      options.onProgress?.({
        percent: 99,
        elapsedSec: wallElapsed,
        totalSec: targetDuration,
        phaseLabel: '正在封装视频文件...',
        engineLabel: `MediaRecorder · ${fps} fps`,
      });

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      await recorderStopped;

      const videoBlob = new Blob(chunks, { type: mimeType });
      chunks.length = 0;
      return {
        videoBlob,
        mimeType,
        extension,
        durationSec: wallElapsed,
        width,
        height,
        fps,
        engineUsed: 'mediarecorder',
      };
    } finally {
      cleanup();
      painter.dispose();
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
    pause: () => {
      pauseRequested = true;
    },
    finishEarly: () => {
      finishEarlyRequested = true;
    },
    setMonitorMuted: (muted: boolean) => {
      isMonitorMuted = muted;
      if (monitorGainRef) {
        monitorGainRef.gain.value = muted ? 0 : 1;
      }
    },
  };
}
