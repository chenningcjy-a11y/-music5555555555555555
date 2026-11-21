import React, { useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  BookmarkPlus,
  Check,
  Download,
  Headphones,
  Info,
  Mic2,
  Power,
  RotateCcw,
  Save,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { audioEngine } from '../audio/AudioEngine';
import { StemSeparationPanel } from '../components/audio/StemSeparationPanel';
import { VocalBackgroundControl } from '../components/audio/VocalBackgroundControl';
import { useMusic } from '../context/MusicContext';
import {
  AUDIO_ONLY_BACKUP_OPTIONS,
  exportLuminaBackup,
  importLuminaBackupFiles,
} from '../services/backupService';
import { AudioDspSettings, EqPresetName, QualityMode } from '../types/music';
import {
  EQ_BANDS,
  EQ_PRESETS,
  formatBitrate,
  formatSampleRate,
} from '../utils/constants';

function areAudioSettingsEqual(a: AudioDspSettings, b: AudioDspSettings): boolean {
  return (
    a.masterEnabled === b.masterEnabled &&
    a.qualityMode === b.qualityMode &&
    a.surroundEnabled === b.surroundEnabled &&
    a.surroundWidth === b.surroundWidth &&
    a.surroundIntensity === b.surroundIntensity &&
    a.headphoneOptimize === b.headphoneOptimize &&
    a.eqPreset === b.eqPreset &&
    a.bassBoost === b.bassBoost &&
    a.trebleBoost === b.trebleBoost &&
    a.vocalEnhance === b.vocalEnhance &&
    a.reverbMix === b.reverbMix &&
    a.stereoWidth === b.stereoWidth &&
    a.loudnessNormalization === b.loudnessNormalization &&
    a.vocalAccompanimentBalance === b.vocalAccompanimentBalance &&
    a.stemModeActive === b.stemModeActive &&
    a.vocalGain === b.vocalGain &&
    a.instrumentalGain === b.instrumentalGain &&
    a.vocalMuted === b.vocalMuted &&
    a.instrumentalMuted === b.instrumentalMuted &&
    a.eqGains.every((val, idx) => val === b.eqGains[idx])
  );
}

const QUALITY_MODES: {
  id: QualityMode;
  label: string;
  desc: string;
}[] = [
  {
    id: 'original',
    label: '原始音质 (直通)',
    desc: '完全绕过 EQ 与音效处理链路，以源文件原生信号直出。',
  },
  {
    id: 'high',
    label: '高品质播放',
    desc: '启用 Web Audio 实时音效管线与防削波动态保护。',
  },
  {
    id: 'lossless',
    label: '无损音频播放',
    desc: '针对 FLAC / WAV 等无损源文件保持全频段动态与高精度混音。',
  },
  {
    id: 'auto',
    label: '自动匹配最佳音质',
    desc: '依据当前曲目编码与设备采样率自动匹配最优播放策略。',
  },
];

export const AudioDspPage: React.FC = () => {
  const {
    currentTrack,
    audioSettings,
    savedAudioPresets,
    activeAudioPresetId,
    activePalette,
    currentTrackStemMeta,
    updateAudioSettings,
    resetAudioSettings,
    saveNewAudioPreset,
    overwriteAudioPreset,
    applyAudioPreset,
    deleteAudioPreset,
    reloadAllLibraryData,
    showToast,
  } = useMusic();

  const [presetNameInput, setPresetNameInput] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const presetFileInputRef = useRef<HTMLInputElement | null>(null);

  const activeSavedPreset = useMemo(
    () => savedAudioPresets.find((p) => p.id === activeAudioPresetId) || null,
    [savedAudioPresets, activeAudioPresetId]
  );

  const hasUnsavedPresetTweaks = useMemo(() => {
    if (!activeSavedPreset) return false;
    return !areAudioSettingsEqual(audioSettings, activeSavedPreset.settings);
  }, [activeSavedPreset, audioSettings]);

  const handleSaveAsNewPreset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (presetBusy) return;
    setPresetBusy(true);
    try {
      await saveNewAudioPreset(presetNameInput);
      setPresetNameInput('');
    } finally {
      setPresetBusy(false);
    }
  };

  const handleExportAudioPresets = async () => {
    if (presetBusy) return;
    setPresetBusy(true);
    try {
      const res = await exportLuminaBackup(AUDIO_ONLY_BACKUP_OPTIONS, {
        mode: 'single-blob',
      });
      const vol = res.volumes[0];
      if (!vol?.blob) {
        throw new Error('生成音效预设文件失败');
      }
      const url = URL.createObjectURL(vol.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = vol.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast(
        `已下载音效与预设文件（含当前调音及 ${savedAudioPresets.length} 套已保存预设）`
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出音效预设失败');
    } finally {
      setPresetBusy(false);
    }
  };

  const handleImportAudioPresets = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPresetBusy(true);
    try {
      const summary = await importLuminaBackupFiles(
        [file],
        AUDIO_ONLY_BACKUP_OPTIONS,
        'merge'
      );
      await reloadAllLibraryData();
      if (summary.audioPresetsRestored > 0 || summary.audioSettingsRestored) {
        showToast(
          `已自动导入并保存${
            summary.audioPresetsRestored > 0
              ? ` ${summary.audioPresetsRestored} 套音效预设与当前音效配置`
              : '音效设置'
          }`
        );
      } else {
        showToast('该文件中未包含音质音效预设配置');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入音效预设文件失败');
    } finally {
      setPresetBusy(false);
    }
  };

  const presetNames = Object.keys(EQ_PRESETS) as Exclude<EqPresetName, '自定义'>[];
  const isBypassed = !audioSettings.masterEnabled || audioSettings.qualityMode === 'original';

  const handlePresetClick = (preset: Exclude<EqPresetName, '自定义'>) => {
    updateAudioSettings({
      eqPreset: preset,
      eqGains: [...EQ_PRESETS[preset]],
    });
  };

  const handleEqBandChange = (index: number, gainDb: number) => {
    const next = [...audioSettings.eqGains] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    next[index] = gainDb;
    updateAudioSettings({
      eqPreset: '自定义',
      eqGains: next,
    });
  };

  // Build smooth SVG EQ frequency response curve preview
  const eqCurvePoints = audioSettings.eqGains
    .map((gain, i) => {
      const x = (i / (EQ_BANDS.length - 1)) * 100;
      const y = 50 - (gain / 12) * 38;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="min-h-full px-4 sm:px-6 lg:px-10 py-6 pb-24 md:pb-12 space-y-6">
      <input
        ref={presetFileInputRef}
        type="file"
        accept=".json,.lumina"
        className="hidden"
        onChange={handleImportAudioPresets}
      />

      {/* Header + Master DSP Switch */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-white">
            音质与音效引擎
          </h1>
          <p className="text-sm text-white/60 mt-1">
            基于 Web Audio API 实时信号链：7 段参数均衡器、立体声 M/S 3D 环绕、卷积混响与防削波限幅器
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={resetAudioSettings}
            className="px-4 py-2.5 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-xs font-medium text-white/85 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            恢复默认
          </button>

          <button
            type="button"
            onClick={() =>
              updateAudioSettings({ masterEnabled: !audioSettings.masterEnabled })
            }
            className={`px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
              audioSettings.masterEnabled
                ? 'text-white shadow-lg'
                : 'bg-white/10 text-white/60 border border-white/12'
            }`}
            style={
              audioSettings.masterEnabled
                ? {
                    background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
                  }
                : undefined
            }
          >
            <Power className="w-4 h-4" />
            {audioSettings.masterEnabled ? '音效总开关：开启' : '音效总开关：关闭'}
          </button>
        </div>
      </div>

      {/* Section 0: Saved & Switchable Audio Preset Profiles */}
      <section className="rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <BookmarkPlus className="w-5 h-5 shrink-0 mt-0.5" style={{ color: activePalette.primary }} />
            <div>
              <h2 className="text-base font-semibold text-white">
                我的音效方案库（随时保存并一键切换）
              </h2>
              <p className="text-xs text-white/60 mt-0.5">
                {activeSavedPreset
                  ? `当前使用方案：「${activeSavedPreset.name}」${
                      hasUnsavedPresetTweaks ? '（已做新微调，可覆盖更新或另存为新方案）' : ' · 参数已同步'
                    }`
                  : '保存当前全部音质、7 段 EQ、3D 环绕与混响配置为方案，随时在多套音效间切换并随备份文件导出'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={presetBusy}
              onClick={handleExportAudioPresets}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/14 text-xs font-medium text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载音效预设文件</span>
            </button>
            <button
              type="button"
              disabled={presetBusy}
              onClick={() => presetFileInputRef.current?.click()}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/14 text-xs font-medium text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>导入预设</span>
            </button>
          </div>
        </div>

        {/* Save Current Audio Profile Form */}
        <form onSubmit={handleSaveAsNewPreset} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            value={presetNameInput}
            onChange={(e) => setPresetNameInput(e.target.value)}
            placeholder="为当前音效命名（如：深夜人声、演唱会3D环绕、动感重低音）"
            className="flex-1 min-w-0 px-4 py-2.5 rounded-xl bg-black/30 border border-white/14 text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/35"
          />
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {activeSavedPreset && hasUnsavedPresetTweaks && (
              <button
                type="button"
                disabled={presetBusy}
                onClick={() => overwriteAudioPreset(activeSavedPreset.id)}
                className="px-4 py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-xs font-semibold text-amber-100 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>更新覆盖「{activeSavedPreset.name}」</span>
              </button>
            )}
            <button
              type="submit"
              disabled={presetBusy}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 shadow-lg transition-transform active:scale-95 cursor-pointer disabled:opacity-50"
              style={{
                background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
              }}
            >
              <BookmarkPlus className="w-3.5 h-3.5" />
              <span>保存为新音效</span>
            </button>
          </div>
        </form>

        {/* Saved Presets Switcher Grid */}
        {savedAudioPresets.length === 0 ? (
          <div className="rounded-2xl bg-black/25 border border-white/8 px-4 py-3 text-xs text-white/55">
            暂无已保存的音效方案。调整下方参数后点击「保存为新音效」，即可在不同风格方案之间快速切换；同时导出完整备份或配置包时也会自动打包全部方案。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {savedAudioPresets.map((preset) => {
              const isActive = activeAudioPresetId === preset.id;
              const s = preset.settings;
              return (
                <div
                  key={preset.id}
                  className={`rounded-2xl border p-3.5 flex flex-col justify-between gap-3 transition-all ${
                    isActive
                      ? 'bg-white/[0.11] border-white/35 shadow-lg'
                      : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{
                            backgroundColor: isActive
                              ? activePalette.primary
                              : 'rgba(255,255,255,0.22)',
                          }}
                        />
                        <h3 className="text-sm font-semibold text-white truncate">
                          {preset.name}
                        </h3>
                      </div>
                      <p className="text-[11px] text-white/60 mt-1 leading-relaxed">
                        {s.masterEnabled
                          ? s.qualityMode === 'original'
                            ? '原声直通'
                            : `${s.eqPreset} EQ`
                          : '总开关关闭'}
                        {' · '}低音 +{s.bassBoost}dB · 高音 +{s.trebleBoost}dB
                        {s.vocalEnhance > 0 ? ` · 人声 +${s.vocalEnhance}dB` : ''}
                        {s.surroundEnabled ? ` · 3D环绕 ${s.surroundIntensity}%` : ''}
                        {s.reverbMix > 0 ? ` · 混响 ${s.reverbMix}%` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/10">
                    <button
                      type="button"
                      onClick={() => applyAudioPreset(preset.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'bg-white/10 hover:bg-white/20 text-white/90'
                      }`}
                    >
                      {isActive ? (
                        <>
                          <Check className="w-3.5 h-3.5" style={{ color: activePalette.primary }} />
                          <span>使用中</span>
                        </>
                      ) : (
                        <span>切换到此音效</span>
                      )}
                    </button>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => overwriteAudioPreset(preset.id)}
                        title="用当前音效参数覆盖此方案"
                        className="px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/16 text-[11px] text-white/80 cursor-pointer flex items-center gap-1"
                      >
                        <Save className="w-3 h-3" />
                        <span>覆盖</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteAudioPreset(preset.id)}
                        title="删除此音效方案"
                        className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-200 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 1: Quality Mode & Honest Source Diagnostics */}
      <section className="rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 sm:p-6 space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <AudioLines className="w-5 h-5" style={{ color: activePalette.primary }} />
            <h2 className="text-base font-semibold text-white">音质设置与源文件检测</h2>
          </div>

          {currentTrack && (
            <div className="flex flex-wrap items-center gap-4 text-xs font-mono-tabular text-white/75">
              <span>格式：{currentTrack.format}</span>
              <span>采样率：{formatSampleRate(currentTrack.sampleRate)}</span>
              <span>
                位深：
                {currentTrack.bitsPerSample ? `${currentTrack.bitsPerSample}-bit` : '未标明'}
              </span>
              <span>码率：{formatBitrate(currentTrack.bitrate)}</span>
              <span>输出引擎：{(audioEngine.sampleRate / 1000).toFixed(1)} kHz</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {QUALITY_MODES.map((m) => {
            const active = audioSettings.qualityMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => updateAudioSettings({ qualityMode: m.id })}
                className={`p-4 rounded-2xl border text-left transition-all cursor-pointer ${
                  active
                    ? 'bg-white/[0.12] border-white/30'
                    : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white">{m.label}</span>
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: active
                        ? activePalette.primary
                        : 'rgba(255,255,255,0.18)',
                    }}
                  />
                </div>
                <p className="text-xs text-white/55 mt-1.5 leading-relaxed">{m.desc}</p>
              </button>
            );
          })}
        </div>

        <div className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-black/30 border border-white/8 text-xs text-white/65 leading-relaxed">
          <Info className="w-4 h-4 text-white/60 shrink-0 mt-0.5" />
          <p>
            音质说明：播放器的音质模式负责音频管线调度与失真保护，无法将有损压缩文件（如 MP3 / AAC）凭空还原为真正无损音频；只有导入 FLAC / WAV 等无损格式时才具备原始无损信息。
            {audioSettings.qualityMode === 'original' &&
              ' 当前处于「原始音质直通」，以下 DSP 音效将自动旁路。'}
          </p>
        </div>
      </section>

      {/* Section 1.5: Real AI Stem Separation & Independent Vocal / Instrumental Control */}
      <StemSeparationPanel />

      {/* Section 1.6: Quick Stereo M/S Balance (when AI stems are not active) */}
      <section
        className={`rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 sm:p-6 space-y-4 transition-opacity ${
          isBypassed || (audioSettings.stemModeActive && currentTrackStemMeta)
            ? 'opacity-50 pointer-events-none'
            : 'opacity-100'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <Mic2 className="w-5 h-5" style={{ color: activePalette.primary }} />
            <div>
              <h2 className="text-base font-semibold text-white">
                免分离立体声快捷平衡 (Mid/Side 矩阵)
              </h2>
              <p className="text-xs text-white/55">
                {audioSettings.stemModeActive && currentTrackStemMeta
                  ? '当前已启用上方「AI 分离双轨混音」，本快捷矩阵已自动让位'
                  : '未运行 AI 分离时，可通过 M/S 声道矩阵快速微调中央人声与侧声部伴奏比例'}
              </p>
            </div>
          </div>
        </div>

        <VocalBackgroundControl
          balance={audioSettings.vocalAccompanimentBalance}
          palette={activePalette}
          onChange={(val) => updateAudioSettings({ vocalAccompanimentBalance: val })}
        />
      </section>

      {/* Section 2: 3D Spatial Surround + Additional Effects */}
      <div
        className={`grid grid-cols-1 lg:grid-cols-12 gap-6 transition-opacity ${
          isBypassed ? 'opacity-55 pointer-events-none' : 'opacity-100'
        }`}
      >
        {/* 3D Surround Card */}
        <section className="lg:col-span-6 rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 sm:p-6 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Headphones className="w-5 h-5" style={{ color: activePalette.primary }} />
              <div>
                <h2 className="text-base font-semibold text-white">3D 环绕音效</h2>
                <p className="text-xs text-white/55">
                  Mid/Side 立体声矩阵扩展 + 哈斯微延迟与耳机互馈优化
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                updateAudioSettings({ surroundEnabled: !audioSettings.surroundEnabled })
              }
              className={`px-4 py-1.5 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                audioSettings.surroundEnabled
                  ? 'text-white'
                  : 'bg-white/10 text-white/60'
              }`}
              style={
                audioSettings.surroundEnabled
                  ? { backgroundColor: activePalette.primary }
                  : undefined
              }
            >
              {audioSettings.surroundEnabled ? '已开启' : '已关闭'}
            </button>
          </div>

          <div
            className={`space-y-4 transition-opacity ${
              audioSettings.surroundEnabled ? 'opacity-100' : 'opacity-45 pointer-events-none'
            }`}
          >
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-white/80">空间声场宽度</span>
                <span className="font-mono-tabular text-white/75">
                  {audioSettings.surroundWidth}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={audioSettings.surroundWidth}
                onChange={(e) =>
                  updateAudioSettings({ surroundWidth: Number(e.target.value) })
                }
                className="lumina-range w-full"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-white/80">环绕沉浸强度</span>
                <span className="font-mono-tabular text-white/75">
                  {audioSettings.surroundIntensity}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={audioSettings.surroundIntensity}
                onChange={(e) =>
                  updateAudioSettings({ surroundIntensity: Number(e.target.value) })
                }
                className="lumina-range w-full"
              />
            </div>

            <label className="flex items-center justify-between p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 cursor-pointer">
              <div>
                <span className="text-xs font-medium text-white block">
                  耳机聆听优化 (自然互馈 Crossfeed)
                </span>
                <span className="text-[11px] text-white/50 block mt-0.5">
                  模拟双耳自然声学交叉，缓解耳机长时间极端立体声疲劳
                </span>
              </div>
              <input
                type="checkbox"
                checked={audioSettings.headphoneOptimize}
                onChange={(e) =>
                  updateAudioSettings({ headphoneOptimize: e.target.checked })
                }
                className="accent-rose-500 w-4 h-4 shrink-0"
              />
            </label>
          </div>

          <p className="text-[11px] text-white/45 leading-relaxed">
            技术说明：浏览器 Web Audio 输出为双声道立体声。本功能通过真实 M/S 侧音增益矩阵、1.4ms 微延迟及 720Hz 低通互馈提升空间感，非硬件多声道 Dolby Atmos 解码。
          </p>
        </section>

        {/* Additional DSP Effects */}
        <section className="lg:col-span-6 rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5" style={{ color: activePalette.secondary }} />
            <h2 className="text-base font-semibold text-white">空间与音色增强</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-3.5 rounded-2xl bg-white/[0.035] border border-white/8">
              <div className="flex justify-between text-xs mb-2">
                <span className="text-white/85">低音增强 (85Hz)</span>
                <span className="font-mono-tabular text-white/75">
                  +{audioSettings.bassBoost} dB
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={12}
                step={0.5}
                value={audioSettings.bassBoost}
                onChange={(e) =>
                  updateAudioSettings({ bassBoost: Number(e.target.value) })
                }
                className="lumina-range w-full"
              />
            </div>

            <div className="p-3.5 rounded-2xl bg-white/[0.035] border border-white/8">
              <div className="flex justify-between text-xs mb-2">
                <span className="text-white/85">高音增强 (8.2kHz)</span>
                <span className="font-mono-tabular text-white/75">
                  +{audioSettings.trebleBoost} dB
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={12}
                step={0.5}
                value={audioSettings.trebleBoost}
                onChange={(e) =>
                  updateAudioSettings({ trebleBoost: Number(e.target.value) })
                }
                className="lumina-range w-full"
              />
            </div>

            <div className="p-3.5 rounded-2xl bg-white/[0.035] border border-white/8">
              <div className="flex justify-between text-xs mb-2">
                <span className="text-white/85">人声清晰度 (2.8kHz)</span>
                <span className="font-mono-tabular text-white/75">
                  +{audioSettings.vocalEnhance} dB
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={0.5}
                value={audioSettings.vocalEnhance}
                onChange={(e) =>
                  updateAudioSettings({ vocalEnhance: Number(e.target.value) })
                }
                className="lumina-range w-full"
              />
            </div>

            <div className="p-3.5 rounded-2xl bg-white/[0.035] border border-white/8">
              <div className="flex justify-between text-xs mb-2">
                <span className="text-white/85">厅堂混响 (Reverb)</span>
                <span className="font-mono-tabular text-white/75">
                  {audioSettings.reverbMix}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={audioSettings.reverbMix}
                onChange={(e) =>
                  updateAudioSettings({ reverbMix: Number(e.target.value) })
                }
                className="lumina-range w-full"
              />
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/[0.035] border border-white/8">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-white/85">基础声场宽度 (M/S 平衡)</span>
              <span className="font-mono-tabular text-white/75">
                {audioSettings.stereoWidth}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={audioSettings.stereoWidth}
              onChange={(e) =>
                updateAudioSettings({ stereoWidth: Number(e.target.value) })
              }
              className="lumina-range w-full"
            />
          </div>

          <label className="flex items-center justify-between p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 cursor-pointer">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-300 shrink-0" />
              <div>
                <span className="text-xs font-medium text-white block">
                  音量标准化与防削波限幅保护
                </span>
                <span className="text-[11px] text-white/50 block">
                  通过动态压缩器实时抑制多频段叠加导致的数字破音
                </span>
              </div>
            </div>
            <input
              type="checkbox"
              checked={audioSettings.loudnessNormalization}
              onChange={(e) =>
                updateAudioSettings({ loudnessNormalization: e.target.checked })
              }
              className="accent-rose-500 w-4 h-4 shrink-0"
            />
          </label>
        </section>
      </div>

      {/* Section 3: 7-Band Interactive Equalizer */}
      <section
        className={`rounded-3xl bg-white/[0.045] backdrop-blur-xl border border-white/10 p-5 sm:p-6 space-y-5 transition-opacity ${
          isBypassed ? 'opacity-55 pointer-events-none' : 'opacity-100'
        }`}
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5" style={{ color: activePalette.primary }} />
            <div>
              <h2 className="text-base font-semibold text-white">7 段图形均衡器 (BiquadFilter EQ)</h2>
              <p className="text-xs text-white/55">
                实时调节各频段增益 (-12 dB 至 +12 dB)
              </p>
            </div>
          </div>

          {/* Preset Selector */}
          <div className="flex flex-wrap items-center gap-1.5">
            {presetNames.map((preset) => {
              const active = audioSettings.eqPreset === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handlePresetClick(preset)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'text-white shadow-md'
                      : 'bg-white/[0.06] text-white/70 hover:text-white hover:bg-white/[0.12]'
                  }`}
                  style={
                    active
                      ? {
                          background: `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.secondary})`,
                        }
                      : undefined
                  }
                >
                  {preset}
                </button>
              );
            })}
            <span
              className={`px-3 py-1.5 rounded-xl text-xs font-medium ${
                audioSettings.eqPreset === '自定义'
                  ? 'bg-white/18 text-white'
                  : 'text-white/40'
              }`}
            >
              自定义
            </span>
          </div>
        </div>

        {/* Visual Frequency Curve */}
        <div className="h-20 w-full rounded-2xl bg-black/30 border border-white/8 px-4 py-2 relative overflow-hidden">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
            <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(255,255,255,0.12)" strokeDasharray="2 2" />
            <polyline
              fill="none"
              stroke={activePalette.primary}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={eqCurvePoints}
            />
          </svg>
        </div>

        {/* 7 Vertical EQ Sliders */}
        <div className="grid grid-cols-7 gap-2 sm:gap-4 pt-2">
          {EQ_BANDS.map((band, idx) => {
            const gain = audioSettings.eqGains[idx];
            return (
              <div key={band.freq} className="flex flex-col items-center gap-2.5">
                <span className="text-[11px] sm:text-xs font-mono-tabular text-white/80">
                  {gain > 0 ? `+${gain}` : gain} dB
                </span>

                <div className="h-40 sm:h-48 flex items-center justify-center relative w-full">
                  <div className="w-1.5 h-full rounded-full bg-white/10 relative overflow-hidden pointer-events-none">
                    <div
                      className="absolute left-0 right-0 rounded-full"
                      style={{
                        backgroundColor: activePalette.primary,
                        top: gain >= 0 ? `${50 - (gain / 12) * 50}%` : '50%',
                        bottom: gain < 0 ? `${50 - (Math.abs(gain) / 12) * 50}%` : '50%',
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={gain}
                    onChange={(e) => handleEqBandChange(idx, Number(e.target.value))}
                    aria-label={`${band.label} 增益`}
                    className="lumina-range-vertical absolute inset-0 w-10 h-full mx-auto opacity-85 cursor-pointer"
                  />
                </div>

                <span className="text-[11px] sm:text-xs font-mono-tabular text-white/60">
                  {band.label}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
