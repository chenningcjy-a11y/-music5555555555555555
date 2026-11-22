import React, { useMemo, useState } from 'react';
import { LyricLine } from '../../types/music';
import { findActiveLyricIndex, parseLrc } from '../../utils/lrcParser';

interface FullscreenThreeLineLyricsProps {
  lyricsRaw?: string;
  currentTime: number;
  offsetMs?: number;
}

type FlowDirection = 'forward' | 'backward' | 'none';

interface LyricSlotProps {
  line: LyricLine | null;
  role: 'prev' | 'current' | 'next';
  flowDirection: FlowDirection;
  staggerMs: number;
  introWaiting?: boolean;
}

const LyricSlot: React.FC<LyricSlotProps> = ({
  line,
  role,
  flowDirection,
  staggerMs,
  introWaiting,
}) => {
  if (!line) {
    return (
      <div
        aria-hidden={!introWaiting}
        className="min-h-[68px] sm:min-h-[76px] flex flex-col items-start justify-center"
      >
        {introWaiting && role === 'current' && (
          <span className="font-display text-xl tracking-[0.38em] text-white/35">
            ···
          </span>
        )}
      </div>
    );
  }

  const isCurrent = role === 'current';
  const flowAnimClass =
    flowDirection === 'forward'
      ? 'lumina-lyric-flow-forward'
      : flowDirection === 'backward'
      ? 'lumina-lyric-flow-backward'
      : '';

  return (
    <div
      className={`min-h-[68px] sm:min-h-[76px] flex flex-col justify-center transition-[opacity,transform] duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
        isCurrent
          ? 'opacity-100 scale-[1.02] translate-x-1.5 origin-left'
          : role === 'prev'
          ? 'opacity-35 scale-[0.96] translate-x-0 origin-left'
          : 'opacity-48 scale-[0.97] translate-x-0 origin-left'
      }`}
    >
      <div
        key={`${role}-${line.id}`}
        className={`flex flex-col justify-center ${flowAnimClass}`}
        style={
          flowDirection !== 'none' && staggerMs > 0
            ? { animationDelay: `${staggerMs}ms` }
            : undefined
        }
      >
        <p
          className={`font-display leading-[1.35] tracking-[-0.01em] break-words transition-colors duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
            isCurrent
              ? 'text-2xl sm:text-[28px] lg:text-[34px] font-semibold text-white'
              : 'text-base sm:text-lg lg:text-xl font-normal text-white/80'
          }`}
          style={{
            textShadow: isCurrent
              ? '0 0 32px rgba(var(--fs-primary-rgb, 232, 67, 127), 0.65), 0 4px 18px rgba(0, 0, 0, 0.85)'
              : '0 2px 12px rgba(0, 0, 0, 0.8)',
          }}
        >
          {line.text}
        </p>

        {line.translation && (
          <p
            className={`mt-1.5 leading-relaxed break-words transition-colors duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isCurrent
                ? 'text-sm sm:text-base lg:text-lg font-normal text-rose-50/88'
                : 'text-xs sm:text-sm lg:text-[15px] font-light text-white/60'
            }`}
            style={{ textShadow: '0 2px 10px rgba(0, 0, 0, 0.8)' }}
          >
            {line.translation}
          </p>
        )}
      </div>
    </div>
  );
};

export const FullscreenThreeLineLyrics: React.FC<FullscreenThreeLineLyricsProps> = React.memo(({
  lyricsRaw,
  currentTime,
  offsetMs = 0,
}) => {
  const parsed = useMemo(() => parseLrc(lyricsRaw), [lyricsRaw]);

  const activeIdx = useMemo(() => {
    if (!parsed.lines.length) return -1;
    if (!parsed.hasSyncedTimestamps) return 0;
    return findActiveLyricIndex(parsed.lines, currentTime, offsetMs);
  }, [parsed.lines, parsed.hasSyncedTimestamps, currentTime, offsetMs]);

  const [flowState, setFlowState] = useState<{
    idx: number;
    raw: string | undefined;
    dir: FlowDirection;
  }>({
    idx: activeIdx,
    raw: lyricsRaw,
    dir: 'none',
  });

  if (flowState.raw !== lyricsRaw) {
    setFlowState({
      idx: activeIdx,
      raw: lyricsRaw,
      dir: 'none',
    });
  } else if (flowState.idx !== activeIdx) {
    setFlowState({
      idx: activeIdx,
      raw: lyricsRaw,
      dir:
        flowState.idx >= 0 && activeIdx < flowState.idx
          ? 'backward'
          : 'forward',
    });
  }

  if (parsed.lines.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-start md:justify-center">
        <p className="font-display text-lg sm:text-xl text-white/40 tracking-wide">
          暂无歌词
        </p>
      </div>
    );
  }

  const isIntroWaiting = parsed.hasSyncedTimestamps && activeIdx < 0;

  const prevLine: LyricLine | null =
    !isIntroWaiting && activeIdx > 0 ? parsed.lines[activeIdx - 1] : null;
  const currentLine: LyricLine | null =
    !isIntroWaiting && activeIdx >= 0 ? parsed.lines[activeIdx] : null;
  const nextLine: LyricLine | null = isIntroWaiting
    ? parsed.lines[0] || null
    : activeIdx + 1 < parsed.lines.length
    ? parsed.lines[activeIdx + 1]
    : null;

  const isBackward = flowState.dir === 'backward';

  return (
    <div
      className="w-full h-full flex flex-col justify-center select-none overflow-hidden"
      aria-live="polite"
    >
      <div className="w-full max-w-xl mx-auto flex flex-col justify-center gap-6 sm:gap-8">
        <LyricSlot
          line={prevLine}
          role="prev"
          flowDirection={flowState.dir}
          staggerMs={isBackward ? 90 : 0}
        />
        <LyricSlot
          line={currentLine}
          role="current"
          flowDirection={flowState.dir}
          staggerMs={45}
          introWaiting={isIntroWaiting}
        />
        <LyricSlot
          line={nextLine}
          role="next"
          flowDirection={flowState.dir}
          staggerMs={isBackward ? 0 : 90}
        />
      </div>
    </div>
  );
});
