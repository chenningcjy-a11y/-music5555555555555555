import dns from 'node:dns/promises';
import net from 'node:net';

export interface ArtistPortraitCandidate {
  url: string;
  source: string;
  label: string;
}

export interface ArtistAvatarSearchResult {
  ok: boolean;
  query: string;
  downloadedDataUrl?: string;
  sourceName?: string;
  sourceUrl?: string;
  candidates: ArtistPortraitCandidate[];
  error?: string;
}

const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 4500;
const DOWNLOAD_TIMEOUT_MS = 5000;

function isPrivateOrBlockedIp(ip: string): boolean {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80') ||
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:192.168.') ||
    lower.startsWith('::ffff:169.254.')
  );
}

async function isSafePublicImageUrl(rawUrl: string): Promise<URL | null> {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return null;
    }
    if (net.isIP(host)) {
      return isPrivateOrBlockedIp(host) ? null : parsed;
    }
    const records = await dns.lookup(host, { all: true }).catch(() => []);
    if (records.length > 0 && records.some((r) => isPrivateOrBlockedIp(r.address))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function downloadRemoteImageAsDataUrl(
  rawUrl: string
): Promise<string | null> {
  const safeUrl = await isSafePublicImageUrl(rawUrl);
  if (!safeUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(safeUrl.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      },
    });
    if (!res.ok) return null;
    const finalSafe = await isSafePublicImageUrl(res.url || safeUrl.toString());
    if (!finalSafe) return null;

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/') && !ct.includes('octet-stream')) {
      return null;
    }
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

function normalizeMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanArtistSearchTerm(raw: string): string {
  const trimmed = raw.trim();
  // Strip featured collaborator tails like "feat. X" or "(with Y)" to improve hit rate
  return trimmed
    .replace(/\s*\((?:feat\.?|ft\.?|with)\s+[^)]+\)/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/gi, '')
    .trim();
}

async function fetchDeezerPortraits(
  name: string,
  signal: AbortSignal
): Promise<ArtistPortraitCandidate[]> {
  try {
    const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(
      name
    )}&limit=5`;
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: { name?: string; picture_big?: string; picture_medium?: string }[];
    };
    const items = json.data || [];
    const target = normalizeMatch(name);

    const ranked = [...items].sort((a, b) => {
      const aExact = normalizeMatch(a.name || '') === target ? 1 : 0;
      const bExact = normalizeMatch(b.name || '') === target ? 1 : 0;
      return bExact - aExact;
    });

    const out: ArtistPortraitCandidate[] = [];
    for (const item of ranked) {
      const pic = item.picture_big || item.picture_medium;
      if (!pic || pic.includes('/artist//')) continue;
      out.push({
        url: pic,
        source: 'Deezer 艺人库',
        label: item.name || name,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchNeteasePortraits(
  name: string,
  signal: AbortSignal
): Promise<ArtistPortraitCandidate[]> {
  try {
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(
      name
    )}&type=100&limit=5`;
    const res = await fetch(url, {
      signal,
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      result?: {
        artists?: { name?: string; img1v1Url?: string; picUrl?: string }[];
      };
    };
    const items = json.result?.artists || [];
    const out: ArtistPortraitCandidate[] = [];
    for (const item of items) {
      const rawUrl = item.picUrl || item.img1v1Url;
      if (!rawUrl || rawUrl.includes('5639395138885805')) continue;
      const secureUrl = rawUrl.replace(/^http:\/\//i, 'https://');
      const sizedUrl = secureUrl.includes('?')
        ? secureUrl
        : `${secureUrl}?param=480y480`;
      out.push({
        url: sizedUrl,
        source: '网易云歌手库',
        label: item.name || name,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchWikipediaPortraits(
  name: string,
  lang: 'zh' | 'en',
  signal: AbortSignal
): Promise<ArtistPortraitCandidate[]> {
  try {
    const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      name
    )}&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=480&format=json&origin=*`;
    const res = await fetch(endpoint, {
      signal,
      headers: {
        'User-Agent': 'LUMINA-MUSIC/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          { index?: number; title?: string; thumbnail?: { source?: string } }
        >;
      };
    };
    const pages = Object.values(json.query?.pages || {}).sort(
      (a, b) => (a.index ?? 99) - (b.index ?? 99)
    );
    const out: ArtistPortraitCandidate[] = [];
    for (const page of pages) {
      const src = page.thumbnail?.source;
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

async function fetchBingPortraitImages(
  query: string,
  signal: AbortSignal
): Promise<ArtistPortraitCandidate[]> {
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
    const out: ArtistPortraitCandidate[] = [];
    const seen = new Set<string>();
    const murlRe = /murl&quot;:&quot;(https?:\/\/[^&"]+)&quot;/g;
    let match: RegExpExecArray | null;
    while ((match = murlRe.exec(html)) !== null && out.length < 8) {
      const candidateUrl = match[1]
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/');
      if (seen.has(candidateUrl)) continue;
      seen.add(candidateUrl);
      out.push({
        url: candidateUrl,
        source: '网页图搜',
        label: query,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function searchArtistAvatarPortraits(options: {
  name: string;
  customQuery?: string;
  autoDownload?: boolean;
}): Promise<ArtistAvatarSearchResult> {
  const rawName = options.name.trim().slice(0, 100);
  const cleanedName = cleanArtistSearchTerm(rawName) || rawName;
  const searchQuery = (options.customQuery || cleanedName).trim().slice(0, 120);

  if (!searchQuery) {
    return { ok: false, query: '', candidates: [], error: '缺少歌手或搜索词' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  const isCustomPortraitSearch = Boolean(
    options.customQuery &&
      normalizeMatch(options.customQuery) !== normalizeMatch(cleanedName)
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

    // Prioritize natural portrait / selfie photos from Netease + Deezer + Bing + Wiki
    const mergedRaw = isCustomPortraitSearch
      ? [...bing, ...netease, ...deezer, ...zhWiki, ...enWiki]
      : [...netease, ...deezer, ...bing, ...zhWiki, ...enWiki];

    const seenUrls = new Set<string>();
    const candidates: ArtistPortraitCandidate[] = [];
    for (const c of mergedRaw) {
      if (!c.url || seenUrls.has(c.url)) continue;
      seenUrls.add(c.url);
      candidates.push(c);
      if (candidates.length >= 16) break;
    }

    if (!options.autoDownload) {
      return {
        ok: true,
        query: searchQuery,
        candidates,
      };
    }

    for (const candidate of candidates.slice(0, 5)) {
      const dataUrl = await downloadRemoteImageAsDataUrl(candidate.url);
      if (dataUrl) {
        return {
          ok: true,
          query: searchQuery,
          downloadedDataUrl: dataUrl,
          sourceName: candidate.source,
          sourceUrl: candidate.url,
          candidates,
        };
      }
    }

    return {
      ok: candidates.length > 0,
      query: searchQuery,
      candidates,
      error: candidates.length === 0 ? '未找到匹配的歌手图像' : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
