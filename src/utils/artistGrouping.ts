import { TrackMetadata } from '../types/music';

export type LibraryCategoryAxis = 'artist' | 'composer';

export interface ArtistPartitionGroup {
  key: string;
  name: string;
  axis: LibraryCategoryAxis;
  tracks: TrackMetadata[];
  fallbackCoverUrl?: string;
  totalDuration: number;
}

const LYRIC_COMPOSER_LINE_RE =
  /(?:作\s*曲|曲\s*[:：]|composer\s*[:：]|music\s+by\s*[:：]|written\s+by\s*[:：]|composed\s+by\s*[:：])\s*([^\r\n/|\\[\]]+)/i;

export function normalizeCreatorKey(raw?: string): string {
  const cleaned = (raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return cleaned || '未知艺术家';
}

export function extractComposerFromTrack(track: TrackMetadata): string {
  if (track.composer && track.composer.trim()) {
    return track.composer.trim();
  }
  if (track.lyricsRaw) {
    // Only scan top/tail lines where credit tags typically live to keep CPU work near-zero
    const lines = track.lyricsRaw.split(/\r?\n/);
    const scanSlice =
      lines.length > 24
        ? [...lines.slice(0, 14), ...lines.slice(-10)]
        : lines;
    for (const rawLine of scanSlice) {
      const cleanLine = rawLine.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim();
      const match = cleanLine.match(LYRIC_COMPOSER_LINE_RE);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (candidate && candidate.length <= 48) {
          return candidate;
        }
      }
    }
  }
  return (track.artist || '').trim() || '未知艺术家';
}

export function extractPrimaryCreatorName(
  track: TrackMetadata,
  axis: LibraryCategoryAxis
): string {
  if (axis === 'composer') {
    return extractComposerFromTrack(track);
  }
  return (track.artist || '').trim() || '未知艺术家';
}

export function buildArtistPartitionGroups(
  tracks: TrackMetadata[],
  axis: LibraryCategoryAxis
): ArtistPartitionGroup[] {
  const map = new Map<
    string,
    {
      key: string;
      nameCounts: Map<string, number>;
      tracks: TrackMetadata[];
      fallbackCoverUrl?: string;
      totalDuration: number;
    }
  >();

  for (const track of tracks) {
    const rawName = extractPrimaryCreatorName(track, axis);
    const key = normalizeCreatorKey(rawName);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        key,
        nameCounts: new Map<string, number>(),
        tracks: [],
        fallbackCoverUrl: track.coverDataUrl,
        totalDuration: 0,
      };
      map.set(key, bucket);
    }
    bucket.tracks.push(track);
    bucket.totalDuration += track.duration || 0;
    if (!bucket.fallbackCoverUrl && track.coverDataUrl) {
      bucket.fallbackCoverUrl = track.coverDataUrl;
    }
    bucket.nameCounts.set(rawName, (bucket.nameCounts.get(rawName) || 0) + 1);
  }

  const groups: ArtistPartitionGroup[] = [];
  for (const bucket of map.values()) {
    let bestName = bucket.key;
    let bestCount = -1;
    for (const [display, count] of bucket.nameCounts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestName = display;
      }
    }
    groups.push({
      key: bucket.key,
      name: bestName,
      axis,
      tracks: bucket.tracks,
      fallbackCoverUrl: bucket.fallbackCoverUrl,
      totalDuration: bucket.totalDuration,
    });
  }

  // Sort multi-track creators first, then alphabetically for clean browsing
  return groups.sort((a, b) => {
    const isUnknownA = a.key === '未知艺术家' || a.key === 'unknown artist';
    const isUnknownB = b.key === '未知艺术家' || b.key === 'unknown artist';
    if (isUnknownA !== isUnknownB) return isUnknownA ? 1 : -1;
    if (b.tracks.length !== a.tracks.length) {
      return b.tracks.length - a.tracks.length;
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function isUnknownArtistKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return !k || k === '未知艺术家' || k === '未知歌手' || k === 'unknown artist' || k === 'unknown';
}
