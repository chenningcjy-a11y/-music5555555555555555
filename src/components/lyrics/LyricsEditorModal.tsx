import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Maximize2, Minimize2, Save, X } from 'lucide-react';
import { TrackColorPalette, TrackMetadata } from '../../types/music';
import { parseLrc } from '../../utils/lrcParser';

interface LyricsEditorModalProps {
  open: boolean;
  track: TrackMetadata | null;
  currentTime: number;
  palette: TrackColorPalette;
  onClose: () => void;
  onSave: (rawLrc: string) => void;
}

function formatLrcTimestamp(sec: number): string {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  const wholeSec = Math.floor(rem);
  const centis = Math.floor((rem - wholeSec) * 100);
  return `[${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${String(
    centis
  ).padStart(2, '0')}]`;
}

export const LyricsEditorModal: React.FC<LyricsEditorModalProps> = ({
  open,
  track,
  currentTime,
  palette,
  onClose,
  onSave,
}) => {
  const [draft, setDraft] = useState('');
  const [isFullscreenModal, setIsFullscreenModal] = useState(false);

  useEffect(() => {
    if (open && track) {
      setDraft(track.lyricsRaw || '');
    }
  }, [open, track]);

  const parsedPreview = useMemo(() => parseLrc(draft), [draft]);

  if (!open || !track) return null;

  const insertTimestampAtTopOrEnd = () => {
    const tag = formatLrcTimestamp(currentTime);
    setDraft((prev) => (prev ? `${prev}\n${tag} ` : `${tag} `));
  };

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        isFullscreenModal ? 'p-0' : 'p-2 sm:p-4'
      }`}
    >
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/75 backdrop-blur-md"
      />
      <div
        className={`relative z-10 bg-[#180711]/97 backdrop-blur-2xl flex flex-col shadow-2xl overflow-hidden transition-all ${
          isFullscreenModal
            ? 'w-screen h-[100dvh] rounded-none border-0'
            : 'w-[96vw] max-w-5xl h-[90dvh] border border-white/15 rounded-3xl'
        }`}
      >
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base sm:text-lg font-semibold text-white truncate">
              歌词编辑器 · {track.title}
            </h3>
            <p className="text-xs text-white/55 mt-0.5">
              支持标准 LRC 时间轴、双语 (`原词 // 译文`) 及逐字时间戳 (`&lt;mm:ss.xx&gt;`)
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsFullscreenModal((v) => !v)}
              title={isFullscreenModal ? '还原窗口' : '全屏编辑'}
              className="p-2 rounded-xl text-white/65 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1.5 text-xs"
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
              aria-label="关闭编辑器"
              className="p-2 rounded-xl text-white/65 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="px-5 sm:px-6 py-3 border-b border-white/10 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            onClick={insertTimestampAtTopOrEnd}
            className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/12 text-xs text-white/85 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Clock className="w-3.5 h-3.5" />
            插入当前播放时间 {formatLrcTimestamp(currentTime)}
          </button>
          <span className="text-xs text-white/55 font-mono-tabular">
            {draft.split('\n').filter((l) => l.trim()).length} 行源码 · 解析 {parsedPreview.lines.length} 句
            {parsedPreview.hasSyncedTimestamps ? ' · 同步 LRC' : ' · 纯文本'}
          </span>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 sm:p-5 overflow-hidden">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`[00:12.40]第一句歌词 // First line translation\n[00:18.00]第二句歌词`}
            className="w-full h-full min-h-[260px] p-4 rounded-2xl bg-black/35 border border-white/12 text-sm text-white/90 font-mono-tabular leading-relaxed focus:outline-none focus:border-white/35 resize-none lumina-scroll"
          />

          <div className="hidden lg:flex flex-col min-h-0 rounded-2xl bg-black/25 border border-white/10 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-white/10 text-xs font-medium text-white/70 shrink-0">
              实时解析预览（时间轴与双语拆分）
            </div>
            <div className="flex-1 overflow-y-auto lumina-scroll p-4 space-y-2">
              {parsedPreview.lines.length === 0 ? (
                <p className="text-xs text-white/40 py-8 text-center">
                  左侧输入歌词后可在此实时预览排版效果
                </p>
              ) : (
                parsedPreview.lines.map((line, idx) => (
                  <div
                    key={`${line.time}-${idx}`}
                    className="flex items-start gap-2.5 py-1 border-b border-white/[0.04] last:border-0"
                  >
                    <span className="text-[11px] font-mono-tabular text-white/40 shrink-0 pt-0.5 w-14">
                      {parsedPreview.hasSyncedTimestamps ? formatLrcTimestamp(line.time) : `${idx + 1}.`}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white/95 break-words">{line.text}</p>
                      {line.translation && (
                        <p className="text-xs text-rose-200/80 break-words mt-0.5">
                          {line.translation}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="px-5 sm:px-6 py-4 border-t border-white/10 flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-medium text-white/80 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
            className="px-5 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 shadow-lg transition-transform active:scale-95 cursor-pointer"
            style={{
              background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
            }}
          >
            <Save className="w-3.5 h-3.5" />
            保存歌词
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

