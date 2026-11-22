import { ArtistAvatarCandidate, ArtistAvatarRecord } from '../types/music';
import { getAllArtistAvatars, saveArtistAvatar } from './storage';

const PORTRAIT_SIZE_PX = 420;

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法解码图像'));
    img.src = src;
  });
}

/**
 * Resizes and center-crops any portrait image/Blob into a lightweight 320x320 square WebP/JPEG
 * with top-biased framing so artist faces/selfies remain cleanly centered in square tiles.
 */
export async function resizePortraitToSquareDataUrl(
  source: string | Blob,
  size = PORTRAIT_SIZE_PX
): Promise<string> {
  const isBlob = typeof source !== 'string';
  const url = isBlob ? URL.createObjectURL(source) : source;
  try {
    const img = await loadImageElement(url);
    const w = img.naturalWidth || img.width || size;
    const h = img.naturalHeight || img.height || size;
    const side = Math.max(1, Math.min(w, h));
    const sx = Math.max(0, (w - side) / 2);
    // Portrait bias: keep top 20% offset when vertical image so foreheads are never sliced off
    const sy = h > w ? Math.max(0, (h - side) * 0.2) : Math.max(0, (h - side) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return typeof source === 'string' ? source : '';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

    const webp = canvas.toDataURL('image/webp', 0.85);
    if (webp.startsWith('data:image/webp')) {
      return webp;
    }
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    if (isBlob) URL.revokeObjectURL(url);
  }
}

async function fetchJsonSafe<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json') && !ct.includes('text/json')) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function clientWikipediaFallback(
  name: string,
  signal?: AbortSignal
): Promise<{ dataUrl?: string; candidates: ArtistAvatarCandidate[] }> {
  try {
    for (const lang of ['zh', 'en']) {
      const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        lang === 'en' ? `${name} singer` : name
      )}&gsrlimit=3&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json&origin=*`;
      const data = await fetchJsonSafe<{
        query?: {
          pages?: Record<
            string,
            { index?: number; title?: string; thumbnail?: { source?: string } }
          >;
        };
      }>(endpoint, signal);
      const pages = Object.values(data?.query?.pages || {}).sort(
        (a, b) => (a.index ?? 99) - (b.index ?? 99)
      );
      const candidates: ArtistAvatarCandidate[] = pages
        .filter((p) => p.thumbnail?.source && !p.thumbnail.source.endsWith('.svg'))
        .map((p) => ({
          url: p.thumbnail!.source!,
          source: lang === 'zh' ? '维基百科' : 'Wikipedia',
          label: p.title || name,
        }));
      if (candidates.length > 0) {
        try {
          const imgRes = await fetch(candidates[0].url, { signal });
          if (imgRes.ok) {
            const blob = await imgRes.blob();
            const dataUrl = await resizePortraitToSquareDataUrl(blob);
            return { dataUrl, candidates };
          }
        } catch {
          // Ignore single client fallback image error
        }
        return { candidates };
      }
    }
  } catch {
    // Ignore fallback failure
  }
  return { candidates: [] };
}

interface ServerAvatarResponse {
  ok?: boolean;
  downloadedDataUrl?: string;
  sourceName?: string;
  sourceUrl?: string;
  candidates?: ArtistAvatarCandidate[];
  error?: string;
}

export async function loadAllCachedArtistAvatars(): Promise<
  Record<string, ArtistAvatarRecord>
> {
  const list = await getAllArtistAvatars();
  const map: Record<string, ArtistAvatarRecord> = {};
  for (const rec of list) {
    map[rec.artistKey] = rec;
  }
  return map;
}

export async function searchAndAutoDownloadArtistAvatar(
  artistKey: string,
  artistName: string,
  options?: { customQuery?: string; signal?: AbortSignal }
): Promise<ArtistAvatarRecord> {
  const qParam = options?.customQuery
    ? `&q=${encodeURIComponent(options.customQuery)}`
    : '';
  const url = `/api/artist-avatar?name=${encodeURIComponent(
    artistName
  )}${qParam}&auto=1`;

  const serverRes = await fetchJsonSafe<ServerAvatarResponse>(url, options?.signal);

  if (serverRes?.downloadedDataUrl) {
    let compactDataUrl = serverRes.downloadedDataUrl;
    try {
      compactDataUrl = await resizePortraitToSquareDataUrl(
        serverRes.downloadedDataUrl
      );
    } catch {
      // Keep original server-fetched dataUrl if canvas resize fails
    }

    const record: ArtistAvatarRecord = {
      artistKey,
      artistName,
      dataUrl: compactDataUrl,
      sourceUrl: serverRes.sourceUrl,
      sourceName: serverRes.sourceName || '在线图搜',
      candidates: serverRes.candidates || [],
      fetchedAt: Date.now(),
      notFound: false,
      isCustom: false,
    };
    await saveArtistAvatar(record);
    return record;
  }

  // Fallback directly via browser CORS-friendly Wikimedia API if local proxy unavailable
  const wikiFallback = await clientWikipediaFallback(artistName, options?.signal);
  if (wikiFallback.dataUrl) {
    const record: ArtistAvatarRecord = {
      artistKey,
      artistName,
      dataUrl: wikiFallback.dataUrl,
      sourceUrl: wikiFallback.candidates[0]?.url,
      sourceName: wikiFallback.candidates[0]?.source || '维基百科',
      candidates: wikiFallback.candidates,
      fetchedAt: Date.now(),
      notFound: false,
      isCustom: false,
    };
    await saveArtistAvatar(record);
    return record;
  }

  const record: ArtistAvatarRecord = {
    artistKey,
    artistName,
    candidates: serverRes?.candidates || wikiFallback.candidates || [],
    fetchedAt: Date.now(),
    notFound: true,
    isCustom: false,
  };
  await saveArtistAvatar(record);
  return record;
}

export async function searchArtistPortraitCandidates(
  artistName: string,
  query?: string,
  signal?: AbortSignal
): Promise<ArtistAvatarCandidate[]> {
  const qParam = query ? `&q=${encodeURIComponent(query)}` : '';
  const url = `/api/artist-avatar?name=${encodeURIComponent(
    artistName
  )}${qParam}&auto=0`;
  const res = await fetchJsonSafe<ServerAvatarResponse>(url, signal);
  if (res?.candidates && res.candidates.length > 0) {
    return res.candidates;
  }
  const fallback = await clientWikipediaFallback(query || artistName, signal);
  return fallback.candidates;
}

export async function downloadAndSaveCandidatePortrait(
  artistKey: string,
  artistName: string,
  candidate: ArtistAvatarCandidate,
  allCandidates?: ArtistAvatarCandidate[]
): Promise<ArtistAvatarRecord> {
  const proxyUrl = `/api/artist-avatar?mode=download&url=${encodeURIComponent(
    candidate.url
  )}`;
  const res = await fetchJsonSafe<ServerAvatarResponse>(proxyUrl);

  let rawSource: string | Blob | null = res?.downloadedDataUrl || null;
  if (!rawSource) {
    // Fallback direct fetch if image host sets permissive CORS headers
    const directRes = await fetch(candidate.url).catch(() => null);
    if (directRes && directRes.ok) {
      rawSource = await directRes.blob();
    }
  }

  if (!rawSource) {
    throw new Error('该图片来源限制下载，请选择列表中的其他候选头像');
  }

  const compactDataUrl = await resizePortraitToSquareDataUrl(rawSource);
  const record: ArtistAvatarRecord = {
    artistKey,
    artistName,
    dataUrl: compactDataUrl,
    sourceUrl: candidate.url,
    sourceName: candidate.source || '网上搜索引擎',
    candidates: allCandidates,
    fetchedAt: Date.now(),
    notFound: false,
    isCustom: true,
  };
  await saveArtistAvatar(record);
  return record;
}

export async function saveCustomUploadedArtistAvatar(
  artistKey: string,
  artistName: string,
  file: File
): Promise<ArtistAvatarRecord> {
  const compactDataUrl = await resizePortraitToSquareDataUrl(file);
  const record: ArtistAvatarRecord = {
    artistKey,
    artistName,
    dataUrl: compactDataUrl,
    sourceName: '本地上传头像',
    fetchedAt: Date.now(),
    notFound: false,
    isCustom: true,
  };
  await saveArtistAvatar(record);
  return record;
}
