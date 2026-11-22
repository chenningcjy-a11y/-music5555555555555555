import { FontPresetId, TrackMetadata, TrackMvMeta } from '../types/music';

export interface StandalonePlayerHtmlOptions {
  track: TrackMetadata;
  audioRelPath: string;
  mvRelPath?: string;
  mvMeta?: TrackMvMeta | null;
  coverRelPath?: string;
  lyricsRelPath?: string;
  videoRelPath?: string;
  fontPreset?: FontPresetId;
  showBilingual?: boolean;
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonEmbed(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function getFontStackCss(fontPreset?: FontPresetId): string {
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

/**
 * Generates a self-contained offline HTML5 music player matching Lumina Music's
 * fullscreen stage: stationary rounded-square cover, title + composer/artist only,
 * unboxed 3-line flowing synced lyrics using the active webpage font preset,
 * and automatic sibling-file / folder-picker binding for audio & MV.
 */
export function buildStandalonePlayerHtml(opts: StandalonePlayerHtmlOptions): string {
  const {
    track,
    audioRelPath,
    mvRelPath,
    mvMeta,
    coverRelPath,
    lyricsRelPath,
    videoRelPath,
    fontPreset = 'modern',
    showBilingual = true,
  } = opts;

  const fontStack = getFontStackCss(fontPreset);
  const composerDisplay = (track.composer || '').trim() || track.artist || '';

  const payload = {
    title: track.title,
    composerDisplay,
    palette: track.palette,
    coverDataUrl: track.coverDataUrl || '',
    lyricsRaw: track.lyricsRaw || '',
    lyricsOffsetMs: track.lyricsOffsetMs || 0,
    showBilingual,
    audioRelPath,
    mvRelPath: mvRelPath || '',
    coverRelPath: coverRelPath || '',
    lyricsRelPath: lyricsRelPath || '',
    videoRelPath: videoRelPath || '',
    mvTimeline: mvMeta?.timeline || null,
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(track.title)}${composerDisplay ? ' - ' + escapeHtml(composerDisplay) : ''} · 离线全屏播放器</title>
  <style>
    :root {
      --primary: ${track.palette.primary};
      --secondary: ${track.palette.secondary};
      --deep: ${track.palette.deep || '#080407'};
      --p-rgb: ${track.palette.rgbPrimary.join(', ')};
      --s-rgb: ${track.palette.rgbSecondary.join(', ')};
      --font-stage: ${fontStack};
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: #000;
      color: #faf5f7;
      font-family: var(--font-stage);
      -webkit-font-smoothing: antialiased;
    }
    .bg-stage {
      position: fixed; inset: 0; z-index: 0; overflow: hidden;
      background:
        radial-gradient(circle at 24% 28%, rgba(var(--p-rgb), 0.22) 0%, transparent 56%),
        radial-gradient(circle at 78% 74%, rgba(var(--s-rgb), 0.18) 0%, transparent 58%),
        linear-gradient(145deg, #050204 0%, var(--deep) 54%, #040206 100%);
    }
    #mvVideo {
      position: fixed; inset: 0; width: 100%; height: 100%;
      object-fit: cover; z-index: 1; opacity: 0;
      transition: opacity 0.45s ease;
      pointer-events: none;
    }
    .scrim {
      position: fixed; inset: 0; z-index: 2; pointer-events: none;
      background: radial-gradient(ellipse 94% 90% at 50% 48%, rgba(0,0,0,0.06) 35%, rgba(0,0,0,0.42) 100%);
    }
    .shell {
      position: relative; z-index: 10; height: 100%; width: 100%;
      max-width: 1280px; margin: 0 auto;
      display: grid; grid-template-columns: 1fr 1fr; gap: 48px;
      align-items: center; padding: 36px 48px;
    }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; padding: 24px 20px 64px; gap: 24px; overflow-y: auto; }
    }
    .left-col {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-width: 0;
    }
    .cover-square {
      width: min(320px, 64vw, 42vh); aspect-ratio: 1 / 1;
      border-radius: 26px; overflow: hidden;
      background: #14070e;
      box-shadow: 0 28px 75px rgba(0, 0, 0, 0.78);
      flex-shrink: 0;
    }
    .cover-square img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .track-meta {
      text-align: center; max-width: 400px; width: 100%; margin-top: 20px;
    }
    .track-title {
      font-size: clamp(20px, 2.2vw, 24px); font-weight: 600; color: #fff; line-height: 1.3;
      text-shadow: 0 2px 12px rgba(0,0,0,0.85);
    }
    .track-composer {
      font-size: 14px; font-weight: 400; color: rgba(255,255,255,0.78); margin-top: 6px;
      text-shadow: 0 2px 10px rgba(0,0,0,0.8);
    }
    .controls-deck {
      width: 100%; max-width: 390px; margin-top: 44px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .range-wrap { position: relative; width: 100%; display: flex; align-items: center; }
    input[type="range"] {
      -webkit-appearance: none; appearance: none; width: 100%; height: 22px;
      background: transparent; cursor: pointer;
    }
    input[type="range"]::-webkit-slider-runnable-track {
      height: 5px; border-radius: 9999px; background: rgba(255,255,255,0.2);
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 16px; height: 16px; border-radius: 9999px;
      background: #fff; margin-top: -5.5px;
      box-shadow: 0 0 12px rgba(var(--p-rgb), 0.85);
    }
    input[type="range"]::-moz-range-track {
      height: 5px; border-radius: 9999px; background: rgba(255,255,255,0.2);
    }
    input[type="range"]::-moz-range-thumb {
      width: 16px; height: 16px; border: none; border-radius: 9999px;
      background: #fff; box-shadow: 0 0 12px rgba(var(--p-rgb), 0.85);
    }
    .time-row {
      display: flex; justify-content: space-between; font-size: 11px; color: rgba(255,255,255,0.58);
      margin-top: 2px; font-family: "JetBrains Mono", ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
    }
    .transport-row {
      display: flex; align-items: center; justify-content: center; gap: 48px; margin-top: 8px;
    }
    .icon-btn {
      width: 40px; height: 40px; border-radius: 9999px; border: none;
      background: transparent; color: rgba(255,255,255,0.85);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: transform 0.15s ease, color 0.15s ease;
    }
    .icon-btn:hover { color: #fff; transform: scale(1.08); }
    .play-icon-btn { width: 48px; height: 48px; color: #fff; }

    /* Right column: unboxed 3-line floating synced lyrics */
    .lyrics-stage {
      width: 100%; max-width: 560px; height: 100%;
      display: flex; flex-direction: column; justify-content: center; gap: 28px;
      user-select: none; -webkit-user-select: none; overflow: hidden;
    }
    .lyric-slot {
      min-height: 72px; display: flex; flex-direction: column; justify-content: center;
      text-align: left; background: transparent; border: none; padding: 0;
      cursor: pointer; transform-origin: left center;
      transition: opacity 0.56s cubic-bezier(0.22,1,0.36,1), transform 0.56s cubic-bezier(0.22,1,0.36,1);
    }
    .lyric-slot.prev { opacity: 0.35; transform: scale(0.96); }
    .lyric-slot.current { opacity: 1; transform: translateX(6px) scale(1.02); cursor: default; }
    .lyric-slot.next { opacity: 0.48; transform: scale(0.97); }
    .lyric-slot-inner {
      display: flex; flex-direction: column; justify-content: center;
    }
    @keyframes flowForward {
      0% { opacity: 0.08; transform: translate3d(0, 24px, 0) scale(0.968); }
      65% { opacity: 0.96; transform: translate3d(0, -1.5px, 0) scale(1.003); }
      100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }
    @keyframes flowBackward {
      0% { opacity: 0.08; transform: translate3d(0, -24px, 0) scale(0.968); }
      65% { opacity: 0.96; transform: translate3d(0, 1.5px, 0) scale(1.003); }
      100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }
    .anim-fwd { animation: flowForward 0.54s cubic-bezier(0.22,1,0.36,1) both; }
    .anim-bwd { animation: flowBackward 0.54s cubic-bezier(0.22,1,0.36,1) both; }

    .lyric-main {
      font-family: var(--font-stage);
      font-size: clamp(17px, 1.8vw, 20px);
      font-weight: 400; line-height: 1.35; letter-spacing: -0.01em;
      color: rgba(255,255,255,0.8);
      text-shadow: 0 2px 12px rgba(0,0,0,0.82);
    }
    .lyric-slot.current .lyric-main {
      font-size: clamp(24px, 2.7vw, 34px);
      font-weight: 600; color: #fff;
      text-shadow: 0 0 32px rgba(var(--p-rgb), 0.68), 0 4px 18px rgba(0,0,0,0.88);
    }
    .lyric-trans {
      font-family: var(--font-stage);
      font-size: clamp(13px, 1.25vw, 15px);
      font-weight: 300; line-height: 1.5; margin-top: 6px;
      color: rgba(255,255,255,0.6);
      text-shadow: 0 2px 10px rgba(0,0,0,0.82);
    }
    .lyric-slot.current .lyric-trans {
      font-size: clamp(15px, 1.5vw, 18px);
      font-weight: 400; color: rgba(255, 241, 245, 0.88);
    }

    /* Subtle floating corner utilities (hidden unless hovered or local folder needed) */
    .corner-tools {
      position: fixed; right: 18px; bottom: 16px; z-index: 20;
      display: flex; align-items: center; gap: 8px;
      opacity: 0.16; transition: opacity 0.25s ease;
    }
    .corner-tools:hover, .corner-tools.visible { opacity: 1; }
    .chip-btn {
      padding: 6px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16);
      background: rgba(14,8,12,0.72); backdrop-filter: blur(12px);
      color: rgba(255,255,255,0.88); font-size: 11px; cursor: pointer;
    }
    .chip-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }
  </style>
</head>
<body>
  <div class="bg-stage"></div>
  <video id="mvVideo" playsinline preload="auto"></video>
  <div class="scrim"></div>

  <main class="shell">
    <section class="left-col">
      <div class="cover-square">
        <img id="coverImg" alt="${escapeHtml(track.title)}" />
      </div>

      <div class="track-meta">
        <h1 class="track-title" id="trackTitle"></h1>
        <p class="track-composer" id="trackComposer"></p>
      </div>

      <div class="controls-deck">
        <div class="range-wrap">
          <input id="seekBar" type="range" min="0" max="100" step="0.1" value="0" />
        </div>
        <div class="time-row">
          <span id="curTime">00:00</span>
          <span id="durTime">00:00</span>
        </div>

        <div class="transport-row">
          <button class="icon-btn" id="prevLineBtn" type="button" title="上一句歌词 / 重播">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="5" width="2.4" height="14" rx="1"></rect>
              <polygon points="19,5 8,12 19,19"></polygon>
            </svg>
          </button>
          <button class="icon-btn play-icon-btn" id="playBtn" type="button" title="播放 / 暂停">
            <svg id="playIconSvg" width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="7,4 20,12 7,20"></polygon>
            </svg>
          </button>
          <button class="icon-btn" id="nextLineBtn" type="button" title="下一句歌词">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,5 16,12 5,19"></polygon>
              <rect x="17.6" y="5" width="2.4" height="14" rx="1"></rect>
            </svg>
          </button>
        </div>
      </div>
    </section>

    <section class="lyrics-stage" aria-live="polite">
      <div class="lyric-slot prev" id="slotPrev"></div>
      <div class="lyric-slot current" id="slotCurrent"></div>
      <div class="lyric-slot next" id="slotNext"></div>
    </section>
  </main>

  <div class="corner-tools" id="cornerTools">
    <button class="chip-btn" id="mvToggleBtn" type="button" style="display:none;">MV 背景: 开</button>
    <button class="chip-btn" id="pickFilesBtn" type="button">载入同目录音视频</button>
    <input id="folderInput" type="file" webkitdirectory directory multiple style="display:none;" />
  </div>

  <audio id="audioEl" preload="auto"></audio>

  <script id="lumina-data" type="application/json">${safeJsonEmbed(payload)}</script>
  <script>
    (function () {
      var data = JSON.parse(document.getElementById('lumina-data').textContent);
      var audioEl = document.getElementById('audioEl');
      var mvVideo = document.getElementById('mvVideo');
      var playBtn = document.getElementById('playBtn');
      var playIconSvg = document.getElementById('playIconSvg');
      var prevLineBtn = document.getElementById('prevLineBtn');
      var nextLineBtn = document.getElementById('nextLineBtn');
      var mvToggleBtn = document.getElementById('mvToggleBtn');
      var pickFilesBtn = document.getElementById('pickFilesBtn');
      var folderInput = document.getElementById('folderInput');
      var cornerTools = document.getElementById('cornerTools');
      var seekBar = document.getElementById('seekBar');
      var curTimeEl = document.getElementById('curTime');
      var durTimeEl = document.getElementById('durTime');
      var coverImg = document.getElementById('coverImg');

      var slotPrev = document.getElementById('slotPrev');
      var slotCurrent = document.getElementById('slotCurrent');
      var slotNext = document.getElementById('slotNext');

      document.getElementById('trackTitle').textContent = data.title || 'LUMINA MUSIC';
      document.getElementById('trackComposer').textContent = data.composerDisplay || '';
      if (data.coverDataUrl) coverImg.src = data.coverDataUrl;
      else if (data.coverRelPath) coverImg.src = data.coverRelPath;

      var mvEnabled = Boolean(data.mvRelPath);
      if (mvEnabled) {
        mvToggleBtn.style.display = 'inline-block';
        mvVideo.src = data.mvRelPath;
        mvVideo.muted = true;
      }
      audioEl.src = data.audioRelPath;

      function setPlayIcon(playing) {
        playIconSvg.innerHTML = playing
          ? '<rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect>'
          : '<polygon points="7,4 20,12 7,20"></polygon>';
      }

      function fmt(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }

      function parseLrcLines(raw) {
        if (!raw) return [];
        var rows = raw.split(/\\r?\\n/);
        var parsed = [];
        var re = /\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]/g;
        for (var i = 0; i < rows.length; i++) {
          var line = rows[i].trim();
          if (!line || /^\\[(ti|ar|al|by|offset|re|ve):/i.test(line)) continue;
          re.lastIndex = 0;
          var matches = [];
          var m;
          while ((m = re.exec(line)) !== null) {
            var min = parseInt(m[1], 10) || 0;
            var sec = parseInt(m[2], 10) || 0;
            var ms = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) : 0;
            matches.push(min * 60 + sec + ms / 1000);
          }
          if (!matches.length) continue;
          var clean = line.replace(re, '').replace(/<\\d{1,3}:\\d{1,2}(?:[.:]\\d{1,3})?>/g, '').trim();
          if (!clean) continue;
          var parts = clean.split(/\\s+\\/\\/\\s+|\\s+\\|\\s+/);
          for (var j = 0; j < matches.length; j++) {
            parsed.push({ time: matches[j], text: parts[0], trans: parts[1] || '' });
          }
        }
        parsed.sort(function (a, b) { return a.time - b.time; });
        var merged = [];
        for (var k = 0; k < parsed.length; k++) {
          var cur = parsed[k];
          var prev = merged[merged.length - 1];
          if (prev && Math.abs(prev.time - cur.time) < 0.08 && !prev.trans && cur.text !== prev.text) {
            prev.trans = cur.text;
          } else {
            merged.push(cur);
          }
        }
        return merged;
      }

      var lines = parseLrcLines(data.lyricsRaw);
      var activeIdx = -2;
      var flowDir = 'none';

      function fillSlot(el, line, role, staggerMs, isIntroWait) {
        el.innerHTML = '';
        el.onclick = null;
        if (!line) {
          if (isIntroWait && role === 'current') {
            var dots = document.createElement('span');
            dots.style.cssText = 'font-size:22px;letter-spacing:0.38em;color:rgba(255,255,255,0.35);';
            dots.textContent = '···';
            el.appendChild(dots);
          }
          return;
        }
        var inner = document.createElement('div');
        inner.className = 'lyric-slot-inner' + (flowDir === 'forward' ? ' anim-fwd' : (flowDir === 'backward' ? ' anim-bwd' : ''));
        if (flowDir !== 'none' && staggerMs > 0) {
          inner.style.animationDelay = staggerMs + 'ms';
        }
        var mainEl = document.createElement('p');
        mainEl.className = 'lyric-main';
        mainEl.textContent = line.text;
        inner.appendChild(mainEl);

        if (data.showBilingual && line.trans) {
          var transEl = document.createElement('p');
          transEl.className = 'lyric-trans';
          transEl.textContent = line.trans;
          inner.appendChild(transEl);
        }
        el.appendChild(inner);

        if (role !== 'current') {
          el.onclick = function () {
            audioEl.currentTime = Math.max(0, line.time - (data.lyricsOffsetMs || 0) / 1000);
            if (audioEl.paused) audioEl.play().catch(function(){});
          };
        }
      }

      function renderThreeLines(nextIdx) {
        if (lines.length === 0) {
          slotPrev.innerHTML = '';
          slotCurrent.innerHTML = '<p style="font-size:20px;color:rgba(255,255,255,0.4);">暂无歌词</p>';
          slotNext.innerHTML = '';
          return;
        }
        var isIntroWait = nextIdx < 0;
        var prevLine = (!isIntroWait && nextIdx > 0) ? lines[nextIdx - 1] : null;
        var curLine = (!isIntroWait && nextIdx >= 0) ? lines[nextIdx] : null;
        var nextLine = isIntroWait ? (lines[0] || null) : (nextIdx + 1 < lines.length ? lines[nextIdx + 1] : null);
        var isBwd = flowDir === 'backward';

        fillSlot(slotPrev, prevLine, 'prev', isBwd ? 90 : 0, false);
        fillSlot(slotCurrent, curLine, 'current', 45, isIntroWait);
        fillSlot(slotNext, nextLine, 'next', isBwd ? 0 : 90, false);
      }

      renderThreeLines(-1);

      audioEl.onerror = function () {
        cornerTools.classList.add('visible');
      };
      pickFilesBtn.onclick = function () {
        folderInput.click();
      };
      folderInput.onchange = function (e) {
        var files = Array.from(e.target.files || []);
        var audioFile = files.find(function (f) { return /\\.(mp3|flac|wav|m4a|aac|ogg|opus)$/i.test(f.name); });
        var mvFile = files.find(function (f) {
          return (f.webkitRelativePath.indexOf('/MV/') >= 0 || /\\.(mp4|webm|mov)$/i.test(f.name)) &&
            f.name.indexOf('播放效果视频') < 0;
        });
        if (audioFile) {
          audioEl.src = URL.createObjectURL(audioFile);
          cornerTools.classList.remove('visible');
          audioEl.play().catch(function(){});
        }
        if (mvFile) {
          mvVideo.src = URL.createObjectURL(mvFile);
          mvEnabled = true;
          mvToggleBtn.style.display = 'inline-block';
          mvVideo.style.opacity = '0.55';
        }
      };

      mvToggleBtn.onclick = function () {
        mvEnabled = !mvEnabled;
        mvToggleBtn.textContent = mvEnabled ? 'MV 背景: 开' : 'MV 背景: 关';
        mvVideo.style.opacity = mvEnabled ? '0.55' : '0';
      };

      playBtn.onclick = function () {
        if (audioEl.paused) audioEl.play().catch(function () { cornerTools.classList.add('visible'); });
        else audioEl.pause();
      };

      prevLineBtn.onclick = function () {
        if (lines.length && activeIdx > 0) {
          audioEl.currentTime = Math.max(0, lines[activeIdx - 1].time - (data.lyricsOffsetMs || 0) / 1000);
        } else {
          audioEl.currentTime = 0;
        }
      };
      nextLineBtn.onclick = function () {
        if (lines.length && activeIdx + 1 < lines.length) {
          audioEl.currentTime = Math.max(0, lines[activeIdx + 1].time - (data.lyricsOffsetMs || 0) / 1000);
        }
      };

      audioEl.onplay = function () {
        setPlayIcon(true);
        if (mvEnabled && mvVideo.src) {
          mvVideo.style.opacity = '0.55';
          mvVideo.play().catch(function(){});
        }
      };
      audioEl.onpause = function () {
        setPlayIcon(false);
        if (!mvVideo.paused) mvVideo.pause();
      };
      seekBar.oninput = function () {
        audioEl.currentTime = parseFloat(seekBar.value) || 0;
      };

      function loop() {
        var cur = audioEl.currentTime || 0;
        var dur = audioEl.duration || 0;
        if (dur > 0) {
          seekBar.max = String(dur);
          seekBar.value = String(cur);
          curTimeEl.textContent = fmt(cur);
          durTimeEl.textContent = fmt(dur);
        }
        if (!audioEl.paused && mvEnabled && mvVideo.src && mvVideo.readyState >= 2) {
          var introOff = (data.mvTimeline && data.mvTimeline.introEnabled) ? (data.mvTimeline.introEndSec || 0) : 0;
          var targetMv = introOff + cur;
          if (Math.abs(mvVideo.currentTime - targetMv) > 0.35) {
            try { mvVideo.currentTime = targetMv; } catch (e) {}
          }
        }
        var eff = cur + (data.lyricsOffsetMs || 0) / 1000;
        var nextIdx = -1;
        for (var i = 0; i < lines.length; i++) {
          if (eff >= lines[i].time) nextIdx = i;
          else break;
        }
        if (nextIdx !== activeIdx) {
          if (activeIdx === -2) {
            flowDir = 'none';
          } else {
            flowDir = (activeIdx >= 0 && nextIdx < activeIdx) ? 'backward' : 'forward';
          }
          activeIdx = nextIdx;
          renderThreeLines(activeIdx);
        }
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    })();
  </script>
</body>
</html>`;
}
