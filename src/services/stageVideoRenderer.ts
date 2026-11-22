import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from 'webm-muxer';
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

export type StageVideoQuality = '720p' | '1080p';

export interface StageRenderOptions {
  track: TrackMetadata;
  audioBlob: Blob;
  mvRecord?: TrackMvRecord | null;
  includeMvInVideo: boolean;
  showBilingual: boolean;
  showWordSync: boolean;
  fontPreset?: FontPresetId;
  animationIntensity: AnimationIntensity;
  quality: StageVideoQuality;
  fps?: number; // 60 .. 120
  startOffsetSec?: number; // Custom start offset in seconds (default 0)
  clipDurationSec?: number | null; // null/undefined = full duration from startOffsetSec
  mvUiFadeInSec?: number;
  mvUiFadeOutSec?: number;
  previewCanvas?: HTMLCanvasElement | null;
  monitorMuted?: boolean;
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
 * Lightweight 256-point Radix-2 Cooley-Tukey FFT for offline audio envelope computation.
 */
class OfflineAudioAnalyzer {
  private monoSamples: Float32Array;
  private sampleRate: number;
  private readonly fftSize = 256;
  private hannWindow: Float32Array;
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

    this.hannWindow = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.fftSize - 1)));
    }
    this.real = new Float32Array(this.fftSize);
    this.imag = new Float32Array(this.fftSize);
  }

  sampleAt(timeSec: number): AudioAnalysisFrame {
    const N = this.fftSize;
    const center = Math.floor(timeSec * this.sampleRate);
    const start = Math.max(0, center - N / 2);

    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const sample = idx < this.monoSamples.length ? this.monoSamples[idx] : 0;
      sumSq += sample * sample;
      this.real[i] = sample * this.hannWindow[i];
      this.imag[i] = 0;
      if (i < 128) {
        const wIdx = start + i * 2;
        const ws = wIdx < this.monoSamples.length ? this.monoSamples[wIdx] : 0;
        this.waveform[i] = Math.max(0, Math.min(255, Math.round((ws * 0.5 + 0.5) * 255)));
      }
    }

    let j = 0;
    for (let i = 0; i < N; i++) {
      if (i < j) {
        const tr = this.real[i];
        const ti = this.imag[i];
        this.real[i] = this.real[j];
        this.imag[i] = this.imag[j];
        this.real[j] = tr;
        this.imag[j] = ti;
      }
      let m = N >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = (-2 * Math.PI) / size;
      for (let i = 0; i < N; i += size) {
        for (let k = 0; k < half; k++) {
          const angle = k * step;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const oddIdx = i + k + half;
          const tReal = cos * this.real[oddIdx] - sin * this.imag[oddIdx];
          const tImag = sin * this.real[oddIdx] + cos * this.imag[oddIdx];
          this.real[oddIdx] = this.real[i + k] - tReal;
          this.imag[oddIdx] = this.imag[i + k] - tImag;
          this.real[i + k] += tReal;
          this.imag[i + k] += tImag;
        }
      }
    }

    let bassSum = 0;
    let midSum = 0;
    let highSum = 0;

    for (let k = 0; k < 128; k++) {
      const mag =
        Math.sqrt(this.real[k] * this.real[k] + this.imag[k] * this.imag[k]) /
        (N * 0.25);
      const dbScaled = Math.max(0, Math.min(1, Math.pow(mag, 0.55)));
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
 * Draws the exact Fullscreen Player Stage shown in Lumina Music:
 * - Left half: Stationary rounded-square album cover + Title + Composer/Artist ONLY + Progress bar + Transport icons
 * - Right half: Unboxed 3-Line Real-Time Synced Lyrics (`FullscreenThreeLineLyrics`) matching exact font preset & glow
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
  private fontStack: string;
  private hasMvVideo: boolean;

  constructor(params: {
    width: number;
    height: number;
    track: TrackMetadata;
    coverImg: HTMLImageElement | null;
    showBilingual: boolean;
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
    this.fontStack = getFontStack(params.fontPreset);
    this.hasMvVideo = params.hasMvVideo;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('无法初始化 2D 渲染画布');
    this.ctx = ctx;

    this.parsed = parseLrc(this.track.lyricsRaw);
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

  drawFrame(
    state: StageDrawContextState,
    mvVideoEl?: HTMLVideoElement | null,
    previewCanvas?: HTMLCanvasElement | null
  ) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const s = this.s;

    ctx.clearRect(0, 0, W, H);

    // 1. Background: Deep cinematic black/fluid backdrop matching fullscreen mode
    this.drawBackdrop(ctx, W, H, state);

    // 2. MV Theater Video Layer (when MV video is present)
    if (mvVideoEl && mvVideoEl.readyState >= 2) {
      try {
        const vw = mvVideoEl.videoWidth || W;
        const vh = mvVideoEl.videoHeight || H;
        const scale = Math.max(W / vw, H / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (W - dw) / 2;
        const dy = (H - dh) / 2;

        ctx.save();
        ctx.globalAlpha = 1;
        ctx.drawImage(mvVideoEl, dx, dy, dw, dh);
        ctx.restore();
      } catch {
        // Fallback silently if external CORS frame blocks drawImage
      }
    }

    // 3. Fullscreen 50/50 Split Player Stage (fades smoothly with uiOpacity during MV intro/mid-break/outro)
    if (state.uiOpacity > 0.01) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, state.uiOpacity));

      this.drawLeftFullscreenDeck(ctx, W, H, s, state);
      this.drawRightThreeLineLyrics(ctx, W, H, s, state);

      ctx.restore();
    }

    // 4. Mirror live composition onto on-screen preview canvas
    if (previewCanvas) {
      const pCtx = previewCanvas.getContext('2d');
      if (pCtx) {
        if (previewCanvas.width !== W || previewCanvas.height !== H) {
          previewCanvas.width = W;
          previewCanvas.height = H;
        }
        pCtx.clearRect(0, 0, W, H);
        pCtx.drawImage(this.canvas, 0, 0);
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

    // Matching dark fluid glow backdrop when no MV is playing
    const c = this.fluidColors;
    const t = state.timeSec;
    const [ar, ag, ab] = c.abyssRgb.map((v) => Math.round(v * 0.45));
    const [dr, dg, db] = c.deepRgb.map((v) => Math.round(v * 0.55));

    const baseGrad = ctx.createLinearGradient(0, 0, W, H);
    baseGrad.addColorStop(0, `rgb(${ar}, ${ag}, ${ab})`);
    baseGrad.addColorStop(0.5, `rgb(${dr}, ${dg}, ${db})`);
    baseGrad.addColorStop(1, `rgb(${ar}, ${ag}, ${ab})`);
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, 0, W, H);

    const blobs = [
      {
        cx: W * (0.22 + Math.sin(t * 0.21) * 0.08),
        cy: H * (0.26 + Math.cos(t * 0.19) * 0.08),
        r: Math.max(W, H) * (0.48 + state.smoothBass * 0.06),
        rgb: c.silkRgb,
        alpha: 0.24 + state.smoothVol * 0.08,
      },
      {
        cx: W * (0.78 + Math.cos(t * 0.18) * 0.08),
        cy: H * (0.74 + Math.sin(t * 0.22) * 0.08),
        r: Math.max(W, H) * (0.46 + state.smoothMid * 0.05),
        rgb: c.secondaryRgb,
        alpha: 0.2 + state.smoothVol * 0.07,
      },
    ];

    for (const b of blobs) {
      const rr = Math.round(b.rgb[0]);
      const rg = Math.round(b.rgb[1]);
      const rb = Math.round(b.rgb[2]);
      const g = ctx.createRadialGradient(b.cx, b.cy, 0, b.cx, b.cy, b.r);
      g.addColorStop(0, `rgba(${rr}, ${rg}, ${rb}, ${b.alpha.toFixed(3)})`);
      g.addColorStop(0.5, `rgba(${rr}, ${rg}, ${rb}, ${(b.alpha * 0.32).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rr}, ${rg}, ${rb}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private drawLeftFullscreenDeck(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    s: number,
    state: StageDrawContextState
  ) {
    // Left 50% center (matching grid-cols-2 in PlayerPage fullscreen)
    const cx = W * 0.25;
    const coverSize = Math.round(Math.min(H * 0.38, W * 0.225)); // ~274px at 720p, ~410px at 1080p
    const coverX = cx - coverSize / 2;
    const coverY = H * 0.175;
    const cornerRadius = 26 * s;

    // 1. Stationary Square Album Cover (`FullscreenCoverFluidStage.tsx`)
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

    // 2. Song Title + Composer/Artist ONLY (removed album & format/bitrate/sampleRate)
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

    const composerDisplay = (this.track.composer || '').trim() || this.track.artist || '';
    if (composerDisplay) {
      ctx.font = `400 ${Math.round(14 * s)}px ${this.fontStack}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      drawTruncatedText(ctx, composerDisplay, cx, titleY + 25 * s, W * 0.36);
    }
    ctx.restore();

    // 3. Lower Progress Bar + Timecodes + Transport Icons (matching PlayerPage fullscreen)
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
      const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      fillGrad.addColorStop(0, this.palette.primary);
      fillGrad.addColorStop(1, this.palette.secondary);
      ctx.fillStyle = fillGrad;
      ctx.fill();
    }

    const thumbX = barX + barW * pct;
    ctx.save();
    ctx.shadowColor = this.palette.primary;
    ctx.shadowBlur = 12 * s;
    ctx.beginPath();
    ctx.arc(thumbX, barY + barH / 2, 8 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.font = `400 ${Math.round(11 * s)}px ${MONO_STACK}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(state.audioTime), barX, barY + 14 * s);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(state.audioDuration), barX + barW, barY + 14 * s);
    ctx.restore();

    // Subtle transport controls beneath scrubber matching Image 2
    const ctrlY = barY + 54 * s;
    const iconSpread = 86 * s;
    this.drawTransportPrevIcon(ctx, cx - iconSpread, ctrlY, 10 * s);
    this.drawTransportPauseIcon(ctx, cx, ctrlY, 10.5 * s);
    this.drawTransportNextIcon(ctx, cx + iconSpread, ctrlY, 10 * s);
  }

  private drawTransportPrevIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.fillRect(x - r, y - r * 0.85, r * 0.25, r * 1.7);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y);
    ctx.lineTo(x + r * 0.9, y - r * 0.85);
    ctx.lineTo(x + r * 0.9, y + r * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawTransportPauseIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    const barW = r * 0.34;
    const gap = r * 0.34;
    drawRoundedRectPath(ctx, x - gap - barW, y - r * 0.9, barW, r * 1.8, 1.5);
    ctx.fill();
    drawRoundedRectPath(ctx, x + gap, y - r * 0.9, barW, r * 1.8, 1.5);
    ctx.fill();
    ctx.restore();
  }

  private drawTransportNextIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.fillRect(x + r * 0.75, y - r * 0.85, r * 0.25, r * 1.7);
    ctx.beginPath();
    ctx.moveTo(x + r * 0.55, y);
    ctx.lineTo(x - r * 0.9, y - r * 0.85);
    ctx.lineTo(x - r * 0.9, y + r * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawRightThreeLineLyrics(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    s: number,
    state: StageDrawContextState
  ) {
    // Right half unboxed 3-line lyrics matching Image 2 & FullscreenThreeLineLyrics.tsx
    const xStart = W * 0.53;
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

      // Smooth flowing entrance curve identical to FullscreenThreeLineLyrics CSS animation
      let animT = 1;
      if (state.stepDirection !== 'none' && state.lineTransitionElapsedSec < animDur + slot.staggerSec) {
        const localElapsed = Math.max(0, state.lineTransitionElapsedSec - slot.staggerSec);
        animT = cubicBezierEaseOut(localElapsed / animDur);
      }

      const dirSign = state.stepDirection === 'backward' ? -1 : 1;
      const enterOffsetY =
        state.stepDirection === 'none' ? 0 : dirSign * 24 * s * (1 - animT);
      const enterScale = state.stepDirection === 'none' ? 1 : 0.968 + 0.032 * animT;
      const enterAlpha = state.stepDirection === 'none' ? 1 : 0.12 + 0.88 * animT;

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

      for (const row of mainRows) {
        ctx.save();
        if (isCurrent) {
          ctx.shadowColor = `rgba(${r1}, ${g1}, ${b1}, 0.72)`;
          ctx.shadowBlur = 30 * s;
          ctx.fillStyle = '#ffffff';
          ctx.fillText(row, 0, cursorY);
          // Second crisp shadow pass matching CSS double text-shadow
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

  const targetBitrate =
    width >= 1920
      ? fps >= 100
        ? 14_000_000
        : 10_000_000
      : fps >= 100
      ? 9_000_000
      : 6_500_000;

  // Higher H.264 levels (5.2, 5.0, 4.2) are required for 60–120fps encoding in WebCodecs
  const avcCandidates = [
    'avc1.640034', // High Profile Level 5.2 (supports up to 1080p@120fps+)
    'avc1.640032', // High Profile Level 5.0
    'avc1.4d0032', // Main Profile Level 5.0
    'avc1.64002a', // High Profile Level 4.2 (1080p@60fps)
    'avc1.4d002a', // Main Profile Level 4.2
    'avc1.4d001f', // Main Profile Level 3.1
  ];

  for (const avcCodec of avcCandidates) {
    try {
      const vSup = await VideoEncoder.isConfigSupported({
        codec: avcCodec,
        width,
        height,
        bitrate: targetBitrate,
        framerate: fps,
      });
      const aSup = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
        sampleRate,
        bitrate: 192_000,
      });
      if (vSup.supported && aSup.supported) {
        return {
          container: 'mp4' as const,
          videoCodec: avcCodec,
          audioCodec: 'mp4a.40.2',
          bitrate: targetBitrate,
        };
      }
    } catch {
      // try next
    }
  }

  // Fallback to WebM (VP9 Level 5.0 / VP8 + Opus)
  for (const vpCodec of ['vp09.00.50.08', 'vp09.00.41.08', 'vp8']) {
    try {
      const vSup = await VideoEncoder.isConfigSupported({
        codec: vpCodec,
        width,
        height,
        bitrate: targetBitrate,
        framerate: fps,
      });
      const aSup = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        numberOfChannels: 2,
        sampleRate: 48000,
        bitrate: 192_000,
      });
      if (vSup.supported && aSup.supported) {
        return {
          container: 'webm' as const,
          videoCodec: vpCodec,
          audioCodec: 'opus',
          bitrate: targetBitrate,
        };
      }
    } catch {
      // try next
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
  const length = Math.ceil(source.duration * targetSampleRate);
  const offline = new OfflineAudioContext(2, length, targetSampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = source;
  srcNode.connect(offline.destination);
  srcNode.start(0);
  return offline.startRendering();
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
 * plus optional MV theater integration) at custom FPS (60-120) and custom time range.
 */
export function startStageVideoRender(
  options: StageRenderOptions
): StageRenderController {
  let cancelled = false;
  let finishEarlyRequested = false;
  let monitorGainRef: GainNode | null = null;
  let isMonitorMuted = Boolean(options.monitorMuted ?? true);

  const width = options.quality === '1080p' ? 1920 : 1280;
  const height = options.quality === '1080p' ? 1080 : 720;
  const fps = Math.max(60, Math.min(120, Math.round(options.fps || 60)));
  const requestedStartSec = Math.max(0, options.startOffsetSec || 0);

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

    const painter = new StageCanvasPainter({
      width,
      height,
      track: options.track,
      coverImg,
      showBilingual: options.showBilingual,
      fontPreset: options.fontPreset,
      hasMvVideo: hasUsableMv,
    });
    const parsedLines = painter.getLines();
    const hasSynced = painter.getHasSynced();

    // Path A: Ultra-fast offline WebCodecs render (exact 60..120fps deterministic timestamps!)
    if (!hasUsableMv) {
      const decodeCtx = new AudioContext();
      let decodedBuffer: AudioBuffer;
      try {
        const arrBuf = await options.audioBlob.arrayBuffer();
        decodedBuffer = await decodeCtx.decodeAudioData(arrBuf);
      } finally {
        await decodeCtx.close().catch(() => {});
      }

      const fullDuration = decodedBuffer.duration || options.track.duration || 10;
      const safeStart = Math.min(Math.max(0, fullDuration - 1), requestedStartSec);
      const remainingDur = Math.max(1, fullDuration - safeStart);
      const targetDuration =
        options.clipDurationSec && options.clipDurationSec > 1
          ? Math.min(remainingDur, options.clipDurationSec)
          : remainingDur;

      const codecSupport = await probeWebCodecsSupport(width, height, 48000, fps);

      if (codecSupport) {
        const resampled = await resampleStereoAudioBuffer(decodedBuffer, 48000);
        const analyzer = new OfflineAudioAnalyzer(resampled);
        const totalFrames = Math.max(1, Math.ceil(targetDuration * fps));

        let mp4Muxer: Mp4Muxer<Mp4ArrayBufferTarget> | null = null;
        let webmMuxer: WebmMuxer<WebmArrayBufferTarget> | null = null;
        let encodeError: Error | null = null;

        if (codecSupport.container === 'mp4') {
          mp4Muxer = new Mp4Muxer({
            target: new Mp4ArrayBufferTarget(),
            video: { codec: 'avc', width, height },
            audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 },
            fastStart: 'in-memory',
            firstTimestampBehavior: 'offset',
          });
        } else {
          webmMuxer = new WebmMuxer({
            target: new WebmArrayBufferTarget(),
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

        const videoEncoder = new VideoEncoder({
          output: (chunk, meta) => {
            mp4Muxer?.addVideoChunk(chunk, meta);
            webmMuxer?.addVideoChunk(chunk, meta);
          },
          error: (e) => {
            encodeError = e instanceof Error ? e : new Error(String(e));
          },
        });

        const audioEncoder = new AudioEncoder({
          output: (chunk, meta) => {
            mp4Muxer?.addAudioChunk(chunk, meta);
            webmMuxer?.addAudioChunk(chunk, meta);
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
        });

        audioEncoder.configure({
          codec: codecSupport.audioCodec,
          numberOfChannels: 2,
          sampleRate: 48000,
          bitrate: 192_000,
        });

        // Slice & encode stereo audio PCM chunks cleanly from [safeStart .. safeStart + targetDuration]
        const leftCh = resampled.getChannelData(0);
        const rightCh = resampled.numberOfChannels > 1 ? resampled.getChannelData(1) : leftCh;
        const startSample = Math.min(leftCh.length, Math.floor(safeStart * 48000));
        const maxSample = Math.min(
          leftCh.length,
          startSample + Math.ceil(targetDuration * 48000)
        );
        const audioChunkSize = 2048;

        for (let offset = startSample; offset < maxSample; offset += audioChunkSize) {
          if (cancelled || encodeError) break;
          const count = Math.min(audioChunkSize, maxSample - offset);
          const planar = new Float32Array(count * 2);
          planar.set(leftCh.subarray(offset, offset + count), 0);
          planar.set(rightCh.subarray(offset, offset + count), count);

          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: count,
            numberOfChannels: 2,
            timestamp: Math.round(((offset - startSample) / 48000) * 1_000_000),
            data: planar,
          });
          audioEncoder.encode(audioData);
          audioData.close();

          if (audioEncoder.encodeQueueSize > 24) {
            await new Promise((r) => setTimeout(r, 4));
          }
        }

        const initIdx = hasSynced
          ? findActiveLyricIndex(parsedLines, safeStart, options.track.lyricsOffsetMs || 0)
          : parsedLines.length > 0
          ? 0
          : -1;

        const drawState: StageDrawContextState = {
          timeSec: safeStart,
          audioTime: safeStart,
          audioDuration: fullDuration,
          mvPhase: 'normal',
          mvPhaseTime: 0,
          uiOpacity: 1,
          isTheaterClarity: false,
          frame: analyzer.sampleAt(safeStart),
          smoothBass: 0,
          smoothMid: 0,
          smoothVol: 0,
          activeIdx: initIdx,
          prevIdx: initIdx,
          lineTransitionElapsedSec: 1,
          stepDirection: 'none',
        };

        const renderStartPerf = performance.now();
        let actualRenderedSec = targetDuration;
        const dt = 1 / fps;

        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          if (cancelled) {
            try {
              videoEncoder.close();
              audioEncoder.close();
            } catch {
              // ignore
            }
            throw new Error('已取消导出渲染');
          }
          if (encodeError) throw encodeError;

          const relTime = frameIdx / fps;
          const absAudioTime = safeStart + relTime;

          if (finishEarlyRequested && frameIdx > fps * 2) {
            actualRenderedSec = relTime;
            break;
          }

          drawState.timeSec = absAudioTime;
          drawState.audioTime = absAudioTime;
          drawState.frame = analyzer.sampleAt(absAudioTime);
          advanceFlowState(
            drawState,
            parsedLines,
            hasSynced,
            options.track.lyricsOffsetMs || 0,
            dt
          );

          // Mirror to on-screen preview canvas every frame
          painter.drawFrame(drawState, null, options.previewCanvas);

          const vf = new VideoFrame(painter.getCanvas(), {
            timestamp: Math.round(relTime * 1_000_000),
            duration: Math.round(1_000_000 / fps),
          });
          videoEncoder.encode(vf, { keyFrame: frameIdx % (fps * 2) === 0 });
          vf.close();

          if (videoEncoder.encodeQueueSize > 8 || frameIdx % 8 === 0) {
            const elapsedWall = (performance.now() - renderStartPerf) / 1000;
            options.onProgress?.({
              percent: Math.min(98, ((frameIdx + 1) / totalFrames) * 96),
              elapsedSec: relTime,
              totalSec: targetDuration,
              phaseLabel: `正在以 ${fps} fps 极速离线合成网页全屏同款画面...`,
              engineLabel:
                codecSupport.container === 'mp4'
                  ? `WebCodecs MP4 · ${fps} fps`
                  : `WebCodecs WebM · ${fps} fps`,
              fps: elapsedWall > 0.1 ? Math.round((frameIdx + 1) / elapsedWall) : undefined,
            });
            await new Promise((r) => setTimeout(r, 0));
          }
        }

        options.onProgress?.({
          percent: 98,
          elapsedSec: actualRenderedSec,
          totalSec: targetDuration,
          phaseLabel: '正在封装高帧率音视频文件...',
          engineLabel: `${codecSupport.container.toUpperCase()} · ${fps} fps`,
        });

        await Promise.all([videoEncoder.flush(), audioEncoder.flush()]);
        videoEncoder.close();
        audioEncoder.close();
        if (encodeError) throw encodeError;

        if (mp4Muxer) {
          mp4Muxer.finalize();
          const buf = mp4Muxer.target.buffer;
          return {
            videoBlob: new Blob([buf], { type: 'video/mp4' }),
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
        const buf = webmMuxer!.target.buffer;
        return {
          videoBlob: new Blob([buf], { type: 'video/webm' }),
          mimeType: 'video/webm',
          extension: 'webm',
          durationSec: actualRenderedSec,
          width,
          height,
          fps,
          engineUsed: 'webcodecs-webm',
        };
      }
    }

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
      videoEl.playsInline = true;
      videoEl.preload = 'auto';
      if (options.mvRecord?.sourceType === 'url') {
        videoEl.crossOrigin = 'anonymous';
      }
      videoEl.src = mvUrl;
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

    const audioSource = isoCtx.createMediaElementSource(audioEl);
    audioSource.connect(songGain);
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

    const cleanup = () => {
      monitorGainRef = null;
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
        new Promise<void>((resolve) => {
          if (audioEl.readyState >= 1) return resolve();
          const onReady = () => resolve();
          audioEl.addEventListener('loadedmetadata', onReady, { once: true });
          audioEl.addEventListener('error', onReady, { once: true });
          setTimeout(resolve, 4000);
        }),
        videoEl
          ? new Promise<void>((resolve) => {
              if (videoEl!.readyState >= 1) return resolve();
              const onReady = () => resolve();
              videoEl!.addEventListener('loadedmetadata', onReady, { once: true });
              videoEl!.addEventListener('error', onReady, { once: true });
              setTimeout(resolve, 5000);
            })
          : Promise.resolve(),
      ]);

      await isoCtx.resume().catch(() => {});

      const songDuration =
        Number.isFinite(audioEl.duration) && audioEl.duration > 0
          ? audioEl.duration
          : options.track.duration || 10;
      const timeline = options.mvRecord?.timeline || createDefaultMvTimeline();
      const sortedBreaks = normalizeMidBreaks(timeline.midBreaks || []);
      const mvDuration =
        (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0
          ? videoEl.duration
          : options.mvRecord?.durationSec) || 0;

      const safeStart = Math.min(Math.max(0, songDuration - 1), requestedStartSec);
      const hasIntro = Boolean(
        videoEl && safeStart <= 0.1 && timeline.introEnabled && timeline.introEndSec > 0.35
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
      const breaksLen = videoEl
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
        videoEl && timeline.outroEnabled && outroEnd > endSyncMv + 0.4
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
        videoBitsPerSecond:
          width >= 1920 ? (fps >= 90 ? 12_000_000 : 8_500_000) : fps >= 90 ? 8_000_000 : 5_500_000,
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

      if (hasIntro && videoEl) {
        songGain.gain.value = 0;
        mvGain.gain.value = 1;
        videoEl.currentTime = 0;
        await videoEl.play().catch(() => {});
      } else {
        songGain.gain.value = 1;
        mvGain.gain.value = 0;
        audioEl.currentTime = safeStart;
        if (videoEl) {
          videoEl.currentTime =
            computeSyncedMvTime(safeStart, timeline, completedBreaks) +
            (timeline.syncOffsetSec || 0);
          await videoEl.play().catch(() => {});
        }
        await audioEl.play().catch(() => {});
      }

      recorder.start(250);

      let wallElapsed = 0;
      let lastTick = performance.now();
      let songEnded = false;
      audioEl.onended = () => {
        songEnded = true;
      };

      await new Promise<void>((resolve, reject) => {
        const frameIntervalMs = Math.max(8, Math.round(1000 / fps));
        let finished = false;

        const finishRecording = (wasCancelled: boolean) => {
          if (finished) return;
          finished = true;
          canvasStream.getTracks().forEach((t) => t.stop());
          if (wasCancelled) {
            try {
              if (recorder.state !== 'inactive') recorder.stop();
            } catch {
              // ignore
            }
            reject(new Error('已取消导出渲染'));
          } else {
            resolve();
          }
        };

        const tick = () => {
          if (cancelled) {
            finishRecording(true);
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

          const curAudioTime = audioEl.currentTime || 0;

          if (phase === 'intro' && videoEl) {
            mvPhaseTime += dt;
            const probeTime = Math.max(mvPhaseTime, videoEl.currentTime || 0);
            mvPhaseTime = probeTime;
            if (probeTime >= timeline.introEndSec - 0.04 || videoEl.ended) {
              phase = 'normal';
              audioEl.currentTime = 0;
              audioEl.play().catch(() => {});
            }
          } else if (phase === 'mid-break' && activeMidBreak && videoEl) {
            mvPhaseTime += dt;
            const probeTime = Math.max(mvPhaseTime, videoEl.currentTime || 0);
            mvPhaseTime = probeTime;
            if (probeTime >= activeMidBreak.mvEndSec - 0.04 || videoEl.ended) {
              completedBreaks.add(activeMidBreak.id);
              const resumeAt = activeMidBreak.audioTriggerSec + 0.03;
              activeMidBreak = null;
              phase = 'normal';
              audioEl.currentTime = resumeAt;
              audioEl.play().catch(() => {});
            }
          } else if (phase === 'outro' && videoEl) {
            mvPhaseTime += dt;
            const probeTime = Math.max(mvPhaseTime, videoEl.currentTime || 0);
            mvPhaseTime = probeTime;
            if (
              videoEl.ended ||
              (outroEnd > 0 && probeTime >= outroEnd - 0.04)
            ) {
              finishRecording(false);
              return;
            }
          } else {
            if (videoEl) {
              const triggered = findTriggeredMidBreak(
                curAudioTime,
                timeline,
                completedBreaks
              );
              if (triggered) {
                activeMidBreak = triggered;
                phase = 'mid-break';
                mvPhaseTime = triggered.mvStartSec;
                audioEl.pause();
                videoEl.currentTime = triggered.mvStartSec;
                videoEl.play().catch(() => {});
              } else if (songEnded || curAudioTime >= songDuration - 0.05) {
                if (outroLen > 0.3) {
                  phase = 'outro';
                  outroStartMvSec = endSyncMv;
                  mvPhaseTime = endSyncMv;
                  audioEl.pause();
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
                if (Math.abs((videoEl.currentTime || 0) - expectedMv) > 0.28) {
                  try {
                    videoEl.currentTime = expectedMv;
                  } catch {
                    // ignore
                  }
                }
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
                timeline,
                activeMidBreak,
                audioTime: curAudioTime,
                audioDuration: songDuration,
                mvDurationSec: mvDuration,
                completedBreakIds: completedBreaks,
                fadeInSec: options.mvUiFadeInSec ?? timeline.fadeTransitionSec,
                fadeOutSec: options.mvUiFadeOutSec ?? timeline.fadeTransitionSec,
                outroStartMvSec,
                allowIntroTailCrossfade: true,
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
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
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
