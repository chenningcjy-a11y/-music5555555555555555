const LINE_TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function toSeconds(minStr, secStr, msStr) {
  const min = parseInt(minStr, 10) || 0;
  const sec = parseInt(secStr, 10) || 0;
  let ms = 0;
  if (msStr) {
    if (msStr.length === 1) ms = parseInt(msStr, 10) * 100;
    else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10;
    else ms = parseInt(msStr.slice(0, 3), 10);
  }
  return min * 60 + sec + ms / 1000;
}

function parseTimedEntries(lrc) {
  const entries = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^\[(ti|ar|al|by|offset|re|ve):/i.test(trimmed)) continue;

    const tags = [];
    let m;
    LINE_TIME_TAG_RE.lastIndex = 0;
    while ((m = LINE_TIME_TAG_RE.exec(trimmed)) !== null) {
      tags.push({ tag: m[0], sec: toSeconds(m[1], m[2], m[3]) });
    }
    if (tags.length === 0) continue;
    const text = trimmed.replace(LINE_TIME_TAG_RE, '').trim();
    if (!text) continue;

    for (const t of tags) {
      entries.push({ timeSec: t.sec, tag: t.tag, text });
    }
  }
  return entries.sort((a, b) => a.timeSec - b.timeSec);
}

function mergeOriginalAndTranslatedLrc(origLrc, transLrc) {
  const origEntries = parseTimedEntries(origLrc);
  const transEntries = parseTimedEntries(transLrc);
  if (origEntries.length === 0 || transEntries.length === 0) return origLrc;

  const lines = [];
  let transCursor = 0;

  for (const orig of origEntries) {
    lines.push(`${orig.tag}${orig.text}`);

    while (
      transCursor < transEntries.length &&
      transEntries[transCursor].timeSec < orig.timeSec - 0.35
    ) {
      transCursor++;
    }

    let bestMatch = null;
    let bestDiff = 0.35;
    for (let k = transCursor; k < transEntries.length; k++) {
      const cand = transEntries[k];
      const diff = Math.abs(cand.timeSec - orig.timeSec);
      if (diff <= bestDiff) {
        bestDiff = diff;
        bestMatch = cand;
      }
      if (cand.timeSec > orig.timeSec + 0.35) break;
    }

    if (bestMatch && bestMatch.text && bestMatch.text !== orig.text) {
      lines.push(`${orig.tag}${bestMatch.text}`);
    }
  }

  return lines.join('\n');
}

async function fetchLrclibResults(query, title, artist) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const urls = [];
    if (title && artist) {
      urls.push(
        `https://lrclib.net/api/search?track_name=${encodeURIComponent(
          title
        )}&artist_name=${encodeURIComponent(artist)}`
      );
    }
    urls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);

    const settled = await Promise.allSettled(
      urls.map(async (url) => {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'LUMINA-MUSIC/1.0',
          },
        });
        if (!res.ok) return [];
        return await res.json();
      })
    );

    const seen = new Set();
    const out = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled' || !Array.isArray(s.value)) continue;
      for (const item of s.value) {
        if (!item || seen.has(item.id)) continue;
        if (!item.syncedLyrics?.trim() && !item.plainLyrics?.trim()) continue;
        seen.add(item.id);
        out.push({
          ...item,
          hasNativeTranslation: false,
          source: 'LRCLIB',
        });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNeteaseResults(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(
      query
    )}&type=1&limit=4`;
    const searchRes = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!searchRes.ok) return [];
    const searchJson = await searchRes.json();
    const songs = searchJson?.result?.songs?.slice(0, 3) || [];
    if (songs.length === 0) return [];

    const lyricPromises = songs.map(async (song) => {
      try {
        const lrcUrl = `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&tv=1`;
        const lrcRes = await fetch(lrcUrl, {
          signal: controller.signal,
          headers: {
            Referer: 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0',
          },
        });
        if (!lrcRes.ok) return null;
        const lrcJson = await lrcRes.json();
        const orig = lrcJson?.lrc?.lyric?.trim();
        if (!orig) return null;
        const trans = lrcJson?.tlyric?.lyric?.trim();
        const hasTrans = Boolean(trans && parseTimedEntries(trans).length > 0);
        const merged = hasTrans && trans ? mergeOriginalAndTranslatedLrc(orig, trans) : orig;
        const isTimed = /\[\d{1,3}:\d{1,2}/.test(merged);

        return {
          id: 900000000 + song.id,
          trackName: song.name,
          artistName: song.artists?.map((a) => a.name).join(' / ') || '',
          albumName: song.album?.name || '',
          duration: Math.round((song.duration || 0) / 1000),
          syncedLyrics: isTimed ? merged : null,
          plainLyrics: isTimed ? null : merged,
          hasNativeTranslation: hasTrans,
          source: hasTrans ? '网易云双语' : '网易云',
        };
      } catch {
        return null;
      }
    });

    const resolved = await Promise.all(lyricPromises);
    return resolved.filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const title = (url.searchParams.get('title') || '').trim();
  const artist = (url.searchParams.get('artist') || '').trim();

  if (!q) {
    return new Response(JSON.stringify({ error: '缺少搜索关键词' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const [neteaseSettled, lrclibSettled] = await Promise.allSettled([
    fetchNeteaseResults(q),
    fetchLrclibResults(q, title || undefined, artist || undefined),
  ]);

  const neteaseList = neteaseSettled.status === 'fulfilled' ? neteaseSettled.value : [];
  const lrclibList = lrclibSettled.status === 'fulfilled' ? lrclibSettled.value : [];

  const combined = [...neteaseList, ...lrclibList].sort((a, b) => {
    if (a.hasNativeTranslation && !b.hasNativeTranslation) return -1;
    if (!a.hasNativeTranslation && b.hasNativeTranslation) return 1;
    if (a.syncedLyrics && !b.syncedLyrics) return -1;
    if (!a.syncedLyrics && b.syncedLyrics) return 1;
    return 0;
  });

  return new Response(JSON.stringify(combined), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
