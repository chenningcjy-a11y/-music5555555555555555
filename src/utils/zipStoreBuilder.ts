export interface ZipPackageEntry {
  /** Relative path inside the ZIP / folder, e.g. "曲名 - 歌手/歌词/曲名.lrc" */
  path: string;
  data: Blob | Uint8Array | string;
}

const textEncoder = new TextEncoder();

// Precomputed IEEE 802.3 CRC32 Slice-by-4 lookup tables (4x faster than byte-by-byte)
const CRC32_TABLES: [Uint32Array, Uint32Array, Uint32Array, Uint32Array] = (() => {
  const t0 = new Uint32Array(256);
  const t1 = new Uint32Array(256);
  const t2 = new Uint32Array(256);
  const t3 = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t0[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    t1[i] = (t0[t0[i] & 0xff] ^ (t0[i] >>> 8)) >>> 0;
    t2[i] = (t0[t1[i] & 0xff] ^ (t1[i] >>> 8)) >>> 0;
    t3[i] = (t0[t2[i] & 0xff] ^ (t2[i] >>> 8)) >>> 0;
  }
  return [t0, t1, t2, t3];
})();

function crc32Update(crc: number, bytes: Uint8Array): number {
  const [t0, t1, t2, t3] = CRC32_TABLES;
  let c = (crc ^ 0xffffffff) >>> 0;
  let i = 0;
  const len = bytes.length;
  const fastEnd = len - 3;

  while (i < fastEnd) {
    c ^=
      bytes[i] |
      (bytes[i + 1] << 8) |
      (bytes[i + 2] << 16) |
      (bytes[i + 3] << 24);
    c =
      (t3[c & 0xff] ^
        t2[(c >>> 8) & 0xff] ^
        t1[(c >>> 16) & 0xff] ^
        t0[(c >>> 24) & 0xff]) >>>
      0;
    i += 4;
  }

  while (i < len) {
    c = (t0[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    i++;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function computeBlobCrc32(
  blob: Blob,
  onSliceRead?: (bytesRead: number) => void
): Promise<number> {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB slices bound transient ArrayBuffer allocation
  let crc = 0;
  let offset = 0;
  let sliceIdx = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + CHUNK_SIZE);
    const buf = await blob.slice(offset, end).arrayBuffer();
    crc = crc32Update(crc, new Uint8Array(buf));
    const readBytes = end - offset;
    offset = end;
    sliceIdx++;
    onSliceRead?.(readBytes);
    // Yield periodically so mobile/tablet Chromium can reclaim 4MB slices and keep UI responsive
    if (sliceIdx % 4 === 0 && offset < blob.size) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return crc >>> 0;
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

export function sanitizeFileName(name: string, fallback = 'untitled'): string {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return cleaned || fallback;
}

/**
 * Builds a universal UTF-8 ZIP (method 0 STORE) Blob directly from Blobs/Uint8Arrays/strings.
 * Processes large Blobs sequentially in 4 MB streaming slices with Slice-by-4 CRC32 so peak RAM stays minimal.
 */
export async function buildZipBlob(
  entries: ZipPackageEntry[],
  onProgress?: (progress01: number) => void
): Promise<Blob> {
  let totalInputBytes = 0;
  for (const entry of entries) {
    if (typeof entry.data === 'string') {
      totalInputBytes += entry.data.length;
    } else if (entry.data instanceof Uint8Array) {
      totalInputBytes += entry.data.byteLength;
    } else {
      totalInputBytes += entry.data.size;
    }
  }
  const safeTotalBytes = Math.max(1, totalInputBytes);
  let processedBytes = 0;

  const prepared: Array<{
    nameBytes: Uint8Array;
    payloadBlob: Blob;
    crc: number;
    size: number;
  }> = [];

  for (const entry of entries) {
    const cleanPath = entry.path.replace(/^\/+/, '').replace(/\\/g, '/');
    const nameBytes = textEncoder.encode(cleanPath);

    let payloadBlob: Blob;
    let crc = 0;

    if (typeof entry.data === 'string') {
      const bytes = textEncoder.encode(entry.data);
      crc = crc32Update(0, bytes);
      payloadBlob = new Blob([bytes]);
      processedBytes += entry.data.length;
      onProgress?.(Math.min(1, processedBytes / safeTotalBytes));
    } else if (entry.data instanceof Uint8Array) {
      crc = crc32Update(0, entry.data);
      const safeBytes = new Uint8Array(entry.data);
      payloadBlob = new Blob([safeBytes]);
      processedBytes += entry.data.byteLength;
      onProgress?.(Math.min(1, processedBytes / safeTotalBytes));
    } else {
      payloadBlob = entry.data;
      crc = await computeBlobCrc32(payloadBlob, (bytesRead) => {
        processedBytes += bytesRead;
        onProgress?.(Math.min(1, processedBytes / safeTotalBytes));
      });
    }

    prepared.push({ nameBytes, payloadBlob, crc, size: payloadBlob.size });
  }

  const parts: BlobPart[] = [];
  const centralDirRecords: Uint8Array[] = [];
  const { dosTime, dosDate } = toDosTimeDate(new Date());
  let offset = 0;

  for (const { nameBytes, payloadBlob, crc, size } of prepared) {

    // Local File Header (30 bytes + filename length)
    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // compression method: 0 (STORE)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    new Uint8Array(localHeader, 30).set(nameBytes);

    parts.push(localHeader);
    parts.push(payloadBlob);

    // Central Directory File Header (46 bytes + filename length)
    const cdHeader = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cdHeader);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 filename flag
    cv.setUint16(10, 0, true); // compression method: 0 (STORE)
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    new Uint8Array(cdHeader, 46).set(nameBytes);

    centralDirRecords.push(new Uint8Array(cdHeader));
    offset += 30 + nameBytes.length + size;
  }

  let cdSize = 0;
  for (const rec of centralDirRecords) {
    parts.push(new Uint8Array(rec));
    cdSize += rec.byteLength;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 8000);
}

export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function'
  );
}

export async function pickDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    throw new Error('当前浏览器不支持直接写入系统文件夹，请使用 ZIP 歌曲包一键下载。');
  }
  return picker({ mode: 'readwrite' });
}

export async function saveEntriesToDirectoryHandle(
  baseDir: FileSystemDirectoryHandle,
  rootFolderName: string,
  entries: ZipPackageEntry[]
): Promise<{ folderName: string; fileCount: number }> {
  const safeRoot = sanitizeFileName(rootFolderName);
  const songDir = await baseDir.getDirectoryHandle(safeRoot, {
    create: true,
  });

  const cleanPrefix = `${safeRoot}/`;
  let fileCount = 0;

  for (const entry of entries) {
    let relPath = entry.path.replace(/^\/+/, '').replace(/\\/g, '/');
    if (relPath.startsWith(cleanPrefix)) {
      relPath = relPath.slice(cleanPrefix.length);
    }
    const segments = relPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let curDir = songDir;
    for (let i = 0; i < segments.length - 1; i++) {
      curDir = await curDir.getDirectoryHandle(segments[i], { create: true });
    }

    const fileName = segments[segments.length - 1];
    const fileHandle = await curDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      if (typeof entry.data === 'string') {
        await writable.write(entry.data);
      } else if (entry.data instanceof Uint8Array) {
        await writable.write(new Uint8Array(entry.data));
      } else {
        await writable.write(entry.data);
      }
    } finally {
      await writable.close();
    }
    fileCount++;
  }

  return { folderName: safeRoot, fileCount };
}

/**
 * Writes package entries straight into a real local directory on desktop Chromium browsers
 * supporting the File System Access API (`showDirectoryPicker`).
 */
export async function saveEntriesToPickedFolder(
  rootFolderName: string,
  entries: ZipPackageEntry[]
): Promise<{ folderName: string; fileCount: number }> {
  const baseDir = await pickDirectoryHandle();
  return saveEntriesToDirectoryHandle(baseDir, rootFolderName, entries);
}
