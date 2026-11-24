import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileAudio,
  Film,
  FolderDown,
  Globe,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Play,
  Sparkles,
  X,
} from 'lucide-react';
import { useMusic } from '../../context/MusicContext';
import { useTaskCenter } from '../../context/TaskCenterContext';
import { getAudioBlob, getTrackMvs } from '../../services/storage';
import { MvExportDeliveryMode, MvExportQuality, MvExportTaskConfig } from '../../types/ai';
import { TrackMetadata, TrackMvRecord } from '../../types/music';
import { formatFileSize, formatTime } from '../../utils/constants';
import {
  pickDirectoryHandle,
  sanitizeFileName,
  supportsDirectoryPicker,
} from '../../utils/zipStoreBuilder';

interface TrackPackageExportModalProps {
  open: boolean;
  track: TrackMetadata | null;
  onClose: () => void;
}

export const TrackPackageExportModal: React.FC<TrackPackageExportModalProps> = ({
  open,
  track,
  onClose,
}) => {
  const {
    activePalette,
    personalization,
    setActivePage,
    showToast,
  } = useMusic();
  const {
    enqueueMvExportTask,
    getLatestMvExportTaskForTrack,
    resumeTask,
    downloadMvExportResult,
    setSelectedTaskId,
  } = useTaskCenter();

  const [deliveryMode, setDeliveryMode] = useState<MvExportDeliveryMode>('zip-folder');
  const [quality, setQuality] = useState<MvExportQuality>('720p');
  const [targetFps, setTargetFps] = useState<number>(60);
  const [durationMode, setDurationMode] = useState<'full' | 'custom'>('full');
  const [customStartSec, setCustomStartSec] = useState<number>(0);
  const [customDurationSec, setCustomDurationSec] = useState<number>(30);

  const [includeMvInVideo, setIncludeMvInVideo] = useState(true);
  const [includeMvIntro, setIncludeMvIntro] = useState(true);
  const [includeMvMidBreaks, setIncludeMvMidBreaks] = useState(true);
  const [includeMvOutro, setIncludeMvOutro] = useState(true);

  const [mvRecord, setMvRecord] = useState<TrackMvRecord | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isFullscreenModal, setIsFullscreenModal] = useState(false);

  const dirPickerSupported = useMemo(() => supportsDirectoryPicker(), []);

  useEffect(() => {
    if (!open || !track) return;
    let cancelled = false;
    setErrorMsg(null);
    setSubmitting(false);
    setLoadingAssets(true);

    Promise.all([getAudioBlob(track.id), getTrackMvs(track.id)])
      .then(([aBlob, mvs]) => {
        if (cancelled) return;
        setAudioBlob(aBlob || null);
        const active = mvs.find((m) => m.isActive) || mvs[0] || null;
        setMvRecord(active);
        const hasMv = Boolean(active);
        setIncludeMvInVideo(hasMv);
        setIncludeMvIntro(
          Boolean(active?.timeline?.introEnabled && active.timeline.introEndSec > 0.35)
        );
        setIncludeMvMidBreaks(Boolean((active?.timeline?.midBreaks?.length || 0) > 0));
        setIncludeMvOutro(Boolean(active?.timeline?.outroEnabled));
      })
      .finally(() => {
        if (!cancelled) setLoadingAssets(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, track?.id]);

  if (!open || !track) return null;

  const folderName = sanitizeFileName(`${track.title} - ${track.artist}`, 'LuminaTrack');
  const safeTitle = sanitizeFileName(track.title, 'track');

  const totalTrackDuration = Math.max(3, Math.round(track.duration || 30));
  const clampedFps = Math.max(30, Math.min(120, Math.round(targetFps || 60)));
  const clampedStartSec = Math.max(
    0,
    Math.min(Math.max(0, totalTrackDuration - 3), Math.round(customStartSec || 0))
  );
  const maxCustomClipSec = Math.max(3, totalTrackDuration - clampedStartSec);
  const clampedDurationSec = Math.max(
    3,
    Math.min(maxCustomClipSec, Math.round(customDurationSec || 30))
  );

  const introConfigured = Boolean(
    mvRecord?.timeline?.introEnabled && mvRecord.timeline.introEndSec > 0.35
  );
  const introDurationSec = introConfigured ? mvRecord!.timeline!.introEndSec : 0;
  const midBreaksList = mvRecord?.timeline?.midBreaks || [];
  const midConfigured = midBreaksList.length > 0;
  const totalMidBreakSec = midBreaksList.reduce(
    (sum, b) => sum + Math.max(0, b.mvEndSec - b.mvStartSec),
    0
  );
  const outroConfigured = Boolean(mvRecord?.timeline?.outroEnabled);

  const existingMvTask = getLatestMvExportTaskForTrack(track.id);

  const handleOpenTaskCenter = (taskId?: string) => {
    setSelectedTaskId(taskId || null);
    setActivePage('tasks');
    onClose();
  };

  const handleResumeExisting = async () => {
    if (!existingMvTask) return;
    await resumeTask(existingMvTask.id);
    onClose();
  };

  const handleSubmitBackgroundExport = async () => {
    if (!track || !audioBlob || submitting) {
      if (!audioBlob) {
        setErrorMsg('未找到当前曲目的本地音频文件，请重新导入歌曲后再试。');
      }
      return;
    }

    setErrorMsg(null);
    setSubmitting(true);

    try {
      let directoryHandle: FileSystemDirectoryHandle | null = null;
      if (deliveryMode === 'local-dir') {
        try {
          directoryHandle = await pickDirectoryHandle();
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            setSubmitting(false);
            return;
          }
          throw err;
        }
      }

      const config: MvExportTaskConfig = {
        trackId: track.id,
        mvId: includeMvInVideo && mvRecord ? mvRecord.id : null,
        deliveryMode,
        quality,
        fps: clampedFps,
        durationMode,
        startOffsetSec: durationMode === 'custom' ? clampedStartSec : 0,
        clipDurationSec: durationMode === 'custom' ? clampedDurationSec : null,
        includeMvInVideo: Boolean(includeMvInVideo && mvRecord),
        includeMvIntro: Boolean(includeMvInVideo && mvRecord && introConfigured && includeMvIntro),
        includeMvMidBreaks: Boolean(
          includeMvInVideo && mvRecord && midConfigured && includeMvMidBreaks
        ),
        includeMvOutro: Boolean(includeMvInVideo && mvRecord && outroConfigured && includeMvOutro),
        showBilingual: personalization.showBilingualLyrics,
        showWordSync: personalization.showWordSync,
        fontPreset: personalization.fontPreset,
        animationIntensity: personalization.animationIntensity,
        mvUiFadeInSec: personalization.mvUiFadeInSec,
        mvUiFadeOutSec: personalization.mvUiFadeOutSec,
      };

      await enqueueMvExportTask({
        track,
        mvRecord: includeMvInVideo ? mvRecord : null,
        config,
        directoryHandle,
      });

      showToast(
        `已加入后台导出队列：「${track.title}」，可自由切歌或切页，进度与断点请在「AI 任务中心」查看`
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '创建后台导出任务失败');
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md overflow-y-auto ${
        isFullscreenModal ? 'p-0' : 'p-2 sm:p-4'
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <div
        className={`bg-[#16060f]/97 shadow-[0_32px_90px_rgba(0,0,0,0.75)] overflow-hidden flex flex-col transition-all ${
          isFullscreenModal
            ? 'w-screen h-[100dvh] rounded-none border-0'
            : 'w-[98vw] max-w-6xl rounded-3xl border border-white/15 max-h-[93dvh]'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-white/15 flex items-center justify-center"
              style={{
                background: `linear-gradient(135deg, ${activePalette.primary}44, ${activePalette.secondary}44)`,
              }}
            >
              {track.coverDataUrl ? (
                <img
                  src={track.coverDataUrl}
                  alt={track.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Sparkles className="w-5 h-5 text-white" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-semibold text-white truncate">
                后台合成网页同款效果视频 & 歌曲文件夹导出
              </h2>
              <p className="text-xs text-white/60 truncate">
                {track.title} · {track.artist}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsFullscreenModal((v) => !v)}
              title={isFullscreenModal ? '还原窗口' : '全屏展示'}
              className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1.5 text-xs"
            >
              {isFullscreenModal ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">
                {isFullscreenModal ? '退出全屏' : '全屏'}
              </span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭导出窗口"
              className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto lumina-scroll p-5 sm:p-6 space-y-4">
          {/* Compact Background Task & Alignment Summary Strip */}
          <div className="rounded-2xl bg-gradient-to-r from-white/[0.06] via-white/[0.04] to-transparent border border-white/12 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center border border-white/15 shrink-0"
                style={{
                  background: `linear-gradient(135deg, ${activePalette.primary}38, ${activePalette.secondary}38)`,
                }}
              >
                <ListChecks className="w-5 h-5 text-white" />
              </div>
              <div className="space-y-1 min-w-0">
                <p className="text-xs sm:text-sm font-semibold text-white">
                  提交后立即转入后台队列，不遮挡主界面、不影响正常听歌与切页
                </p>
                <p className="text-xs text-white/60 leading-relaxed">
                  采用 WebCodecs 逐帧无丢帧与音频微秒对齐合成，并每 6 秒自动持久化编码断点；即使页面意外刷新或关闭，再次打开可在「AI 任务中心」直接从断点续传。
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleOpenTaskCenter()}
              className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/18 border border-white/15 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer shrink-0 self-start sm:self-center whitespace-nowrap"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>打开任务中心</span>
            </button>
          </div>

          {/* Existing Background Task Banner for this Track */}
          {existingMvTask && (
            <div
              className={`rounded-2xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
                existingMvTask.status === 'completed'
                  ? 'bg-emerald-500/10 border-emerald-400/25 text-emerald-100'
                  : existingMvTask.status === 'interrupted' || existingMvTask.status === 'paused'
                  ? 'bg-amber-500/12 border-amber-400/30 text-amber-100'
                  : 'bg-sky-500/12 border-sky-400/30 text-sky-100'
              }`}
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2 font-semibold">
                  {existingMvTask.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" />
                  ) : (
                    <Film className="w-4 h-4 shrink-0" />
                  )}
                  <span className="truncate">
                    {existingMvTask.status === 'running' || existingMvTask.status === 'queued'
                      ? `当前曲目已有后台导出任务运行中（${existingMvTask.progress}%）`
                      : existingMvTask.status === 'paused' ||
                        existingMvTask.status === 'interrupted'
                      ? `检测到上次未完成的导出任务（${existingMvTask.progress}%${
                          existingMvTask.hasResumableCheckpoint ? ' · 已保留编码断点' : ''
                        }）`
                      : existingMvTask.status === 'completed'
                      ? `最近一次导出已完成（${existingMvTask.resultSummary || '成品已缓存'}）`
                      : `最近一次导出状态：${existingMvTask.stageLabel || existingMvTask.status}`}
                  </span>
                </div>
                <p className="text-white/70 truncate">{existingMvTask.stageLabel}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {(existingMvTask.status === 'paused' ||
                  existingMvTask.status === 'interrupted') && (
                  <button
                    type="button"
                    onClick={() => void handleResumeExisting()}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                    style={{
                      background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
                    }}
                  >
                    <Play className="w-3.5 h-3.5" fill="currentColor" />
                    <span>继续上次导出</span>
                  </button>
                )}

                {existingMvTask.status === 'completed' && (
                  <button
                    type="button"
                    onClick={() => void downloadMvExportResult(existingMvTask.id)}
                    className="px-3 py-1.5 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-300/35 text-xs font-medium text-emerald-50 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>直接下载成品</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleOpenTaskCenter(existingMvTask.id)}
                  className="px-3 py-1.5 rounded-xl bg-white/12 hover:bg-white/20 border border-white/15 text-xs font-medium text-white cursor-pointer"
                >
                  查看任务详情
                </button>
              </div>
            </div>
          )}

          {/* Configuration Controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left Column: Package Contents + MV Segment Toggles */}
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-4 space-y-3">
                <p className="text-xs font-semibold text-white/85 flex items-center gap-2">
                  <FolderDown className="w-4 h-4 text-rose-300" />
                  <span>
                    {deliveryMode === 'video-only'
                      ? '导出视频文件：'
                      : `下载文件夹「${folderName}/」将自动包含：`}
                  </span>
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-white/75">
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04]">
                    <Film className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                    <span className="truncate">网页同款播放效果视频</span>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04]">
                    <Globe className="w-3.5 h-3.5 text-fuchsia-300 shrink-0" />
                    <span className="truncate">独立离线网页播放器.html</span>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04]">
                    <FileAudio className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
                    <span className="truncate">歌曲原音频 ({track.format})</span>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04]">
                    <Film className="w-3.5 h-3.5 text-sky-300 shrink-0" />
                    <span className="truncate">
                      {mvRecord?.videoBlob ? 'MV 原视频 + 时间轴' : '未关联本地 MV (纯舞台)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04]">
                    <ImageIcon className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                    <span className="truncate">
                      {track.coverDataUrl ? '高清方形专辑封面图' : '默认专辑封面'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04]">
                    <MessageSquareText className="w-3.5 h-3.5 text-violet-300 shrink-0" />
                    <span className="truncate">
                      {track.lyricsRaw?.trim() ? 'LRC 同步双语歌词' : '暂无 LRC 歌词'}
                    </span>
                  </div>
                </div>
              </div>

              {/* MV Inclusion & Explicit 前瞻 / 中期 / 后期 Toggles */}
              <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-white/85 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-sky-300" />
                    <span>MV 画面与前瞻 / 中期 / 后期包含选项</span>
                  </p>
                  <span className="text-[11px] text-white/45">
                    {mvRecord ? mvRecord.fileName : '未关联 MV'}
                  </span>
                </div>

                {!mvRecord ? (
                  <p className="text-xs text-white/55 leading-relaxed">
                    当前歌曲尚未绑定本地 MV 视频，导出时将生成高画质网页封面舞台 + 实时波形 + 三行流动歌词。
                  </p>
                ) : (
                  <div className="space-y-3">
                    <label className="flex items-center gap-2.5 text-xs text-white/90 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeMvInVideo}
                        onChange={(e) => setIncludeMvInVideo(e.target.checked)}
                        className="accent-rose-500 rounded w-4 h-4 cursor-pointer"
                      />
                      <span className="font-medium">
                        融入关联 MV 画面（左侧固定封面与进度条，右侧无边框流动歌词）
                      </span>
                    </label>

                    <div
                      className={`grid grid-cols-1 gap-2 pl-2 border-l border-white/12 transition-opacity ${
                        includeMvInVideo ? 'opacity-100' : 'opacity-45 pointer-events-none'
                      }`}
                    >
                      <label
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-black/25 border border-white/8 text-xs ${
                          introConfigured ? 'cursor-pointer hover:border-white/20' : 'opacity-55'
                        }`}
                      >
                        <span className="flex items-center gap-2 text-white/85 select-none">
                          <input
                            type="checkbox"
                            disabled={!includeMvInVideo || !introConfigured}
                            checked={introConfigured && includeMvIntro}
                            onChange={(e) => setIncludeMvIntro(e.target.checked)}
                            className="accent-rose-500 rounded cursor-pointer"
                          />
                          <span className="font-medium">包含前瞻 (Intro)</span>
                        </span>
                        <span className="text-[11px] font-mono-tabular text-white/55">
                          {introConfigured ? `约 ${formatTime(introDurationSec)}` : '未标定'}
                        </span>
                      </label>

                      <label
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-black/25 border border-white/8 text-xs ${
                          midConfigured ? 'cursor-pointer hover:border-white/20' : 'opacity-55'
                        }`}
                      >
                        <span className="flex items-center gap-2 text-white/85 select-none">
                          <input
                            type="checkbox"
                            disabled={!includeMvInVideo || !midConfigured}
                            checked={midConfigured && includeMvMidBreaks}
                            onChange={(e) => setIncludeMvMidBreaks(e.target.checked)}
                            className="accent-rose-500 rounded cursor-pointer"
                          />
                          <span className="font-medium">包含中期剧情 (Mid-Breaks)</span>
                        </span>
                        <span className="text-[11px] font-mono-tabular text-white/55">
                          {midConfigured
                            ? `${midBreaksList.length} 段 · 共 ${Math.round(totalMidBreakSec)}s`
                            : '未标定'}
                        </span>
                      </label>

                      <label
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-black/25 border border-white/8 text-xs ${
                          outroConfigured ? 'cursor-pointer hover:border-white/20' : 'opacity-55'
                        }`}
                      >
                        <span className="flex items-center gap-2 text-white/85 select-none">
                          <input
                            type="checkbox"
                            disabled={!includeMvInVideo || !outroConfigured}
                            checked={outroConfigured && includeMvOutro}
                            onChange={(e) => setIncludeMvOutro(e.target.checked)}
                            className="accent-rose-500 rounded cursor-pointer"
                          />
                          <span className="font-medium">包含后期尾声 (Outro)</span>
                        </span>
                        <span className="text-[11px] font-mono-tabular text-white/55">
                          {outroConfigured ? '已标定尾声剧情' : '未标定'}
                        </span>
                      </label>
                    </div>

                    <p className="text-[11px] text-white/50 leading-relaxed">
                      取消勾选任意剧情段后，导出视频将直接跳过对应桥段，且主歌阶段的 MV 与音乐时间轴仍严格保持精确对齐。
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Delivery, Quality, FPS & Clip Options */}
            <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-4 space-y-3.5">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-white/70">下载与打包方式</p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDeliveryMode('zip-folder')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer transition-colors border ${
                      deliveryMode === 'zip-folder'
                        ? 'bg-white/16 border-white/25 text-white'
                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                    }`}
                  >
                    完整歌曲文件夹包 (.zip)
                  </button>
                  {dirPickerSupported && (
                    <button
                      type="button"
                      onClick={() => setDeliveryMode('local-dir')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer transition-colors border ${
                        deliveryMode === 'local-dir'
                          ? 'bg-white/16 border-white/25 text-white'
                          : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                      }`}
                    >
                      直接写入系统文件夹
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDeliveryMode('video-only')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer transition-colors border ${
                      deliveryMode === 'video-only'
                        ? 'bg-white/16 border-white/25 text-white'
                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                    }`}
                  >
                    仅下载效果视频
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-white/70">导出清晰度 (720P – 2160P)</p>
                  <span className="text-[11px] font-mono-tabular text-white/50">
                    {quality === '2160p'
                      ? '3840×2160'
                      : quality === '1440p'
                      ? '2560×1440'
                      : quality === '1080p'
                      ? '1920×1080'
                      : '1280×720'}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {(
                    [
                      { id: '720p', label: '720P', tag: '极速' },
                      { id: '1080p', label: '1080P', tag: '高清' },
                      { id: '1440p', label: '1440P', tag: '2K' },
                      { id: '2160p', label: '2160P', tag: '4K' },
                    ] as { id: MvExportQuality; label: string; tag: string }[]
                  ).map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setQuality(q.id)}
                      className={`py-1.5 px-2 rounded-xl text-xs font-medium cursor-pointer border transition-colors flex items-center justify-center gap-1 whitespace-nowrap ${
                        quality === q.id
                          ? 'bg-white/16 border-white/25 text-white'
                          : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                      }`}
                    >
                      <span className="font-mono-tabular">{q.label}</span>
                      <span className="text-[10px] text-white/55">{q.tag}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-white/70">导出时长</p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDurationMode('full')}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-medium cursor-pointer border transition-colors ${
                      durationMode === 'full'
                        ? 'bg-white/16 border-white/25 text-white'
                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                    }`}
                  >
                    完整全曲
                  </button>
                  <button
                    type="button"
                    onClick={() => setDurationMode('custom')}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-medium cursor-pointer border transition-colors ${
                      durationMode === 'custom'
                        ? 'bg-white/16 border-white/25 text-white'
                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                    }`}
                  >
                    自定义时长
                  </button>
                </div>
              </div>

              {/* Custom FPS Selector (30 - 120 fps) */}
              <div className="space-y-2 pt-0.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-white/70">自定义帧率 (30 - 120 fps)</p>
                  <div className="flex items-center gap-1.5">
                    {[30, 60, 90, 120].map((presetFps) => (
                      <button
                        key={presetFps}
                        type="button"
                        onClick={() => setTargetFps(presetFps)}
                        className={`px-2 py-0.5 rounded-lg text-[11px] font-mono-tabular cursor-pointer border transition-colors ${
                          clampedFps === presetFps
                            ? 'bg-white/18 border-white/30 text-white'
                            : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                        }`}
                      >
                        {presetFps}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={30}
                    max={120}
                    step={1}
                    value={clampedFps}
                    onChange={(e) => setTargetFps(Number(e.target.value))}
                    className="lumina-range flex-1"
                  />
                  <div className="flex items-center gap-1 bg-black/35 border border-white/15 rounded-xl px-2.5 py-1 shrink-0">
                    <input
                      type="number"
                      min={30}
                      max={120}
                      step={1}
                      value={targetFps}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!Number.isNaN(v)) setTargetFps(v);
                      }}
                      onBlur={() => setTargetFps(clampedFps)}
                      className="w-10 bg-transparent text-xs font-mono-tabular text-white text-right outline-none"
                    />
                    <span className="text-[11px] text-white/55">fps</span>
                  </div>
                </div>
              </div>

              {/* Custom Time Range & Duration Controls */}
              {durationMode === 'custom' && (
                <div className="rounded-xl bg-black/25 border border-white/10 p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] text-white/70">
                      片段：{formatTime(clampedStartSec)} → {formatTime(clampedStartSec + clampedDurationSec)}（共 {clampedDurationSec}s）
                    </span>
                    <div className="flex items-center gap-1">
                      {[15, 30, 60, 90].map((presetSec) => (
                        <button
                          key={presetSec}
                          type="button"
                          onClick={() => setCustomDurationSec(Math.min(maxCustomClipSec, presetSec))}
                          className={`px-2 py-0.5 rounded-lg text-[11px] font-mono-tabular cursor-pointer border transition-colors ${
                            clampedDurationSec === Math.min(maxCustomClipSec, presetSec)
                              ? 'bg-white/18 border-white/30 text-white'
                              : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                          }`}
                        >
                          {presetSec}s
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="space-y-1">
                      <span className="block text-[11px] text-white/55">开始时间 (秒)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, totalTrackDuration - 3)}
                        step={1}
                        value={customStartSec}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          setCustomStartSec(Number.isNaN(v) ? 0 : Math.max(0, v));
                        }}
                        onBlur={() => setCustomStartSec(clampedStartSec)}
                        className="w-full rounded-xl bg-black/40 border border-white/15 px-3 py-1.5 text-xs font-mono-tabular text-white outline-none focus:border-white/35"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] text-white/55">导出时长 (秒)</span>
                      <input
                        type="number"
                        min={3}
                        max={maxCustomClipSec}
                        step={1}
                        value={customDurationSec}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          setCustomDurationSec(Number.isNaN(v) ? 3 : Math.max(1, v));
                        }}
                        onBlur={() => setCustomDurationSec(clampedDurationSec)}
                        className="w-full rounded-xl bg-black/40 border border-white/15 px-3 py-1.5 text-xs font-mono-tabular text-white outline-none focus:border-white/35"
                      />
                    </label>
                  </div>
                </div>
              )}

              <p className="text-[11px] text-white/45">
                输出文件名预览：
                <span className="text-white/70 font-mono-tabular ml-1">
                  {deliveryMode === 'video-only'
                    ? `${safeTitle} - 网页同款播放效果视频.mp4`
                    : deliveryMode === 'local-dir'
                    ? `${folderName}/`
                    : `${folderName}.zip`}
                </span>
              </p>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-2xl bg-rose-500/15 border border-rose-400/30 px-4 py-3 text-xs text-rose-100">
              {errorMsg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-white/10 bg-black/25 shrink-0">
          <div className="flex items-center gap-2 text-xs text-white/55">
            <span>
              {loadingAssets
                ? '正在读取曲目音视频与 MV 资源...'
                : audioBlob
                ? `就绪 · 音频 ${formatFileSize(audioBlob.size)}${
                    mvRecord?.videoBlob ? ` · 含 MV ${formatFileSize(mvRecord.videoBlob.size)}` : ''
                  }`
                : '未检测到本地音频文件'}
            </span>
          </div>

          <div className="flex items-center gap-2.5 ml-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-medium text-white/80 cursor-pointer disabled:opacity-50"
            >
              关闭
            </button>
            <button
              type="button"
              disabled={loadingAssets || !audioBlob || submitting}
              onClick={() => void handleSubmitBackgroundExport()}
              className="px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-white flex items-center gap-2 shadow-lg transition-transform active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              style={{
                background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
              }}
            >
              <Download className="w-4 h-4" />
              <span>
                {submitting
                  ? '正在加入队列...'
                  : deliveryMode === 'video-only'
                  ? '加入后台任务并合成视频'
                  : '加入后台任务并导出文件夹'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
