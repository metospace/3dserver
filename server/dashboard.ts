import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { HttpError, originalFilename } from './validation.js';
import type { DashboardPackage } from '../src/contracts.js';

// Limits apply before extraction; streamed byte counts and CRCs also check the actual content.
export const PACKAGE_UPLOAD_LIMIT = 100 * 1024 * 1024;
const EXPANDED_LIMIT = 200 * 1024 * 1024;
const FILE_LIMIT = 2000;
export type DashboardSource = 'html' | 'zip' | 'folder';
export interface PackageFile { path: string; size: number; storage: string; mime: string }
export interface PackageManifest { entry: string; files: PackageFile[] }
export interface PreparedDashboard { sourceKind: DashboardSource; entry: string; originalName: string; size: number }
interface ZipItem { entry: yauzl.Entry; name: string; directory: boolean }

function invalid(message: string): never { throw new HttpError(400, message); }
export function packagePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')) invalid('包内路径必须为安全、非空的相对路径');
  return value;
}

class PathRegistry {
  private readonly entries = new Map<string, 'file' | 'directory'>();
  private readonly spellings = new Map<string, string>();
  private readonly explicit = new Set<string>();
  add(name: string, directory: boolean) {
    const pieces = name.split('/');
    for (let i = 1; i <= pieces.length; i++) {
      const prefix = pieces.slice(0, i).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      const spelling = this.spellings.get(key);
      if (spelling !== undefined && spelling !== prefix) invalid('包内包含大小写或 Unicode 冲突路径');
      this.spellings.set(key, prefix);
      const final = i === pieces.length;
      const kind = final && !directory ? 'file' : 'directory';
      if ((final && this.explicit.has(key)) || (this.entries.has(key) && (this.entries.get(key) === 'file' || kind === 'file'))) invalid('包内包含重复路径或文件目录冲突');
      this.entries.set(key, kind);
      if (final) this.explicit.add(key);
    }
  }
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c >>> 0;
}
function crcStream(item: yauzl.Entry): Transform {
  let crc = 0xffffffff, size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > item.uncompressedSize || size > PACKAGE_UPLOAD_LIMIT) { callback(new HttpError(400, 'ZIP 实际展开大小超出声明或限制')); return; }
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      callback(null, chunk);
    },
    flush(callback) {
      callback(size !== item.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== item.crc32 ? new HttpError(400, 'ZIP 文件内容不完整或 CRC 校验失败') : undefined);
    },
  });
}
// Node 20 has no Promise.withResolvers; these adapters bridge callback/event-only ZIP APIs.
function openZip(filename: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(new HttpError(400, 'ZIP 文件格式无效')); else resolve(zip);
    });
  });
}
function inspectZip(zip: yauzl.ZipFile): Promise<ZipItem[]> {
  return new Promise((resolve, reject) => {
    const items: ZipItem[] = [], registry = new PathRegistry();
    let total = 0;
    const fail = (error: unknown) => { zip.removeListener('entry', entry); reject(error); };
    const entry = (item: yauzl.Entry) => {
      try {
        if (items.length >= FILE_LIMIT) invalid('包内最多允许 2000 个文件或目录');
        if ((item.generalPurposeBitFlag & 1) || ![0, 8].includes(item.compressionMethod)) invalid('ZIP 不支持加密或此压缩算法');
        const mode = (item.externalFileAttributes >>> 16) & 0xf000;
        if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) invalid('ZIP 不允许符号链接或特殊文件');
        const directory = item.fileName.endsWith('/');
        if ((mode === 0x4000 && !directory) || (mode === 0x8000 && directory)) invalid('ZIP 文件类型与路径不符');
        const name = packagePath(directory ? item.fileName.slice(0, -1) : item.fileName);
        registry.add(name, directory);
        if (!Number.isSafeInteger(item.uncompressedSize) || item.uncompressedSize > PACKAGE_UPLOAD_LIMIT || (directory && item.uncompressedSize !== 0)) invalid('ZIP 单文件不得超过 100 MB');
        total += item.uncompressedSize;
        if (total > EXPANDED_LIMIT) invalid('ZIP 展开内容不得超过 200 MB');
        items.push({ entry: item, name, directory });
        zip.readEntry();
      } catch (error) { fail(error); }
    };
    zip.once('error', fail);
    zip.once('end', () => { zip.removeListener('error', fail); resolve(items); });
    zip.on('entry', entry);
    zip.readEntry();
  });
}
function zipStream(zip: yauzl.ZipFile, item: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(item, (error, stream) => {
    if (error || !stream) reject(new HttpError(400, 'ZIP 内容无法读取')); else resolve(stream);
  }));
}
const mimes: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.txt': 'text/plain',
};
const mime = (name: string) => mimes[path.posix.extname(name).toLowerCase()] ?? 'application/octet-stream';

export async function syncFile(filename: string): Promise<void> {
  const file = await open(filename, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

export async function prepareDashboard(files: Express.Multer.File[], pathsValue: unknown, entryValue: unknown, directory: string): Promise<PreparedDashboard> {
  if (!files.length || files.length > FILE_LIMIT) invalid('请选择 1–2000 个文件');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > PACKAGE_UPLOAD_LIMIT) invalid('上传包总大小不得超过 100 MB');
  await mkdir(path.join(directory, 'content'), { recursive: true });
  const manifest: PackageManifest = { entry: '', files: [] };
  let sourceKind: DashboardSource;
  let originalName: string;
  const addFile = (name: string, size: number) => {
    const item = { path: name, size, storage: String(manifest.files.length), mime: mime(name) };
    manifest.files.push(item);
    return path.join(directory, 'content', item.storage);
  };
  const single = files.length === 1 && files[0].fieldname === 'file';
  if (single) {
    const file = files[0];
    originalName = originalFilename(file.originalname);
    if (/\.zip$/i.test(originalName)) {
      sourceKind = 'zip';
      const zip = await openZip(file.path);
      try {
        const items = await inspectZip(zip);
        for (const item of items) {
          // Read directories too: malicious zero-length entries still need valid compressed data and CRC.
          const stream = await zipStream(zip, item.entry);
          if (item.directory) await pipeline(stream, crcStream(item.entry), new Transform({ transform(_chunk, _encoding, cb) { cb(); } }));
          else await pipeline(stream, crcStream(item.entry), createWriteStream(addFile(item.name, item.entry.uncompressedSize), { flags: 'wx' }));
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'ZIP 压缩数据无效或不完整');
      } finally { zip.close(); }
      await copyFile(file.path, path.join(directory, 'source.zip'));
    } else if (/\.html?$/i.test(originalName)) {
      sourceKind = 'html';
      await copyFile(file.path, addFile(originalName, file.size));
      await copyFile(file.path, path.join(directory, 'source.html'));
    } else invalid('大屏只接受 HTML、ZIP 或文件夹');
  } else {
    if (files.some(file => file.fieldname !== 'files[]')) invalid('文件夹上传不能混用单文件字段');
    sourceKind = 'folder'; originalName = 'dashboard.zip';
    let values: unknown;
    try { values = typeof pathsValue === 'string' ? JSON.parse(pathsValue) : undefined; } catch { invalid('文件路径必须是 JSON 数组'); }
    if (!Array.isArray(values) || values.length !== files.length) invalid('文件路径必须与上传文件一一对应');
    const registry = new PathRegistry();
    const names = values.map(value => {
      const name = packagePath(value); registry.add(name, false); return name;
    });
    for (let i = 0; i < files.length; i++) {
      if (files[i].size > PACKAGE_UPLOAD_LIMIT) invalid('单文件不得超过 100 MB');
      await copyFile(files[i].path, addFile(names[i], files[i].size));
    }
    const zip = new yazl.ZipFile();
    // yazl exposes a Node Readable; its declarations use the older structural ReadableStream type.
    const output = zip.outputStream as Readable;
    const exported = pipeline(output, createWriteStream(path.join(directory, 'source.zip'), { flags: 'wx' }));
    zip.once('error', error => output.destroy(error));
    for (const file of manifest.files) zip.addFile(path.join(directory, 'content', file.storage), file.path);
    zip.end(); await exported;
  }
  if (!manifest.files.length) invalid('包中没有文件');
  const htmlFiles = manifest.files.filter(file => /\.html?$/i.test(file.path));
  const entry = entryValue === undefined || entryValue === '' ? (htmlFiles.length === 1 ? htmlFiles[0].path : '') : packagePath(entryValue);
  if (!entry || !htmlFiles.some(file => file.path === entry)) invalid('请选择包内确实存在的 HTML 入口');
  const entryFile = manifest.files.find(file => file.path === entry)!;
  try { new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path.join(directory, 'content', entryFile.storage))); }
  catch { invalid('HTML 入口必须是 UTF-8 文本'); }
  manifest.entry = entry;
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  for (const file of manifest.files) await syncFile(path.join(directory, 'content', file.storage));
  await syncFile(path.join(directory, sourceKind === 'html' ? 'source.html' : 'source.zip'));
  await syncFile(path.join(directory, 'manifest.json'));
  return { sourceKind, entry, originalName, size: total };
}

export async function loadManifest(directory: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as PackageManifest;
}
export async function loadPackage(directory: string): Promise<DashboardPackage> {
  const manifest = await loadManifest(directory);
  let total = 0;
  const files: { path: string; mime: string; base64: string }[] = [];
  for (const item of manifest.files) {
    total += item.size;
    if (total > EXPANDED_LIMIT) throw new HttpError(413, '包展开大小超出限制');
    const bytes = await readFile(path.join(directory, 'content', item.storage));
    if (bytes.length !== item.size) throw new Error('大屏存储文件长度异常');
    files.push({ path: item.path, mime: item.mime, base64: bytes.toString('base64') });
  }
  return { entry: manifest.entry, files };
}
