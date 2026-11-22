const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 4500;
const DOWNLOAD_TIMEOUT_MS = 5000;

function isPrivateOrLocalHostname(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      host === '::1'
    ) {
      return true;
    }
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function downloadRemoteImageAsDataUrl(rawUrl) {
  if (isPrivateOrLocalHostname(rawUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      },
    });
    if (!res.ok) return null;
    if (res.url && isPrivateOrLocalHostname(res.url)) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/') && !ct.includes('octet-stream')) return null;
    const lenHeader = Number(res.headers.get('content-length') || '0');
    if (lenHeader > MAX_IMAGE_BYTES) return null;

    const ab = await res.arrayBuffer();
    if (ab.byteLength < 600 || ab.byteLength > MAX_IMAGE_BYTES) return null;

    const mime = ct.startsWith('image/') ? ct.split(';')[0].trim() : 'image/jpeg';
    const b64 = Buffer.from(ab).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMatch(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanArtistSearchTerm(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s*\((?:feat\.?|ft\.?|with)\s+[^)]+\)/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/gi, '')
    .trim();
}

async function fetchDeezerPortraits(name, signal) {
  try {
    const res = await fetch(
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`,
      { signal, headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const items = Array.isArray(json?.data) ? json.data : [];
    const target = normalizeMatch(name);
    items.sort((a, b) => {
      const ae = normalizeMatch(a?.name) === target ? 1 : 0;
      const be = normalizeMatch(b?.name) === target ? 1 : 0;
      return be - ae;
    });
    const out = [];
    for (const item of items) {
      const pic = item?.picture_big || item?.picture_medium;
      if (!pic || pic.includes('/artist//')) continue;
      out.push({ url: pic, source: 'Deezer 艺人库', label: item.name || name });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchNeteasePortraits(name, signal) {
  try {
    const res = await fetch(
      `https://music.163.com/api/search/get?s=${encodeURIComponent(
        name
      )}&type=100&limit=5`,
      {
        signal,
        headers: {
          Referer: 'https://music.163.com/',
          'User-Agent': 'Mozilla/5.0',
        },
      }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const items = json?.result?.artists || [];
    const out = [];
    for (const item of items) {
      const rawUrl = item?.picUrl || item?.img1v1Url;
      if (!rawUrl || rawUrl.includes('5639395138885805')) continue;
      const secureUrl = rawUrl.replace(/^http:\/\//i, 'https://');
      const sizedUrl = secureUrl.includes('?') ? secureUrl : `${secureUrl}?param=480y480`;
      out.push({ url: sizedUrl, source: '网易云歌手库', label: item.name || name });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchWikipediaPortraits(name, lang, signal) {
  try {
    const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      name
    )}&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=480&format=json&origin=*`;
    const res = await fetch(endpoint, {
      signal,
      headers: { 'User-Agent': 'LUMINA-MUSIC/1.0', Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const pages = Object.values(json?.query?.pages || {}).sort(
      (a, b) => (a.index ?? 99) - (b.index ?? 99)
    );
    const out = [];
    for (const page of pages) {
      const src = page?.thumbnail?.source;
      if (!src || src.endsWith('.svg')) continue;
      out.push({
        url: src,
        source: lang === 'zh' ? '维基百科中文' : 'Wikipedia',
        label: page.title || name,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchBingPortraitImages(query, signal) {
  try {
    const url = `https://www.bing.com/images/async?q=${encodeURIComponent(
      query
    )}&first=0&count=10&qft=+filterui:photo-photo+filterui:face-portrait`;
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    const seen = new Set();
    const murlRe = /murl&quot;:&quot;(https?:\/\/[^&"]+)&quot;/g;
    let match;
    while ((match = murlRe.exec(html)) !== null && out.length < 8) {
      const candidateUrl = match[1].replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
      if (seen.has(candidateUrl)) continue;
      seen.add(candidateUrl);
      out.push({ url: candidateUrl, source: '网页图搜', label: query });
    }
    return out;
  } catch {
    return [];
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || '').trim();

  if (mode === 'download') {
    const targetUrl = (url.searchParams.get('url') || '').trim();
    if (!targetUrl) {
      return jsonResponse({ ok: false, error: '缺少图像地址' }, 400);
    }
    const downloadedDataUrl = await downloadRemoteImageAsDataUrl(targetUrl);
    if (!downloadedDataUrl) {
      return jsonResponse({ ok: false, error: '下载图像失败或地址受限' }, 422);
    }
    return jsonResponse({ ok: true, downloadedDataUrl, sourceUrl: targetUrl });
  }

  const rawName = (url.searchParams.get('name') || '').trim().slice(0, 100);
  const customQuery = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const autoDownload = url.searchParams.get('auto') !== '0';

  const cleanedName = cleanArtistSearchTerm(rawName) || rawName;
  const searchQuery = (customQuery || cleanedName).trim();
  if (!searchQuery) {
    return jsonResponse({ ok: false, candidates: [], error: '缺少搜索关键词' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const isCustomPortraitSearch = Boolean(
    customQuery && normalizeMatch(customQuery) !== normalizeMatch(cleanedName)
  );

  try {
    const bingQuery = isCustomPortraitSearch
      ? searchQuery
      : `${cleanedName} 歌手 写真 自拍 portrait`;

    const [deezerRes, neteaseRes, bingRes, zhWikiRes, enWikiRes] =
      await Promise.allSettled([
        fetchDeezerPortraits(cleanedName, controller.signal),
        fetchNeteasePortraits(cleanedName, controller.signal),
        fetchBingPortraitImages(bingQuery, controller.signal),
        fetchWikipediaPortraits(cleanedName, 'zh', controller.signal),
        fetchWikipediaPortraits(`${cleanedName} singer`, 'en', controller.signal),
      ]);

    const deezer = deezerRes.status === 'fulfilled' ? deezerRes.value : [];
    const netease = neteaseRes.status === 'fulfilled' ? neteaseRes.value : [];
    const bing = bingRes.status === 'fulfilled' ? bingRes.value : [];
    const zhWiki = zhWikiRes.status === 'fulfilled' ? zhWikiRes.value : [];
    const enWiki = enWikiRes.status === 'fulfilled' ? enWikiRes.value : [];

    const mergedRaw = isCustomPortraitSearch
      ? [...bing, ...netease, ...deezer, ...zhWiki, ...enWiki]
      : [...netease, ...deezer, ...bing, ...zhWiki, ...enWiki];

    const seenUrls = new Set();
    const candidates = [];
    for (const c of mergedRaw) {
      if (!c.url || seenUrls.has(c.url)) continue;
      seenUrls.add(c.url);
      candidates.push(c);
      if (candidates.length >= 16) break;
    }

    if (!autoDownload) {
      return jsonResponse({ ok: true, query: searchQuery, candidates });
    }

    for (const candidate of candidates.slice(0, 5)) {
      const downloadedDataUrl = await downloadRemoteImageAsDataUrl(candidate.url);
      if (downloadedDataUrl) {
        return jsonResponse({
          ok: true,
          query: searchQuery,
          downloadedDataUrl,
          sourceName: candidate.source,
          sourceUrl: candidate.url,
          candidates,
        });
      }
    }

    return jsonResponse({
      ok: candidates.length > 0,
      query: searchQuery,
      candidates,
      error: candidates.length === 0 ? '未找到匹配的歌手图像' : undefined,
    });
  } finally {
    clearTimeout(timer);
  }
};
