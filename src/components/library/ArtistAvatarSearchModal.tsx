import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Download,
  ImagePlus,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  UserRound,
  X,
} from 'lucide-react';
import {
  downloadAndSaveCandidatePortrait,
  saveCustomUploadedArtistAvatar,
  searchArtistPortraitCandidates,
} from '../../services/artistAvatarService';
import {
  ArtistAvatarCandidate,
  ArtistAvatarRecord,
  TrackColorPalette,
} from '../../types/music';

interface ArtistAvatarSearchModalProps {
  open: boolean;
  artistKey: string;
  artistName: string;
  currentRecord?: ArtistAvatarRecord;
  palette: TrackColorPalette;
  onClose: () => void;
  onSaved: (record: ArtistAvatarRecord) => void;
}

export const ArtistAvatarSearchModal: React.FC<ArtistAvatarSearchModalProps> = ({
  open,
  artistKey,
  artistName,
  currentRecord,
  palette,
  onClose,
  onSaved,
}) => {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ArtistAvatarCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failedPreviewUrls, setFailedPreviewUrls] = useState<Set<string>>(
    () => new Set()
  );
  const [isFullscreenModal, setIsFullscreenModal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const runSearch = async (searchText: string) => {
    const trimmed = searchText.trim();
    if (!trimmed) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearching(true);
    setErrorMsg(null);
    setFailedPreviewUrls(new Set());
    try {
      const list = await searchArtistPortraitCandidates(
        artistName,
        trimmed,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setCandidates(list);
      if (list.length === 0) {
        setErrorMsg('未搜索到可用头像，请尝试换个关键词（例如加上“自拍”或“写真”）');
      }
    } catch {
      if (!controller.signal.aborted) {
        setErrorMsg('图像搜索请求失败，请检查网络连接或手动上传');
      }
    } finally {
      if (!controller.signal.aborted) {
        setSearching(false);
      }
    }
  };

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      return;
    }
    const initialQuery = artistName || '';
    setQuery(initialQuery);
    setErrorMsg(null);
    setFailedPreviewUrls(new Set());

    if (currentRecord?.candidates && currentRecord.candidates.length > 0) {
      setCandidates(currentRecord.candidates);
    } else if (initialQuery) {
      void runSearch(initialQuery);
    }
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, artistKey, artistName]);

  if (!open) return null;

  const handleSelectCandidate = async (candidate: ArtistAvatarCandidate) => {
    setDownloadingUrl(candidate.url);
    setErrorMsg(null);
    try {
      const saved = await downloadAndSaveCandidatePortrait(
        artistKey,
        artistName,
        candidate,
        candidates
      );
      onSaved(saved);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : '下载该图像失败，请尝试其他候选图'
      );
    } finally {
      setDownloadingUrl(null);
    }
  };

  const handleLocalUpload = async (file: File) => {
    setDownloadingUrl('__local__');
    setErrorMsg(null);
    try {
      const saved = await saveCustomUploadedArtistAvatar(
        artistKey,
        artistName,
        file
      );
      onSaved(saved);
      onClose();
    } catch {
      setErrorMsg('读取本地图像失败，请选择有效的图片文件');
    } finally {
      setDownloadingUrl(null);
    }
  };

  const quickQueries = [
    artistName,
    `${artistName} 自拍`,
    `${artistName} 歌手头像`,
    `${artistName} portrait`,
  ];

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md ${
        isFullscreenModal ? 'p-0' : 'p-2 sm:p-4'
      }`}
      onClick={onClose}
    >
      <div
        className={`flex flex-col bg-[#160710]/97 shadow-2xl overflow-hidden transition-all ${
          isFullscreenModal
            ? 'w-screen h-[100dvh] rounded-none border-0'
            : 'w-[96vw] max-w-5xl h-[90dvh] rounded-3xl border border-white/15'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleLocalUpload(f);
            e.target.value = '';
          }}
        />

        {/* Header */}
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl overflow-hidden bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
              {currentRecord?.dataUrl ? (
                <img
                  src={currentRecord.dataUrl}
                  alt={artistName}
                  className="w-full h-full object-cover object-top"
                />
              ) : (
                <UserRound className="w-5 h-5 text-white/55" />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-base sm:text-lg font-semibold text-white truncate">
                搜寻头像 · {artistName}
              </h3>
              <p className="text-xs text-white/55 truncate mt-0.5">
                全网检索歌手写真与自拍照片，点击任意方块自动下载并贴合保存至本地
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsFullscreenModal((v) => !v)}
              title={isFullscreenModal ? '还原窗口' : '全屏显示'}
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
              aria-label="关闭搜索引擎弹窗"
              className="p-2 rounded-xl text-white/55 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search Toolbar */}
        <div className="px-5 sm:px-6 py-3.5 border-b border-white/8 space-y-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query);
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-white/45 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入歌手名称或补充词（如：RAYE 自拍）"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-black/35 border border-white/15 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium text-white flex items-center gap-1.5 shrink-0 disabled:opacity-50 cursor-pointer"
              style={{
                background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
              }}
            >
              {searching ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              <span>{searching ? '搜索中' : '搜图'}</span>
            </button>
          </form>

          {/* Quick search refinements */}
          <div className="flex flex-wrap items-center gap-1.5">
            {quickQueries.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setQuery(item);
                  void runSearch(item);
                }}
                className={`px-2.5 py-1 rounded-lg text-xs transition-colors cursor-pointer whitespace-nowrap ${
                  query.trim() === item
                    ? 'bg-white/16 text-white'
                    : 'bg-white/[0.05] text-white/60 hover:text-white hover:bg-white/10'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        {/* Search Results Grid */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-4">
          {errorMsg && (
            <p className="text-xs text-rose-300 mb-3 bg-rose-500/12 border border-rose-400/20 rounded-xl px-3.5 py-2">
              {errorMsg}
            </p>
          )}

          {searching && candidates.length === 0 ? (
            <div className="py-14 flex flex-col items-center justify-center gap-2.5 text-white/60">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-xs">正在网上搜寻歌手头像与近照...</p>
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-12 text-center space-y-2 text-white/55">
              <UserRound className="w-8 h-8 mx-auto opacity-50" />
              <p className="text-xs">暂无搜索结果，可修改上方搜索词重试或上传本地头像</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {candidates.map((cand) => {
                const isSelected = currentRecord?.sourceUrl === cand.url;
                const isDownloading = downloadingUrl === cand.url;
                const previewBroken = failedPreviewUrls.has(cand.url);

                return (
                  <button
                    key={cand.url}
                    type="button"
                    disabled={Boolean(downloadingUrl)}
                    onClick={() => void handleSelectCandidate(cand)}
                    className={`aspect-square rounded-2xl overflow-hidden relative group bg-white/[0.04] border transition-transform active:scale-95 cursor-pointer ${
                      isSelected
                        ? 'border-white ring-2 ring-white/40'
                        : 'border-white/10 hover:border-white/30'
                    }`}
                  >
                    {!previewBroken ? (
                      <img
                        src={cand.url}
                        alt={cand.label || artistName}
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setFailedPreviewUrls((prev) => {
                            const next = new Set(prev);
                            next.add(cand.url);
                            return next;
                          })
                        }
                        className="w-full h-full object-cover object-top"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center bg-white/[0.04] text-white/55">
                        <Download className="w-4 h-4 mb-1 opacity-70" />
                        <span className="text-[11px] leading-tight">
                          点击下载尝试应用
                        </span>
                      </div>
                    )}

                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2 text-left">
                      <p className="text-[10px] text-white/80 truncate">
                        {cand.source}
                      </p>
                    </div>

                    {isDownloading ? (
                      <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-1 text-white">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="text-[11px]">自动下载中</span>
                      </div>
                    ) : isSelected ? (
                      <div
                        className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center text-white shadow-md"
                        style={{ backgroundColor: palette.primary }}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </div>
                    ) : (
                      <div className="absolute inset-0 bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="px-2.5 py-1 rounded-lg bg-black/75 text-[11px] text-white font-medium">
                          下载贴入
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-6 py-3.5 border-t border-white/10 flex items-center justify-between gap-3 bg-black/25">
          <button
            type="button"
            disabled={Boolean(downloadingUrl)}
            onClick={() => fileInputRef.current?.click()}
            className="px-3.5 py-2 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer"
          >
            <ImagePlus className="w-3.5 h-3.5" />
            <span>从本地上传自拍 / 头像</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-medium text-white/80 cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
