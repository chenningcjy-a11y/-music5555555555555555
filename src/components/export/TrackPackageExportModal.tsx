import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  Download,
  FileAudio,
  Film,
  FolderDown,
  Globe,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useMusic } from '../../context/MusicContext';
import { buildStandalonePlayerHtml } from '../../services/standalonePlayerHtml';
import {
  StageRenderController,
  StageRenderProgress,
  StageRenderResult,
  StageVideoQuality,
  startStageVideoRender,
} from '../../services/stageVideoRenderer';
import { getAudioBlob, getTrackMvs } from '../../services/storage';
import { TrackMetadata, TrackMvRecord } from '../../types/music';
import { formatFileSize, formatTime } from '../../utils/constants';
import {
  buildZipBlob,
  sanitizeFileName,
  saveEntriesToPickedFolder,
  supportsDirectoryPicker,
  triggerBlobDownload,
  ZipPackageEntry,
} from '../../utils/zipStoreBuilder';

interface TrackPackageExportModalProps {
  open: boolean;
  track: TrackMetadata | null;
  onClose: () => void;
}

type ExportDeliveryMode = 'zip-folder' | 'local-dir' | 'video-only';

async function dataUrlToBlob(dataUrl: string): Promise<{ blob: Blob; ext: string } | null> {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const mime = blob.type || 'image/png';
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    return { blob, ext };
  } catch {
    return null;
  }
}

export const TrackPackageExportModal: React.FC<TrackPackageExportModalProps> = ({
  open,
  track,
  onClose,
}) => {
  const {
    activePalette,
    personalization,
    pauseMainPlayer,
    showToast,
  } = useMusic();

  const [deliveryMode, setDeliveryMode] = useState<ExportDeliveryMode>('zip-folder');
  const [quality, setQuality] = useState<StageVideoQuality>('720p');
  const [targetFps, setTargetFps] = useState<number>(60);
  const [durationMode, setDurationMode] = useState<'full' | 'custom'>('full');
  const [customStartSec, setCustomStartSec] = useState<number>(0);
  const [customDurationSec, setCustomDurationSec] = useState<number>(30);
  const [includeMvInVideo, setIncludeMvInVideo] = useState(true);
  const [monitorMuted, setMonitorMuted] = useState(true);

  const [mvRecord, setMvRecord] = useState<TrackMvRecord | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [loadingAssets, setLoadingAssets] = useState(false);

  const [status, setStatus] = useState<'idle' | 'rendering' | 'packaging' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<StageRenderProgress>({
    percent: 0,
    elapsedSec: 0,
    totalSec: 0,
    phaseLabel: '准备就绪',
    engineLabel: '',
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<StageRenderResult | null>(null);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [packagedZipBlob, setPackagedZipBlob] = useState<Blob | null>(null);
  const [manifestFiles, setManifestFiles] = useState<{ path: string; sizeText: string }[]>([]);

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<StageRenderController | null>(null);
  const entriesCacheRef = useRef<ZipPackageEntry[]>([]);

  const dirPickerSupported = useMemo(() => supportsDirectoryPicker(), []);

  useEffect(() => {
    if (!open || !track) return;
    let cancelled = false;

    setStatus('idle');
    setErrorMsg(null);
    setRenderResult(null);
    setPackagedZipBlob(null);
    setManifestFiles([]);
    entriesCacheRef.current = [];
    if (previewVideoUrl) {
      URL.revokeObjectURL(previewVideoUrl);
      setPreviewVideoUrl(null);
    }

    setLoadingAssets(true);
    Promise.all([getAudioBlob(track.id), getTrackMvs(track.id)])
      .then(([aBlob, mvs]) => {
        if (cancelled) return;
        setAudioBlob(aBlob || null);
        const active = mvs.find((m) => m.isActive) || mvs[0] || null;
        setMvRecord(active);
        setIncludeMvInVideo(Boolean(active));
      })
      .finally(() => {
        if (!cancelled) setLoadingAssets(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, track?.id]);

  useEffect(() => {
    return () => {
      controllerRef.current?.cancel();
      if (previewVideoUrl) URL.revokeObjectURL(previewVideoUrl);
    };
  }, [previewVideoUrl]);

  if (!open || !track) return null;

  const folderName = sanitizeFileName(`${track.title} - ${track.artist}`, 'LuminaTrack');
  const audioExt = (track.format || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
  const safeTitle = sanitizeFileName(track.title, 'track');

  const totalTrackDuration = Math.max(3, Math.round(track.duration || 30));
  const clampedFps = Math.max(60, Math.min(120, Math.round(targetFps || 60)));
  const clampedStartSec = Math.max(
    0,
    Math.min(Math.max(0, totalTrackDuration - 3), Math.round(customStartSec || 0))
  );
  const maxCustomClipSec = Math.max(3, totalTrackDuration - clampedStartSec);
  const clampedDurationSec = Math.max(
    3,
    Math.min(maxCustomClipSec, Math.round(customDurationSec || 30))
  );
  const effectiveDurationSec =
    durationMode === 'custom' ? clampedDurationSec : totalTrackDuration;

  const handleToggleMonitorMute = () => {
    const next = !monitorMuted;
    setMonitorMuted(next);
    controllerRef.current?.setMonitorMuted(next);
  };

  const handleCancel = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    if (status === 'rendering' || status === 'packaging') {
      setStatus('idle');
      return;
    }
    onClose();
  };

  const handleStartExport = async () => {
    if (!track || !audioBlob) {
      setErrorMsg('未找到当前曲目的本地音频文件，请重新导入歌曲后再试。');
      setStatus('error');
      return;
    }

    pauseMainPlayer();
    setErrorMsg(null);
    setRenderResult(null);
    setPackagedZipBlob(null);
    if (previewVideoUrl) {
      URL.revokeObjectURL(previewVideoUrl);
      setPreviewVideoUrl(null);
    }

    setStatus('rendering');
    setProgress({
      percent: 1,
      elapsedSec: 0,
      totalSec: effectiveDurationSec,
      phaseLabel: `正在初始化 ${clampedFps} fps 渲染引擎与音频频谱...`,
      engineLabel: includeMvInVideo && mvRecord ? `MV 联动 · ${clampedFps} fps` : `WebCodecs · ${clampedFps} fps`,
    });

    const ctrl = startStageVideoRender({
      track,
      audioBlob,
      mvRecord: includeMvInVideo ? mvRecord : null,
      includeMvInVideo: Boolean(includeMvInVideo && mvRecord),
      showBilingual: personalization.showBilingualLyrics,
      showWordSync: personalization.showWordSync,
      fontPreset: personalization.fontPreset,
      animationIntensity: personalization.animationIntensity,
      quality,
      fps: clampedFps,
      startOffsetSec: durationMode === 'custom' ? clampedStartSec : 0,
      clipDurationSec: durationMode === 'custom' ? clampedDurationSec : null,
      mvUiFadeInSec: personalization.mvUiFadeInSec,
      mvUiFadeOutSec: personalization.mvUiFadeOutSec,
      previewCanvas: previewCanvasRef.current,
      monitorMuted,
      onProgress: (info) => setProgress(info),
    });

    controllerRef.current = ctrl;

    try {
      const result = await ctrl.promise;
      controllerRef.current = null;
      setRenderResult(result);
      const vidUrl = URL.createObjectURL(result.videoBlob);
      setPreviewVideoUrl(vidUrl);

      const videoFileName = `${safeTitle} - 网页同款播放效果视频.${result.extension}`;

      if (deliveryMode === 'video-only') {
        triggerBlobDownload(result.videoBlob, videoFileName);
        setManifestFiles([{ path: videoFileName, sizeText: formatFileSize(result.videoBlob.size) }]);
        setStatus('done');
        showToast(`已生成并开始下载：${videoFileName}`);
        return;
      }

      // Assemble complete Song Folder package: Video + Offline Player HTML + Audio + MV + Cover + LRC
      setStatus('packaging');
      setProgress((prev) => ({
        ...prev,
        percent: 99,
        phaseLabel: `正在打包「${folderName}/」歌曲文件夹（MV、播放器、封面、歌词、视频）...`,
      }));

      const audioRelPath = `音频/${folderName}.${audioExt}`;
      let coverRelPath = '';
      let coverBlobInfo: { blob: Blob; ext: string } | null = null;
      if (track.coverDataUrl) {
        coverBlobInfo = await dataUrlToBlob(track.coverDataUrl);
        if (coverBlobInfo) {
          coverRelPath = `专辑封面/${safeTitle}.${coverBlobInfo.ext}`;
        }
      }

      const lyricsRelPath = track.lyricsRaw?.trim() ? `歌词/${safeTitle}.lrc` : '';
      let mvRelPath = '';
      if (mvRecord?.videoBlob) {
        const mvExt =
          mvRecord.fileName.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
        mvRelPath = `MV/${safeTitle} - MV.${mvExt}`;
      }

      const htmlStr = buildStandalonePlayerHtml({
        track,
        audioRelPath: `./${audioRelPath}`,
        mvRelPath: mvRelPath ? `./${mvRelPath}` : undefined,
        mvMeta: mvRecord,
        coverRelPath: coverRelPath ? `./${coverRelPath}` : undefined,
        lyricsRelPath: lyricsRelPath ? `./${lyricsRelPath}` : undefined,
        videoRelPath: `./${videoFileName}`,
        fontPreset: personalization.fontPreset,
        showBilingual: personalization.showBilingualLyrics,
      });

      const entries: ZipPackageEntry[] = [
        {
          path: `${folderName}/${videoFileName}`,
          data: result.videoBlob,
        },
        {
          path: `${folderName}/音乐播放器 - ${safeTitle}.html`,
          data: htmlStr,
        },
        {
          path: `${folderName}/${audioRelPath}`,
          data: audioBlob,
        },
      ];

      if (mvRecord?.videoBlob && mvRelPath) {
        entries.push({
          path: `${folderName}/${mvRelPath}`,
          data: mvRecord.videoBlob,
        });
        entries.push({
          path: `${folderName}/MV/mv-timeline.json`,
          data: JSON.stringify(mvRecord.timeline, null, 2),
        });
      }

      if (coverBlobInfo && coverRelPath) {
        entries.push({
          path: `${folderName}/${coverRelPath}`,
          data: coverBlobInfo.blob,
        });
      }

      if (lyricsRelPath && track.lyricsRaw) {
        entries.push({
          path: `${folderName}/${lyricsRelPath}`,
          data: track.lyricsRaw,
        });
      }

      entriesCacheRef.current = entries;

      const summaryManifest = entries.map((e) => ({
        path: e.path,
        sizeText:
          typeof e.data === 'string'
            ? formatFileSize(new Blob([e.data]).size)
            : formatFileSize(e.data instanceof Uint8Array ? e.data.byteLength : e.data.size),
      }));
      setManifestFiles(summaryManifest);

      if (deliveryMode === 'local-dir') {
        const saved = await saveEntriesToPickedFolder(folderName, entries);
        setStatus('done');
        showToast(`已将 ${saved.fileCount} 个文件保存至本地文件夹「${saved.folderName}」`);
      } else {
        const zipBlob = await buildZipBlob(entries);
        setPackagedZipBlob(zipBlob);
        triggerBlobDownload(zipBlob, `${folderName}.zip`);
        setStatus('done');
        showToast(`已自动下载歌曲文件夹包：${folderName}.zip`);
      }
    } catch (err) {
      controllerRef.current = null;
      const msg = err instanceof Error ? err.message : '导出失败';
      if (msg.includes('已取消')) {
        setStatus('idle');
      } else {
        setErrorMsg(msg);
        setStatus('error');
      }
    }
  };

  const handleSaveToLocalFolderAfterRender = async () => {
    if (entriesCacheRef.current.length === 0) return;
    try {
      const saved = await saveEntriesToPickedFolder(folderName, entriesCacheRef.current);
      showToast(`已直接写入本地文件夹「${saved.folderName}」（${saved.fileCount} 项）`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '写入本地文件夹失败');
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-3 sm:p-5 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget && status !== 'rendering' && status !== 'packaging') {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-4xl rounded-3xl bg-[#16060f]/96 border border-white/15 shadow-[0_32px_90px_rgba(0,0,0,0.75)] overflow-hidden flex flex-col max-h-[92dvh]">
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
                一键导出网页同款视频 & 完整歌曲文件夹
              </h2>
              <p className="text-xs text-white/60 truncate">
                {track.title} · {track.artist}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCancel}
            aria-label="关闭导出窗口"
            className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto lumina-scroll p-5 sm:p-6 space-y-5">
          {/* On-Screen Stage Preview Box */}
          <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black/70 border border-white/12 shadow-2xl flex items-center justify-center">
            {status === 'done' && previewVideoUrl ? (
              <video
                src={previewVideoUrl}
                controls
                autoPlay
                loop
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            ) : (
              <>
                <canvas
                  ref={previewCanvasRef}
                  className={`w-full h-full object-contain ${
                    status === 'rendering' || status === 'packaging' ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                {status !== 'rendering' && status !== 'packaging' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 gap-3">
                    <div
                      className="w-14 h-14 rounded-2xl flex items-center justify-center border border-white/15 shadow-lg"
                      style={{
                        background: `linear-gradient(135deg, ${activePalette.primary}40, ${activePalette.secondary}40)`,
                      }}
                    >
                      <Film className="w-7 h-7 text-white" />
                    </div>
                    <div className="space-y-1 max-w-lg">
                      <p className="text-sm sm:text-base font-semibold text-white">
                        无需外部录屏，直接将全屏网页舞台合成为高帧率视频并打包歌曲文件夹
                      </p>
                      <p className="text-xs text-white/60 leading-relaxed">
                        画面与当前全屏网页一致：左侧固定圆角方形专辑图与作曲家/歌手信息，右侧无边框三行流动歌词（使用当前网页字体）{mvRecord ? '，以及已关联 MV 的剧情联动' : ''}。
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Live Rendering Progress Pill */}
            {(status === 'rendering' || status === 'packaging') && (
              <div className="absolute bottom-3 left-3 right-3 rounded-2xl bg-black/78 backdrop-blur-xl border border-white/15 px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-white font-medium flex items-center gap-2 truncate">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-300 shrink-0" />
                    {progress.phaseLabel}
                  </span>
                  <span className="font-mono-tabular text-white/75 shrink-0">
                    {Math.round(progress.percent)}% · {formatTime(progress.elapsedSec)} / {formatTime(progress.totalSec)}
                    {progress.fps ? ` · ${progress.fps} fps` : ''}
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-150"
                    style={{
                      width: `${Math.max(2, Math.min(100, progress.percent))}%`,
                      background: `linear-gradient(90deg, ${activePalette.primary}, ${activePalette.secondary})`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Configuration Controls (shown when idle / error) */}
          {(status === 'idle' || status === 'error') && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left: Folder Contents Checklist */}
              <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-4 space-y-3">
                <p className="text-xs font-semibold text-white/85 flex items-center gap-2">
                  <FolderDown className="w-4 h-4 text-rose-300" />
                  <span>下载文件夹「{folderName}/」将自动包含：</span>
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

              {/* Right: Export Options */}
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-white/70">导出清晰度</p>
                    <div className="flex gap-1.5">
                      {(['720p', '1080p'] as StageVideoQuality[]).map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => setQuality(q)}
                          className={`flex-1 py-1.5 rounded-xl text-xs font-medium cursor-pointer border transition-colors ${
                            quality === q
                              ? 'bg-white/16 border-white/25 text-white'
                              : 'bg-white/[0.04] border-white/10 text-white/60 hover:text-white'
                          }`}
                        >
                          {q === '720p' ? '720P 极速' : '1080P 超清'}
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
                </div>

                {/* Custom FPS Selector (60 - 120 fps) */}
                <div className="space-y-2 pt-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-white/70">自定义帧率 (60 - 120 fps)</p>
                    <div className="flex items-center gap-1.5">
                      {[60, 90, 120].map((presetFps) => (
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
                      min={60}
                      max={120}
                      step={1}
                      value={clampedFps}
                      onChange={(e) => setTargetFps(Number(e.target.value))}
                      className="lumina-range flex-1"
                    />
                    <div className="flex items-center gap-1 bg-black/35 border border-white/15 rounded-xl px-2.5 py-1 shrink-0">
                      <input
                        type="number"
                        min={60}
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

                {mvRecord && (
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <label className="flex items-center gap-2 text-xs text-white/80 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeMvInVideo}
                        onChange={(e) => setIncludeMvInVideo(e.target.checked)}
                        className="accent-rose-500 rounded"
                      />
                      <span>将关联 MV 画面与前瞻/中段/后段融入效果视频（实时同步合成）</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Done Manifest */}
          {status === 'done' && renderResult && (
            <div className="rounded-2xl bg-emerald-500/10 border border-emerald-400/25 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    已生成完成并自动触发下载（{renderResult.width}×{renderResult.height} ·{' '}
                    {renderResult.fps} fps · {formatTime(renderResult.durationSec)} ·{' '}
                    {formatFileSize(packagedZipBlob?.size || renderResult.videoBlob.size)}）
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      triggerBlobDownload(
                        renderResult.videoBlob,
                        `${safeTitle} - 网页同款播放效果视频.${renderResult.extension}`
                      )
                    }
                    className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/16 border border-white/15 text-xs font-medium text-white cursor-pointer"
                  >
                    单独下载效果视频
                  </button>
                  {packagedZipBlob && (
                    <button
                      type="button"
                      onClick={() => triggerBlobDownload(packagedZipBlob, `${folderName}.zip`)}
                      className="px-3 py-1.5 rounded-xl bg-white/16 hover:bg-white/24 border border-white/20 text-xs font-medium text-white cursor-pointer"
                    >
                      重新下载完整文件夹包 (.zip)
                    </button>
                  )}
                  {dirPickerSupported && entriesCacheRef.current.length > 0 && (
                    <button
                      type="button"
                      onClick={handleSaveToLocalFolderAfterRender}
                      className="px-3 py-1.5 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-300/30 text-xs font-medium text-emerald-100 cursor-pointer"
                    >
                      写入本地文件夹
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {manifestFiles.map((item) => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-black/30 border border-white/8 text-xs"
                  >
                    <span className="text-white/85 truncate" title={item.path}>
                      {item.path}
                    </span>
                    <span className="font-mono-tabular text-white/50 shrink-0">
                      {item.sizeText}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-2xl bg-rose-500/15 border border-rose-400/30 px-4 py-3 text-xs text-rose-100">
              {errorMsg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-white/10 bg-black/25 shrink-0">
          <div className="flex items-center gap-2 text-xs text-white/55">
            {status === 'rendering' && includeMvInVideo && mvRecord && (
              <button
                type="button"
                onClick={handleToggleMonitorMute}
                className="px-3 py-1.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-white/85 flex items-center gap-1.5 cursor-pointer"
              >
                {monitorMuted ? (
                  <>
                    <VolumeX className="w-3.5 h-3.5" />
                    <span>合成中已静音（点击监听）</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="w-3.5 h-3.5 text-rose-300" />
                    <span>正在监听合成声音</span>
                  </>
                )}
              </button>
            )}
            {status !== 'rendering' && (
              <span>
                {loadingAssets
                  ? '正在读取曲目音视频与 MV 资源...'
                  : audioBlob
                  ? `就绪 · 音频 ${formatFileSize(audioBlob.size)}${
                      mvRecord?.videoBlob ? ` · 含 MV ${formatFileSize(mvRecord.videoBlob.size)}` : ''
                    }`
                  : '未检测到本地音频文件'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 ml-auto">
            {status === 'rendering' ? (
              <>
                <button
                  type="button"
                  onClick={() => controllerRef.current?.finishEarly()}
                  className="px-4 py-2 rounded-xl bg-white/12 hover:bg-white/20 border border-white/18 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" fill="currentColor" />
                  提前完成并下载已录片段
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-4 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/30 text-xs font-medium text-rose-100 cursor-pointer"
                >
                  取消导出
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-medium text-white/80 cursor-pointer"
                >
                  关闭
                </button>
                <button
                  type="button"
                  disabled={loadingAssets || !audioBlob || status === 'packaging'}
                  onClick={handleStartExport}
                  className="px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-white flex items-center gap-2 shadow-lg transition-transform active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  style={{
                    background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
                  }}
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {status === 'done'
                      ? '重新合成导出'
                      : deliveryMode === 'video-only'
                      ? '点击合成并自动下载视频'
                      : '一键合成并下载歌曲文件夹'}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
