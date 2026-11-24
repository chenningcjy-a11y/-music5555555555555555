import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Cpu,
  FileText,
  Languages,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useAi } from '../../context/AiContext';
import { useMusic } from '../../context/MusicContext';
import {
  LYRIC_TRANSLATION_STYLES,
  LyricTranslationStyle,
} from '../../services/ai/aiTranslationService';
import { testProviderApi } from '../../services/ai/providerManager';
import { TrackColorPalette, TrackMetadata } from '../../types/music';
import { formatTime } from '../../utils/constants';
import {
  LyricTargetLanguage,
  OnlineLyricResult,
  parseLrc,
  searchOnlineLyrics,
  translateLyricsToBilingual,
} from '../../utils/lrcParser';

interface LyricsSearchModalProps {
  open: boolean;
  track: TrackMetadata | null;
  palette: TrackColorPalette;
  onClose: () => void;
  onApplyLyrics: (rawLrc: string) => void;
}

function formatSecTag(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const LyricsSearchModal: React.FC<LyricsSearchModalProps> = ({
  open,
  track,
  palette,
  onClose,
  onApplyLyrics,
}) => {
  const { updatePersonalization, showToast } = useMusic();
  const {
    providers,
    selectedProviderId,
    setSelectedProviderId,
    selectedModel,
    setSelectedModel,
    activeProvider,
    isLoadingProviders,
    beginTask,
    finishTask,
  } = useAi();

  const isStaticNoAiBackend = !isLoadingProviders && providers.length === 0;

  const [titleQuery, setTitleQuery] = useState('');
  const [artistQuery, setArtistQuery] = useState('');
  const [includeTranslation, setIncludeTranslation] = useState(true);
  const [targetLanguage, setTargetLanguage] = useState<LyricTargetLanguage>('zh-CN');

  const [enableModelTranslation, setEnableModelTranslation] = useState(true);
  const [translationStyle, setTranslationStyle] =
    useState<LyricTranslationStyle>('poetic');

  const [loading, setLoading] = useState(false);
  const [translatingId, setTranslatingId] = useState<number | null>(null);
  const [failedTranslationId, setFailedTranslationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<OnlineLyricResult[]>([]);
  const [previewResultId, setPreviewResultId] = useState<number | null>(null);
  const [isFullscreenModal, setIsFullscreenModal] = useState(false);
  const [mobileViewMode, setMobileViewMode] = useState<'list' | 'preview'>('list');

  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (open && track) {
      setTitleQuery(track.title.replace(/\(.*\)|\[.*\]/g, '').trim());
      setArtistQuery(
        track.artist === '未知艺术家' || track.artist === 'Lumina Acoustic Ensemble'
          ? ''
          : track.artist
      );
      setResults([]);
      setPreviewResultId(null);
      setMobileViewMode('list');
      setError(null);
      setTranslatingId(null);
      setFailedTranslationId(null);
      setTestResult(null);
      setEnableModelTranslation(!isStaticNoAiBackend);
    }
  }, [open, track, isStaticNoAiBackend]);

  const availableModels = useMemo(() => {
    if (!activeProvider) return [];
    const list = [activeProvider.model, ...(activeProvider.availableModels || [])];
    return Array.from(new Set(list.filter(Boolean)));
  }, [activeProvider]);

  const selectedPreviewItem = useMemo(() => {
    if (results.length === 0) return null;
    return results.find((r) => r.id === previewResultId) || results[0] || null;
  }, [results, previewResultId]);

  const selectedPreviewRaw =
    selectedPreviewItem?.syncedLyrics || selectedPreviewItem?.plainLyrics || '';

  const parsedPreview = useMemo(
    () => (selectedPreviewRaw ? parseLrc(selectedPreviewRaw) : null),
    [selectedPreviewRaw]
  );

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!titleQuery.trim() && !artistQuery.trim()) return;
    setLoading(true);
    setError(null);
    setFailedTranslationId(null);
    try {
      const list = await searchOnlineLyrics(titleQuery, artistQuery);
      setResults(list);
      setPreviewResultId(list[0]?.id ?? null);
      setMobileViewMode('list');
      if (list.length === 0) {
        setError('未检索到匹配的在线歌词，请尝试简化歌名或手动导入 .lrc 文件。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '在线检索失败，请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedProviderId) return;
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await testProviderApi(selectedProviderId);
      if (res.ok) {
        setTestResult({ ok: true, msg: `连接正常 (${res.latencyMs}ms)` });
        showToast(`AI 服务「${activeProvider?.name || '当前服务'}」连接正常 (${res.latencyMs}ms)`);
      } else {
        setTestResult({ ok: false, msg: res.error || '连接失败' });
        showToast(`连接失败: ${res.error || '请检查密钥或网络'}`);
      }
    } catch (err) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : '连接测试异常',
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleApplyResult = async (
    item: OnlineLyricResult,
    raw: string,
    action: 'auto' | 'force_original' | 'force_model' = 'auto'
  ) => {
    const parsedCheck = parseLrc(raw);
    const hasNative = Boolean(item.hasNativeTranslation || parsedCheck.hasTranslations);

    if (action === 'force_original') {
      onApplyLyrics(raw);
      showToast('已应用原始歌词');
      onClose();
      return;
    }

    if (hasNative && action !== 'force_model') {
      updatePersonalization({ showBilingualLyrics: true });
      onApplyLyrics(raw);
      showToast('已匹配并应用自带双语同步歌词');
      onClose();
      return;
    }

    if (!enableModelTranslation && action !== 'force_model') {
      onApplyLyrics(raw);
      showToast('已应用歌词（未开启模型翻译）');
      onClose();
      return;
    }

    if (activeProvider && !activeProvider.enabled) {
      setError(`所选服务商「${activeProvider.name}」已被禁用，请先在 AI 智能中心启用。`);
      setFailedTranslationId(item.id);
      return;
    }
    if (activeProvider && !activeProvider.hasKey) {
      setError(`所选服务商「${activeProvider.name}」尚未配置 API Key，请前往「AI 智能中心 → API 服务管理」填写您的密钥，或切换为「原生态 Google Gemini」。`);
      setFailedTranslationId(item.id);
      return;
    }

    const providerName = activeProvider?.name || '原生态 Google Gemini';
    const modelToUse = selectedModel || activeProvider?.model || 'gemini-4-hydrogen';
    const styleLabel =
      LYRIC_TRANSLATION_STYLES.find((s) => s.id === translationStyle)?.label ||
      '诗意翻译';

    setTranslatingId(item.id);
    setError(null);
    setFailedTranslationId(null);

    let taskId: string | null = null;
    try {
      const taskSession = beginTask({
        taskName: `AI歌词翻译: ${item.trackName} · ${providerName} (${styleLabel})`,
        category: 'lyrics_assistant',
        providerName,
        modelName: modelToUse,
        track,
        trackTitle: item.trackName,
        replayPayload: {
          category: 'lyrics_assistant',
          prompt: `翻译歌词为 ${targetLanguage} (${styleLabel})`,
          targetTrackId: track?.id,
          extra: {
            rawLyrics: raw,
            style: translationStyle,
            targetLanguage,
          },
        },
      });
      taskId = taskSession.task.id;
    } catch {
      // ignore tracking error
    }

    try {
      const res = await translateLyricsToBilingual(
        raw,
        item.trackName,
        item.artistName,
        targetLanguage,
        translationStyle,
        activeProvider?.id,
        modelToUse
      );

      const usedProvider = res.providerName || providerName;
      const usedModel = res.modelUsed || modelToUse;

      if (taskId) {
        finishTask(taskId, 'completed', {
          providerName: usedProvider,
          modelName: usedModel,
          resultSummary: `已使用 ${usedProvider} (${usedModel}) 完成 ${res.translatedCount} 行歌词翻译 (${styleLabel})`,
          resultData: {
            bilingualLyrics: res.bilingualLyrics,
            translatedCount: res.translatedCount,
            provider: usedProvider,
            model: usedModel,
            style: translationStyle,
          },
        });
      }

      updatePersonalization({ showBilingualLyrics: true });
      onApplyLyrics(res.bilingualLyrics);

      if (res.translatedCount > 0) {
        showToast(
          `已使用 ${usedProvider} (${styleLabel}) 完成 ${res.translatedCount} 行歌词翻译并同步时间轴`
        );
      } else {
        showToast('歌词翻译已就绪');
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '自动翻译失败';
      if (taskId) {
        finishTask(taskId, 'error', { errorMessage: msg });
      }
      setError(`${msg}（可点击“仅原版”先使用原版歌词）`);
      setFailedTranslationId(item.id);
    } finally {
      setTranslatingId(null);
    }
  };

  if (!open || !track) return null;

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
            : 'w-[98vw] max-w-6xl h-[92dvh] border border-white/15 rounded-3xl'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <h3 className="text-base sm:text-lg font-semibold text-white truncate">
              智能在线歌词匹配与完整预览 (多源双语)
            </h3>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded-lg text-[11px] bg-rose-500/15 border border-rose-400/25 text-rose-200 shrink-0">
              AI 歌词中心
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsFullscreenModal((v) => !v)}
              title={isFullscreenModal ? '还原窗口大小' : '全屏展示'}
              aria-label={isFullscreenModal ? '还原窗口大小' : '全屏展示'}
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
              aria-label="关闭歌词搜索"
              className="p-2 rounded-xl text-white/65 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Search & AI Controls Form */}
        <form
          onSubmit={handleSearch}
          className="px-4 sm:px-6 py-3.5 border-b border-white/10 space-y-3 shrink-0"
        >
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-5">
              <label className="block text-xs text-white/60 mb-1">歌曲名称</label>
              <input
                type="text"
                value={titleQuery}
                onChange={(e) => setTitleQuery(e.target.value)}
                placeholder="输入歌名..."
                className="w-full px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
            <div className="sm:col-span-4">
              <label className="block text-xs text-white/60 mb-1">艺术家 (可选)</label>
              <input
                type="text"
                value={artistQuery}
                onChange={(e) => setArtistQuery(e.target.value)}
                placeholder="输入歌手..."
                className="w-full px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
            <div className="sm:col-span-3 flex justify-end">
              <button
                type="submit"
                disabled={loading || translatingId !== null}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl text-xs sm:text-sm font-medium text-white flex items-center justify-center gap-2 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer shadow-lg whitespace-nowrap"
                style={{
                  background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                }}
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                <span>搜索 LRC 歌词</span>
              </button>
            </div>
          </div>

          {/* Translation Options Toolbar */}
          <div className="pt-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="flex items-center gap-2 text-xs text-white/85 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeTranslation}
                  onChange={(e) => setIncludeTranslation(e.target.checked)}
                  className="accent-rose-500 w-4 h-4 rounded"
                />
                <Sparkles className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                <span className="font-medium">自动附带诗意翻译</span>
              </label>

              {includeTranslation && (
                <select
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value as LyricTargetLanguage)}
                  aria-label="翻译目标语言"
                  className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none cursor-pointer"
                >
                  <option value="zh-CN" className="bg-[#1b0711]">简体中文 (诗意)</option>
                  <option value="zh-TW" className="bg-[#1b0711]">繁體中文 (詩意)</option>
                  <option value="en" className="bg-[#1b0711]">English</option>
                  <option value="ja" className="bg-[#1b0711]">日本語</option>
                </select>
              )}

              <div className="h-4 w-px bg-white/20 hidden sm:block" />

              <label
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs cursor-pointer select-none transition-all ${
                  enableModelTranslation
                    ? 'bg-rose-500/20 border-rose-400/40 text-rose-100 shadow-sm'
                    : 'bg-white/6 border-white/12 text-white/55 hover:text-white/80'
                }`}
                title="此模型翻译对应着翻译没有双语的歌词"
              >
                <input
                  type="checkbox"
                  checked={enableModelTranslation}
                  onChange={(e) => setEnableModelTranslation(e.target.checked)}
                  className="accent-rose-500 w-3.5 h-3.5 rounded"
                />
                <Cpu className="w-3.5 h-3.5 text-rose-300 shrink-0" />
                <span className="font-medium whitespace-nowrap">模型翻译</span>
              </label>

              {enableModelTranslation && (
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <select
                    value={selectedProviderId}
                    onChange={(e) => setSelectedProviderId(e.target.value)}
                    aria-label="选择 AI 翻译服务商"
                    className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none max-w-[260px] cursor-pointer"
                    title="选择 AI 翻译引擎服务商（原生态谷歌 AI / 个人 API 密钥）"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id} className="bg-[#1b0711]">
                        {p.id === '__builtin_gemini__'
                          ? p.name
                          : `${p.name}${!p.hasKey ? ' (未配密钥)' : ''}`}
                      </option>
                    ))}
                  </select>

                  {availableModels.length > 1 && (
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      aria-label="选择具体模型"
                      className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none max-w-[230px] font-mono-tabular cursor-pointer"
                      title="选择具体模型"
                    >
                      {availableModels.map((m) => (
                        <option key={m} value={m} className="bg-[#1b0711]">
                          {m}
                        </option>
                      ))}
                    </select>
                  )}

                  <select
                    value={translationStyle}
                    onChange={(e) =>
                      setTranslationStyle(e.target.value as LyricTranslationStyle)
                    }
                    aria-label="翻译风格"
                    className="px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs text-white/90 focus:outline-none cursor-pointer"
                    title="选择歌词翻译风格"
                  >
                    {LYRIC_TRANSLATION_STYLES.map((style) => (
                      <option
                        key={style.id}
                        value={style.id}
                        className="bg-[#1b0711]"
                      >
                        {style.label}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testingConnection || !selectedProviderId}
                    className="px-2.5 py-1.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-[11px] text-white/80 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
                    title="测试与当前所选 AI 服务的连通性"
                  >
                    {testingConnection ? (
                      <Loader2 className="w-3 h-3 animate-spin text-rose-300" />
                    ) : (
                      <Zap className="w-3 h-3 text-rose-300" />
                    )}
                    <span>测试</span>
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/55 border-t border-white/6 pt-2">
              <span className="flex items-center gap-1">
                <span className="text-rose-300/80">✦</span>
                <span>
                  {isStaticNoAiBackend
                    ? '当前为纯静态部署模式：已启用前端直连 LRC 检索。'
                    : '默认支持原生态 Google Gemini（免密钥）及您的个人 API 密钥；点击任一搜索结果可在右侧实时完整预览歌词内容。'}
                </span>
              </span>

              {testResult && (
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-lg border ${
                    testResult.ok
                      ? 'bg-emerald-500/15 border-emerald-400/25 text-emerald-300'
                      : 'bg-rose-500/15 border-rose-400/25 text-rose-300'
                  }`}
                >
                  {testResult.msg}
                </span>
              )}
            </div>
          </div>
        </form>

        {/* Mobile List / Preview Switcher */}
        {results.length > 0 && (
          <div className="flex lg:hidden border-b border-white/10 px-4 py-2 gap-2 shrink-0 bg-black/20">
            <button
              type="button"
              onClick={() => setMobileViewMode('list')}
              className={`flex-1 py-1.5 rounded-xl text-xs font-medium cursor-pointer ${
                mobileViewMode === 'list'
                  ? 'bg-white/15 text-white'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              搜索结果 ({results.length})
            </button>
            <button
              type="button"
              onClick={() => setMobileViewMode('preview')}
              className={`flex-1 py-1.5 rounded-xl text-xs font-medium cursor-pointer ${
                mobileViewMode === 'preview'
                  ? 'bg-white/15 text-white'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              歌词全文预览
            </button>
          </div>
        )}

        {/* Main Split Body: Left Results + Right Full Lyrics Preview */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left Results List */}
          <div
            className={`lg:col-span-6 overflow-y-auto lumina-scroll p-4 space-y-2.5 lg:border-r lg:border-white/10 ${
              mobileViewMode === 'preview' ? 'hidden lg:block' : 'block'
            }`}
          >
            {error && (
              <p className="text-xs text-rose-300/90 text-center py-3 px-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl">
                {error}
              </p>
            )}

            {results.length === 0 && !loading && !error && (
              <div className="py-16 text-center text-xs text-white/45 space-y-1.5">
                <p>输入歌名或歌手并点击“搜索 LRC 歌词”</p>
                <p className="text-[11px] text-white/35">
                  支持智能聚合网易云原生双语歌词与 LRCLIB 纯净歌词，支持全屏完整对比预览
                </p>
              </div>
            )}

            {results.map((item) => {
              const raw = item.syncedLyrics || item.plainLyrics;
              if (!raw) return null;
              const isSynced = Boolean(item.syncedLyrics);
              const isTranslating = translatingId === item.id;
              const showOriginalFallback = failedTranslationId === item.id;
              const hasNativeTrans = Boolean(item.hasNativeTranslation);
              const providerLabel = activeProvider?.name || 'AI 模型';
              const isPreviewSelected = selectedPreviewItem?.id === item.id;

              return (
                <div
                  key={item.id}
                  onClick={() => {
                    setPreviewResultId(item.id);
                    setMobileViewMode('preview');
                  }}
                  className={`p-3.5 rounded-2xl border flex flex-col gap-3 transition-colors cursor-pointer ${
                    isPreviewSelected
                      ? 'bg-white/12 border-white/30 shadow-md'
                      : 'bg-white/[0.045] hover:bg-white/[0.08] border-white/10'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-white truncate">
                        {item.trackName}
                      </p>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {hasNativeTrans ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] bg-rose-500/20 text-rose-300 border border-rose-400/30 font-medium">
                            自带双语
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-white/10 text-white/60 border border-white/10">
                            无双语
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-white/60 truncate mt-1">
                      {item.artistName}
                      {item.albumName ? ` · ${item.albumName}` : ''}
                      {item.duration ? ` · ${formatTime(item.duration)}` : ''}
                      {item.source ? ` · ${item.source}` : ''}
                      {' · '}
                      <span
                        className={
                          isSynced
                            ? 'text-emerald-300 font-mono-tabular'
                            : 'text-white/50'
                        }
                      >
                        {isSynced ? '带时间戳 LRC' : '纯文本'}
                      </span>
                    </p>
                  </div>

                  <div
                    className="flex flex-wrap items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {showOriginalFallback && (
                      <button
                        type="button"
                        onClick={() => handleApplyResult(item, raw, 'force_original')}
                        className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-medium text-white/85 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        仅应用原版
                      </button>
                    )}

                    {hasNativeTrans ? (
                      <>
                        <button
                          type="button"
                          disabled={translatingId !== null}
                          onClick={() => handleApplyResult(item, raw, 'auto')}
                          className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap shadow-sm"
                          style={{
                            background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                          }}
                        >
                          <Languages className="w-3.5 h-3.5 text-white" />
                          <span>应用自带双语</span>
                        </button>

                        {enableModelTranslation && (
                          <button
                            type="button"
                            disabled={translatingId !== null}
                            onClick={() => handleApplyResult(item, raw, 'force_model')}
                            className="px-2.5 py-1.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/10 text-xs text-rose-200/90 flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap"
                            title="不使用自带双语，使用当前 AI 模型重新诗意翻译"
                          >
                            <Sparkles className="w-3 h-3 text-rose-300" />
                            <span>模型重译</span>
                          </button>
                        )}
                      </>
                    ) : enableModelTranslation ? (
                      <>
                        <button
                          type="button"
                          disabled={translatingId !== null}
                          onClick={() => handleApplyResult(item, raw, 'force_model')}
                          className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap shadow-md"
                          style={{
                            background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                          }}
                        >
                          {isTranslating ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>{providerLabel} 翻译中...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                              <span>模型翻译 ({providerLabel})</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={translatingId !== null}
                          onClick={() => handleApplyResult(item, raw, 'force_original')}
                          className="px-3 py-1.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/10 text-xs text-white/75 transition-colors cursor-pointer whitespace-nowrap"
                          title="跳过 AI 翻译，直接应用原始单语歌词"
                        >
                          仅原版
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={translatingId !== null}
                          onClick={() => handleApplyResult(item, raw, 'force_original')}
                          className="px-3.5 py-1.5 rounded-xl bg-white/12 hover:bg-white/20 text-xs font-medium text-white flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>应用原版</span>
                        </button>

                        <button
                          type="button"
                          disabled={translatingId !== null}
                          onClick={() => handleApplyResult(item, raw, 'force_model')}
                          className="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/30 text-xs font-medium text-rose-200 flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                          title="使用当前 AI 模型翻译为双语歌词"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-rose-300" />
                          <span>模型翻译</span>
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setPreviewResultId(item.id);
                        setMobileViewMode('preview');
                      }}
                      className="ml-auto px-2.5 py-1.5 rounded-xl bg-white/6 hover:bg-white/12 text-[11px] text-white/75 cursor-pointer"
                    >
                      {isPreviewSelected ? '预览中' : '预览歌词'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Full Lyrics Preview Pane */}
          <div
            className={`lg:col-span-6 flex flex-col min-h-0 bg-black/25 ${
              mobileViewMode === 'preview' ? 'flex' : 'hidden lg:flex'
            }`}
          >
            {selectedPreviewItem && parsedPreview ? (
              <>
                <div className="px-5 py-3.5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2 shrink-0 bg-black/20">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">
                      {selectedPreviewItem.trackName} · {selectedPreviewItem.artistName}
                    </p>
                    <p className="text-[11px] text-white/55 mt-0.5 font-mono-tabular">
                      共 {parsedPreview.lines.length} 行 ·{' '}
                      {parsedPreview.hasSyncedTimestamps ? '同步 LRC 时间轴' : '纯文本歌词'}
                      {parsedPreview.hasWordTimestamps ? ' · 含逐字时间戳' : ''}
                      {selectedPreviewItem.hasNativeTranslation || parsedPreview.hasTranslations
                        ? ' · 已含双语译文'
                        : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={translatingId !== null}
                      onClick={() =>
                        handleApplyResult(
                          selectedPreviewItem,
                          selectedPreviewRaw,
                          selectedPreviewItem.hasNativeTranslation ? 'auto' : 'force_original'
                        )
                      }
                      className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/18 text-xs font-medium text-white cursor-pointer"
                    >
                      {selectedPreviewItem.hasNativeTranslation
                        ? '应用此双语歌词'
                        : '应用原版歌词'}
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto lumina-scroll p-5 space-y-2.5">
                  {parsedPreview.lines.map((line, idx) => (
                    <div
                      key={`${line.time}-${idx}`}
                      className="flex items-start gap-3 py-1 border-b border-white/[0.04] last:border-0"
                    >
                      <span className="text-[11px] font-mono-tabular text-white/40 shrink-0 pt-0.5 w-12">
                        {parsedPreview.hasSyncedTimestamps ? `[${formatSecTag(line.time)}]` : `${idx + 1}.`}
                      </span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm text-white/95 leading-relaxed break-words">
                          {line.text}
                        </p>
                        {line.translation && (
                          <p className="text-xs text-rose-200/80 leading-relaxed break-words">
                            {line.translation}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-white/45 space-y-2">
                <FileText className="w-8 h-8 opacity-40" />
                <p className="text-xs">
                  搜索后点击左侧任意结果，即可在此完整逐行预览歌词文本、时间戳与双语译文
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

