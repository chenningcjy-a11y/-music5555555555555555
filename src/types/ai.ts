import {
  AnimationIntensity,
  AudioDspSettings,
  MvMidBreakRange,
  MvTheaterPhase,
} from './music';

export type AiSubTab = 'assistant' | 'toolbox' | 'providers' | 'history';

export type AiProviderKind =
  | 'deepseek'
  | 'openai'
  | 'gemini'
  | 'openai-compatible'
  | 'custom';

export type ProviderConnectionStatus = 'untested' | 'connected' | 'error';

export interface ModelCapabilities {
  textReasoning: boolean;
  lyricsProcessing: boolean;
  dspPlanning: boolean;
  audioInputAnalysis: boolean;
  stemSeparation: boolean;
  note?: string;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export interface AiProviderConfig {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  availableModels: string[];
  maskedKey: string;
  hasKey: boolean;
  isBuiltin?: boolean;
  enabled: boolean;
  isDefault: boolean;
  timeoutMs: number;
  maxRequestsPerDay: number;
  requestsToday: number;
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
  lastLatencyMs?: number;
  customHeadersJson?: string;
  createdAt: number;
  updatedAt: number;
}

export type StemServiceKind = 'builtin-mdx' | 'remote-demucs-http' | 'none';

export interface StemServiceConfig {
  id: string;
  name: string;
  kind: StemServiceKind;
  baseUrl: string;
  endpointPath: string;
  maskedKey: string;
  hasKey: boolean;
  enabled: boolean;
  isActive: boolean;
  timeoutMs: number;
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
}

export type AiTaskCategory =
  | 'stem_separation'
  | 'mv_export'
  | 'lyrics_assistant'
  | 'audio_analysis'
  | 'dsp_tuning'
  | 'audio_processing'
  | 'intent_routing'
  | 'custom';

export type AiTaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_confirmation'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'needs_resubmit'
  | 'error';

export type MvExportDeliveryMode = 'zip-folder' | 'local-dir' | 'video-only';

export type MvExportQuality = '720p' | '1080p' | '1440p' | '2160p';

export interface MvExportTaskConfig {
  trackId: string;
  mvId?: string | null;
  deliveryMode: MvExportDeliveryMode;
  quality: MvExportQuality;
  fps: number;
  durationMode: 'full' | 'custom';
  startOffsetSec: number;
  clipDurationSec: number | null;
  includeMvInVideo: boolean;
  includeMvIntro: boolean;
  includeMvMidBreaks: boolean;
  includeMvOutro: boolean;
  showBilingual: boolean;
  showWordSync: boolean;
  fontPreset?: string;
  animationIntensity: AnimationIntensity;
  mvUiFadeInSec?: number;
  mvUiFadeOutSec?: number;
}

export interface MvExportResultMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  deliveryMode: MvExportDeliveryMode;
  manifestPaths?: Array<{ path: string; sizeText: string }>;
  savedToLocalFolderName?: string;
  createdAt: number;
}

export interface MvExportCheckpointMeta {
  taskId: string;
  engineKind: 'webcodecs-mp4' | 'webcodecs-webm';
  codecSupport: {
    container: 'mp4' | 'webm';
    videoCodec: string;
    audioCodec: string;
    bitrate: number;
    audioBitrate: number;
    hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    latencyMode?: 'quality' | 'realtime';
    bitrateMode?: 'constant' | 'variable' | 'quantizer';
  };
  width: number;
  height: number;
  fps: number;
  songDuration: number;
  mvDuration: number;
  targetDuration: number;
  totalFrames: number;
  safeStart: number;
  hasIntro: boolean;
  includeMvIntro: boolean;
  includeMvMidBreaks: boolean;
  includeMvOutro: boolean;
  hasMvVideo: boolean;
  nextFrameIdx: number;
  phase: MvTheaterPhase;
  mvPhaseTime: number;
  curAudioTime: number;
  completedBreakIds: string[];
  activeMidBreak: MvMidBreakRange | null;
  outroStartMvSec: number;
  songSampleCursor: number;
  mvSampleCursor: number;
  lastEmittedVideoDtsUs: number;
  reorderShiftUs: number;
  totalAudioSamplesEncoded: number;
  emittedAudioEndUs: number;
  lastEmittedAudioTsUs: number;
  rewindAudioL: ArrayBuffer;
  rewindAudioR: ArrayBuffer;
  rewindAudioCount: number;
  drawState: {
    smoothBass: number;
    smoothMid: number;
    smoothVol: number;
    activeIdx: number;
    prevIdx: number;
    lineTransitionElapsedSec: number;
    stepDirection: 'forward' | 'backward' | 'none';
  };
  videoDecoderConfig?: {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    displayAspectWidth?: number;
    displayAspectHeight?: number;
    description?: ArrayBuffer;
  };
  audioDecoderConfig?: {
    codec: string;
    numberOfChannels: number;
    sampleRate: number;
    description?: ArrayBuffer;
  };
  chunkBatchCount: number;
  updatedAt: number;
}

export interface MvExportChunkBatch {
  id: string;
  taskId: string;
  batchIndex: number;
  videoChunks: Array<{
    data: ArrayBuffer;
    type: 'key' | 'delta';
    timestamp: number;
    duration: number;
    cts: number;
  }>;
  audioChunks: Array<{
    data: ArrayBuffer;
    type: 'key' | 'delta';
    timestamp: number;
    duration: number;
  }>;
}

export interface MvExportResultRecord {
  taskId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  createdAt: number;
}

export interface AiTaskSourceFileInfo {
  format: string;
  fileSizeBytes: number;
  durationSec: number;
  sampleRate?: number;
  bitrate?: number;
  fileIdentifier?: string;
}

export interface AiTaskStageLog {
  timestamp: number;
  stage: string;
  detail?: string;
}

export interface AiTaskRecord {
  id: string;
  taskName: string;
  category: AiTaskCategory;
  providerName: string;
  modelName: string;

  // Immutable source track snapshot (never bound to player's currentTrack)
  sourceTrackId?: string;
  sourceTrackTitle?: string;
  sourceTrackArtist?: string;
  sourceTrackAlbum?: string;
  sourceTrackCoverUrl?: string;
  sourceFileInfo?: AiTaskSourceFileInfo;
  trackTitle?: string; // display alias kept synchronized with sourceTrackTitle

  // Execution metadata
  engineMode?: 'auto' | 'local' | 'server' | 'remote-demucs-http';
  engineLabel?: string;
  backendJobId?: string;
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
  status: AiTaskStatus;
  progress: number;
  stageLabel?: string;
  stepLabel?: string;
  currentChunk?: number;
  totalChunks?: number;
  estimatedRemainingSec?: number | null;
  stageLogs?: AiTaskStageLog[];

  // Result & error tracking
  resultSummary?: string;
  resultData?: unknown;
  stemMeta?: {
    trackId: string;
    modelId: string;
    modelName: string;
    engineUsed: 'local-webgpu' | 'local-wasm' | 'server-onnx';
    duration: number;
    createdAt: number;
    vocalSizeBytes: number;
    instrumentalSizeBytes: number;
  };
  mvExportConfig?: MvExportTaskConfig;
  mvExportResult?: MvExportResultMeta;
  hasResumableCheckpoint?: boolean;
  errorMessage?: string;
  replayPayload?: {
    prompt?: string;
    category: AiTaskCategory;
    subAction?: string;
    targetTrackId?: string;
    engineMode?: 'auto' | 'local' | 'server';
    extra?: Record<string, unknown>;
  };
}

export interface DspPlanResponse {
  providerName: string;
  modelUsed: string;
  explanation: string;
  patch: Partial<AudioDspSettings>;
  suggestStemSeparation: boolean;
  warnings: string[];
}

export interface AudioAnalysisResult {
  genre: string;
  mood: string;
  instruments: string[];
  rhythmAndTempo: string;
  curatedSummary: string;
  tags: string[];
  analyzedFromAudio: boolean;
}
