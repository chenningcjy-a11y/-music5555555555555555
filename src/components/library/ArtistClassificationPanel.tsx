import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Loader2,
  Play,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react';
import {
  loadAllCachedArtistAvatars,
  searchAndAutoDownloadArtistAvatar,
} from '../../services/artistAvatarService';
import {
  ArtistAvatarRecord,
  TrackColorPalette,
  TrackMetadata,
} from '../../types/music';
import {
  ArtistPartitionGroup,
  buildArtistPartitionGroups,
  isUnknownArtistKey,
  LibraryCategoryAxis,
} from '../../utils/artistGrouping';
import { formatTime } from '../../utils/constants';
import { ArtistAvatarSearchModal } from './ArtistAvatarSearchModal';

interface ArtistSquareTileProps {
  group: ArtistPartitionGroup;
  avatar?: ArtistAvatarRecord;
  isFetching: boolean;
  palette: TrackColorPalette;
  onSelectGroup: (key: string) => void;
  onOpenAvatarSearch: (group: ArtistPartitionGroup) => void;
}

const ArtistSquareTile: React.FC<ArtistSquareTileProps> = React.memo(
  ({
    group,
    avatar,
    isFetching,
    palette,
    onSelectGroup,
    onOpenAvatarSearch,
  }) => {
    const displayImage = avatar?.dataUrl || group.fallbackCoverUrl;
    const initialChar = group.name.trim().slice(0, 1).toUpperCase() || '♪';

    return (
      <div
        className="aspect-square rounded-3xl overflow-hidden relative group bg-white/[0.04] border border-white/10 transition-colors hover:border-white/25"
        style={{ contain: 'layout style paint' }}
      >
        {/* Main Clickable Square Trigger */}
        <button
          type="button"
          onClick={() => onSelectGroup(group.key)}
          className="w-full h-full block text-left relative cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          {displayImage ? (
            <img
              src={displayImage}
              alt={group.name}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover object-top transition-transform duration-300 ease-out group-hover:scale-[1.04]"
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                background: `linear-gradient(135deg, ${palette.primary}38, ${palette.deep})`,
              }}
            >
              <span className="font-display text-4xl sm:text-5xl font-semibold text-white/75 select-none">
                {initialChar}
              </span>
            </div>
          )}

          {/* Measured Contrast Scrim + Unboxed Typography */}
          <div className="absolute inset-x-0 bottom-0 pt-14 pb-3.5 px-4 bg-gradient-to-t from-black/88 via-black/45 to-transparent">
            <p className="text-base sm:text-[17px] font-semibold text-white truncate">
              {group.name}
            </p>
            <p className="text-xs text-white/75 font-mono-tabular truncate mt-0.5">
              {group.tracks.length} 首歌曲
            </p>
          </div>
        </button>

        {/* Searching indicator only while actively downloading portrait */}
        {isFetching && (
          <div
            title="正在网上搜索并自动下载歌手头像..."
            className="absolute top-3 left-3 w-7 h-7 rounded-full bg-black/65 border border-white/15 flex items-center justify-center text-white pointer-events-none"
          >
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        )}

        {/* Quick Portrait Search Button on Square Corner */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenAvatarSearch(group);
          }}
          title={`搜寻或更换「${group.name}」的头像`}
          aria-label={`搜寻或更换「${group.name}」的头像`}
          className="absolute top-3 right-3 w-9 h-9 rounded-xl bg-black/55 hover:bg-black/80 border border-white/15 text-white/85 hover:text-white flex items-center justify-center opacity-85 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
        >
          <Search className="w-4 h-4" />
        </button>
      </div>
    );
  }
);

interface ArtistClassificationPanelProps {
  tracks: TrackMetadata[];
  searchQuery: string;
  palette: TrackColorPalette;
  onPlayAllGroupTracks: (tracks: TrackMetadata[]) => Promise<void> | void;
  renderTrackList: (groupTracks: TrackMetadata[]) => React.ReactNode;
}

export const ArtistClassificationPanel: React.FC<ArtistClassificationPanelProps> =
  React.memo(
    ({
      tracks,
      searchQuery,
      palette,
      onPlayAllGroupTracks,
      renderTrackList,
    }) => {
      const [axis, setAxis] = useState<LibraryCategoryAxis>('artist');
      const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(
        null
      );
      const [avatarMap, setAvatarMap] = useState<
        Record<string, ArtistAvatarRecord>
      >({});
      const [avatarsLoaded, setAvatarsLoaded] = useState(false);
      const [fetchingKeys, setFetchingKeys] = useState<Set<string>>(
        () => new Set()
      );
      const [searchModalGroup, setSearchModalGroup] =
        useState<ArtistPartitionGroup | null>(null);

      const inFlightKeysRef = useRef<Set<string>>(new Set());

      // Hydrate all persisted artist/composer avatars once from IndexedDB
      useEffect(() => {
        let cancelled = false;
        loadAllCachedArtistAvatars()
          .then((loaded) => {
            if (!cancelled) {
              setAvatarMap(loaded);
              setAvatarsLoaded(true);
            }
          })
          .catch(() => {
            if (!cancelled) setAvatarsLoaded(true);
          });
        return () => {
          cancelled = true;
        };
      }, []);

      const artistGroups = useMemo(
        () => buildArtistPartitionGroups(tracks, 'artist'),
        [tracks]
      );
      const composerGroups = useMemo(
        () => buildArtistPartitionGroups(tracks, 'composer'),
        [tracks]
      );
      const allGroups = axis === 'artist' ? artistGroups : composerGroups;

      const filteredGroups = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return allGroups;
        return allGroups.filter(
          (g) =>
            g.name.toLowerCase().includes(q) ||
            g.tracks.some(
              (t) =>
                t.title.toLowerCase().includes(q) ||
                t.album.toLowerCase().includes(q)
            )
        );
      }, [allGroups, searchQuery]);

      const selectedGroup = useMemo(() => {
        if (!selectedGroupKey) return null;
        return allGroups.find((g) => g.key === selectedGroupKey) || null;
      }, [allGroups, selectedGroupKey]);

      const selectedGroupTracks = useMemo(() => {
        if (!selectedGroup) return [];
        const q = searchQuery.trim().toLowerCase();
        if (!q || selectedGroup.name.toLowerCase().includes(q)) {
          return selectedGroup.tracks;
        }
        return selectedGroup.tracks.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.album.toLowerCase().includes(q)
        );
      }, [selectedGroup, searchQuery]);

      // Reset drill-down cleanly if grouping axis switches
      const handleSwitchAxis = useCallback((nextAxis: LibraryCategoryAxis) => {
        setAxis(nextAxis);
        setSelectedGroupKey(null);
      }, []);

      // Polite bounded background queue (concurrency = 2) to search & auto-download missing avatars
      useEffect(() => {
        if (!avatarsLoaded || filteredGroups.length === 0) return;
        const missing = filteredGroups.filter((g) => {
          if (isUnknownArtistKey(g.key)) return false;
          if (inFlightKeysRef.current.has(g.key)) return false;
          const existing = avatarMap[g.key];
          if (!existing) return true;
          return false;
        });

        if (missing.length === 0) return;

        let cancelled = false;
        const controller = new AbortController();
        const queue = missing.slice(0, 24);
        let cursor = 0;

        const runWorker = async () => {
          while (!cancelled && cursor < queue.length) {
            const group = queue[cursor++];
            if (!group || inFlightKeysRef.current.has(group.key)) continue;

            inFlightKeysRef.current.add(group.key);
            setFetchingKeys((prev) => {
              const next = new Set(prev);
              next.add(group.key);
              return next;
            });

            try {
              const rec = await searchAndAutoDownloadArtistAvatar(
                group.key,
                group.name,
                { signal: controller.signal }
              );
              if (!cancelled) {
                setAvatarMap((prev) => ({ ...prev, [group.key]: rec }));
              }
            } catch {
              // Skip quietly on abort/offline error
            } finally {
              inFlightKeysRef.current.delete(group.key);
              if (!cancelled) {
                setFetchingKeys((prev) => {
                  if (!prev.has(group.key)) return prev;
                  const next = new Set(prev);
                  next.delete(group.key);
                  return next;
                });
              }
            }
          }
        };

        const workers = [runWorker(), runWorker()];
        Promise.all(workers).catch(() => {});

        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [avatarsLoaded, filteredGroups, avatarMap]);

      const handleRetryMissingAvatars = useCallback(async () => {
        const candidates = filteredGroups.filter(
          (g) => !isUnknownArtistKey(g.key) && !avatarMap[g.key]?.dataUrl
        );
        if (candidates.length === 0) return;

        // Clear notFound markers locally so queue immediately re-tries them cleanly
        setAvatarMap((prev) => {
          const next = { ...prev };
          for (const g of candidates) {
            if (next[g.key]?.notFound) {
              delete next[g.key];
            }
          }
          return next;
        });
      }, [filteredGroups, avatarMap]);

      const handleSavedRecord = useCallback((record: ArtistAvatarRecord) => {
        setAvatarMap((prev) => ({ ...prev, [record.artistKey]: record }));
      }, []);

      const cachedCount = useMemo(
        () =>
          filteredGroups.filter((g) => Boolean(avatarMap[g.key]?.dataUrl)).length,
        [filteredGroups, avatarMap]
      );

      if (tracks.length === 0) {
        return (
          <div className="rounded-3xl bg-white/[0.03] border border-white/10 p-12 text-center flex flex-col items-center gap-3">
            <UserRound className="w-10 h-10 text-white/35" />
            <p className="text-sm text-white/75">
              曲库为空，导入歌曲后将自动按歌手与作曲家分组展示
            </p>
          </div>
        );
      }

      return (
        <div className="space-y-4">
          {/* Sub-bar: Artist vs Composer Partition Switch + Portrait Sync Summary */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.05] border border-white/10">
              <button
                type="button"
                onClick={() => handleSwitchAxis('artist')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  axis === 'artist'
                    ? 'bg-white/16 text-white'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                歌手分区 ({artistGroups.length})
              </button>
              <button
                type="button"
                onClick={() => handleSwitchAxis('composer')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  axis === 'composer'
                    ? 'bg-white/16 text-white'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                作曲家分区 ({composerGroups.length})
              </button>
            </div>

            <div className="flex items-center gap-3 text-xs text-white/55">
              <span className="font-mono-tabular">
                已匹配头像 {cachedCount} / {filteredGroups.length}
              </span>
              {cachedCount < filteredGroups.length && fetchingKeys.size === 0 && (
                <button
                  type="button"
                  onClick={() => void handleRetryMissingAvatars()}
                  className="px-2.5 py-1 rounded-lg bg-white/8 hover:bg-white/14 text-white/80 hover:text-white flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>补全头像</span>
                </button>
              )}
            </div>
          </div>

          {/* Drill-down View OR Square Tile Grid */}
          {selectedGroup ? (
            <div className="space-y-4">
              {/* Selected Artist / Composer Header Banner */}
              <div className="rounded-3xl bg-white/[0.04] border border-white/10 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelectedGroupKey(null)}
                    aria-label={
                      axis === 'artist' ? '返回全部歌手' : '返回全部作曲家'
                    }
                    className="w-10 h-10 rounded-xl bg-white/8 hover:bg-white/15 border border-white/10 flex items-center justify-center text-white/80 hover:text-white transition-colors shrink-0 cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>

                  <div className="w-16 h-16 sm:w-[72px] sm:h-[72px] rounded-2xl overflow-hidden bg-white/10 border border-white/15 shrink-0">
                    {avatarMap[selectedGroup.key]?.dataUrl ||
                    selectedGroup.fallbackCoverUrl ? (
                      <img
                        src={
                          avatarMap[selectedGroup.key]?.dataUrl ||
                          selectedGroup.fallbackCoverUrl
                        }
                        alt={selectedGroup.name}
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover object-top"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xl font-semibold text-white/60">
                        {selectedGroup.name.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <h2 className="font-display text-lg sm:text-xl font-semibold text-white truncate">
                      {selectedGroup.name}
                    </h2>
                    <p className="text-xs text-white/60 font-mono-tabular mt-1">
                      {axis === 'composer' ? '作曲家分区' : '歌手分区'} ·{' '}
                      {selectedGroupTracks.length} 首歌曲 ·{' '}
                      {formatTime(selectedGroup.totalDuration)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setSearchModalGroup(selectedGroup)}
                    className="px-3.5 py-2 rounded-xl bg-white/8 hover:bg-white/14 border border-white/12 text-xs font-medium text-white flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>搜换头像</span>
                  </button>
                  <button
                    type="button"
                    disabled={selectedGroupTracks.length === 0}
                    onClick={() => void onPlayAllGroupTracks(selectedGroupTracks)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 shadow-lg disabled:opacity-50 transition-transform active:scale-95 cursor-pointer whitespace-nowrap"
                    style={{
                      background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
                    }}
                  >
                    <Play className="w-3.5 h-3.5" fill="currentColor" />
                    <span>全部播放</span>
                  </button>
                </div>
              </div>

              {/* Matching Tracks for Selected Artist/Composer */}
              {renderTrackList(selectedGroupTracks)}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="rounded-3xl bg-white/[0.03] border border-white/10 p-12 text-center flex flex-col items-center gap-3">
              <UserRound className="w-10 h-10 text-white/35" />
              <p className="text-sm text-white/75">
                未找到匹配的{axis === 'composer' ? '作曲家' : '歌手'}分组
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
              {filteredGroups.map((group) => (
                <ArtistSquareTile
                  key={`${axis}-${group.key}`}
                  group={group}
                  avatar={avatarMap[group.key]}
                  isFetching={fetchingKeys.has(group.key)}
                  palette={palette}
                  onSelectGroup={setSelectedGroupKey}
                  onOpenAvatarSearch={setSearchModalGroup}
                />
              ))}
            </div>
          )}

          <ArtistAvatarSearchModal
            open={Boolean(searchModalGroup)}
            artistKey={searchModalGroup?.key || ''}
            artistName={searchModalGroup?.name || ''}
            currentRecord={
              searchModalGroup ? avatarMap[searchModalGroup.key] : undefined
            }
            palette={palette}
            onClose={() => setSearchModalGroup(null)}
            onSaved={handleSavedRecord}
          />
        </div>
      );
    }
  );
