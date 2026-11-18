import { open, readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { MODEL_MAX_BYTES, MODEL_MAX_MB } from '../src/limits.js';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string,
    public readonly code?: 'VERSION_CONFLICT' | 'IDEMPOTENCY_MISMATCH' | 'RECORD_DELETED',
    public readonly currentRevision?: number) { super(message); }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求内容必须是对象');
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max: number, min = 0, trim = true): string {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}必须是文本`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max || result.includes('\0')) throw new HttpError(400, `${label}长度必须为 ${min}–${max} 个字符，且不能包含空字符`);
  return result;
}

export function tags(value: unknown, multipart = false): string[] {
  if (value === undefined) return [];
  if (multipart) {
    if (typeof value !== 'string' || value.length > 8192) throw new HttpError(400, '标签必须是 JSON 字符串数组');
    try { value = JSON.parse(value); } catch { throw new HttpError(400, '标签必须是 JSON 字符串数组'); }
  }
  if (!Array.isArray(value) || value.length > 30) throw new HttpError(400, '标签必须是最多 30 项的数组');
  return [...new Set(value.map(item => text(item, '标签', 60, 1)))];
}

export function originalFilename(value: string): string {
  // Multer receives browser multipart filenames as Latin-1; recover UTF-8 only if it round-trips.
  const bytes = Buffer.from(value, 'latin1');
  const utf8 = bytes.toString('utf8');
  const decoded = Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : value;
  const safe = decoded.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240).trim();
  return safe || '模型.glb';
}

export async function validateGlb(filename: string, size: number): Promise<void> {
  if (!Number.isSafeInteger(size) || size < 20 || size > MODEL_MAX_BYTES) throw new HttpError(400, `GLB 文件必须至少为 20 字节且不超过 ${MODEL_MAX_MB} MiB（实际 ${size} 字节）`);
  const handle = await open(filename, 'r');
  try {
    const actualSize = (await handle.stat()).size;
    if (actualSize !== size) throw new HttpError(400, `GLB 文件长度不符：上传报告 ${size} 字节，磁盘实际 ${actualSize} 字节，文件可能已截断`);
    const header = Buffer.alloc(12);
    if ((await handle.read(header, 0, 12, 0)).bytesRead !== 12 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2) {
      throw new HttpError(400, '文件不是有效的 GLB 2.0');
    }
    const declaredSize = header.readUInt32LE(8);
    if (declaredSize !== actualSize) throw new HttpError(400, `GLB 文件长度不符：文件头声明 ${declaredSize} 字节，实际 ${actualSize} 字节，文件可能已截断`);
    let offset = 12;
    let chunks = 0;
    let binLength: number | undefined;
    let json: Record<string, unknown> | undefined;
    const chunkHeader = Buffer.alloc(8);
    while (offset < size) {
      if (++chunks > 1024 || offset + 8 > size || (await handle.read(chunkHeader, 0, 8, offset)).bytesRead !== 8) throw new HttpError(400, 'GLB 分块数量或长度无效');
      const length = chunkHeader.readUInt32LE(0);
      const type = chunkHeader.readUInt32LE(4);
      if (length % 4 !== 0) throw new HttpError(400, `GLB 分块 ${chunks} 长度 ${length} 字节未按 4 字节对齐`);
      if (offset + 8 + length > size) throw new HttpError(400, `GLB 分块 ${chunks}（${type === 0x004e4942 ? 'BIN' : 'JSON/扩展'}）不完整：声明 ${length} 字节，实际剩余 ${size - offset - 8} 字节`);
      if (chunks === 1 && type !== 0x4e4f534a) throw new HttpError(400, 'GLB 第一分块必须为 JSON');
      if (type === 0x4e4f534a) {
        if (json || length === 0 || length > 32 * 1024 * 1024) throw new HttpError(400, 'GLB 必须只有一个 JSON 分块，且不超过 32 MiB');
        const bytes = Buffer.alloc(length);
        if ((await handle.read(bytes, 0, length, offset + 8)).bytesRead !== length) throw new HttpError(400, 'GLB JSON 分块不完整');
        try {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          json = objectBody(JSON.parse(content));
        } catch { throw new HttpError(400, 'GLB JSON 内容无效'); }
      } else if (type === 0x004e4942) {
        if (binLength !== undefined || chunks !== 2) throw new HttpError(400, 'GLB 二进制分块必须唯一且位于 JSON 之后');
        binLength = length;
      }
      offset += 8 + length;
    }
    if (!json || offset !== size) throw new HttpError(400, 'GLB 缺少完整 JSON 分块');
    const asset = objectBody(json.asset);
    if (asset.version !== '2.0') throw new HttpError(400, '仅支持 glTF 2.0');
    // Bound subsequent tree processing and prohibit every URI-bearing extension from escaping the GLB.
    const pending: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++nodes > 500000 || depth > 64) throw new HttpError(400, 'GLB JSON 结构过深或过于复杂');
      if (!value || typeof value !== 'object') continue;
      for (const [key, child] of Object.entries(value)) {
        if (key.toLowerCase() === 'uri' && (typeof child !== 'string' || !/^data:/i.test(child))) throw new HttpError(400, 'GLB 必须自包含，不能引用外部文件或网络 URI');
        if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
      }
    }
    for (const field of ['buffers', 'images', 'bufferViews', 'accessors', 'meshes', 'nodes', 'scenes', 'materials', 'textures', 'samplers', 'animations', 'skins']) {
      if (json[field] !== undefined && !Array.isArray(json[field])) throw new HttpError(400, `GLB ${field} 必须是数组`);
    }
    const buffers = (json.buffers ?? []) as unknown[];
    for (let i = 0; i < buffers.length; i++) {
      const buffer = objectBody(buffers[i]);
      // Khronos buffer.schema.json requires byteLength >= 1; empty scenes omit buffers instead.
      if (!Number.isSafeInteger(buffer.byteLength) || (buffer.byteLength as number) < 1 || (buffer.byteLength as number) > MODEL_MAX_BYTES) throw new HttpError(400, `GLB buffers[${i}].byteLength 必须为 1–${MODEL_MAX_BYTES} 字节，实际为 ${String(buffer.byteLength)}`);
      if (buffer.uri === undefined) {
        if (i !== 0) throw new HttpError(400, `GLB buffers[${i}] 缺少 URI：仅 buffers[0] 可使用 BIN 分块`);
        if (binLength === undefined) throw new HttpError(400, `GLB buffers[0] 声明 ${buffer.byteLength} 字节，但缺少 BIN 分块`);
        if ((buffer.byteLength as number) > binLength) throw new HttpError(400, `GLB buffers[0] 声明 ${buffer.byteLength} 字节，BIN 实际只有 ${binLength} 字节，二进制数据已截断`);
        // https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-stored-buffer requires BIN >= byteLength, with no upper tail cap.
        // GLTFLoader uses the BIN body and slices declared bufferViews; unused tail bytes stay unused.
      }
    }
    const bufferViews = (json.bufferViews ?? []) as unknown[];
    for (let i = 0; i < bufferViews.length; i++) {
      const view = objectBody(bufferViews[i]);
      const index = view.buffer;
      const start = view.byteOffset ?? 0;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= buffers.length) throw new HttpError(400, `GLB bufferViews[${i}].buffer 索引无效：${String(index)}`);
      const bufferLength = objectBody(buffers[index as number]).byteLength as number;
      if (!Number.isSafeInteger(start) || (start as number) < 0 || !Number.isSafeInteger(view.byteLength) || (view.byteLength as number) < 1 || (start as number) > bufferLength || (view.byteLength as number) > bufferLength - (start as number)) throw new HttpError(400, `GLB bufferViews[${i}] 越界：偏移 ${String(start)}，长度 ${String(view.byteLength)}，buffers[${String(index)}] 声明 ${bufferLength} 字节`);
    }
    for (const item of (json.images ?? []) as unknown[]) {
      const image = objectBody(item);
      if (image.uri === undefined && (!Number.isInteger(image.bufferView) || (image.bufferView as number) < 0 || (image.bufferView as number) >= ((json.bufferViews ?? []) as unknown[]).length)) throw new HttpError(400, 'GLB 图片必须包含有效的内嵌数据');
    }
  } finally { await handle.close(); }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

export async function validatePng(filename: string): Promise<void> {
  const file = await readFile(filename);
  if (file.length < 57 || file.length > 2 * 1024 * 1024 || !file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HttpError(400, '缩略图必须是有效 PNG，且不超过 2 MB');
  let offset = 8;
  let width = 0, height = 0, bits = 0, interlace = 0;
  let colorType = 0, bitDepth = 0, paletteEntries = 0;
  let ended = false, idatEnded = false;
  const compressed: Buffer[] = [];
  while (offset < file.length) {
    if (offset + 12 > file.length) throw new HttpError(400, 'PNG 分块不完整');
    const length = file.readUInt32BE(offset);
    if (offset + 12 + length > file.length) throw new HttpError(400, 'PNG 分块长度无效');
    const type = file.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new HttpError(400, 'PNG 分块类型无效');
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) crc = crcTable[(crc ^ file[i]) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== file.readUInt32BE(offset + 8 + length)) throw new HttpError(400, 'PNG 校验和无效');
    if (offset === 8 && type !== 'IHDR') throw new HttpError(400, 'PNG 缺少文件头');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new HttpError(400, 'PNG 文件头无效');
      width = file.readUInt32BE(offset + 8); height = file.readUInt32BE(offset + 12);
      const depth = file[offset + 16], color = file[offset + 17];
      colorType = color; bitDepth = depth;
      const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      interlace = file[offset + 20];
      if (!width || !height || width > 2048 || height > 2048 || !allowed[color]?.includes(depth) || file[offset + 18] !== 0 || file[offset + 19] !== 0 || interlace > 1) throw new HttpError(400, 'PNG 尺寸或编码无效，最大支持 2048×2048');
      bits = depth * ([1, 0, 3, 1, 2, 0, 4][color] ?? 0);
    } else if (type === 'IDAT') {
      if (colorType === 3 && !paletteEntries) throw new HttpError(400, '索引 PNG 缺少调色板');
      if (idatEnded) throw new HttpError(400, 'PNG 图像分块不连续');
      compressed.push(file.subarray(offset + 8, offset + 8 + length));
    } else {
      if (compressed.length) idatEnded = true;
      if (type === 'IEND') {
        if (length !== 0 || offset + 12 !== file.length || !compressed.length) throw new HttpError(400, 'PNG 结束分块无效');
        ended = true;
      } else if (type === 'PLTE') {
        if (paletteEntries || compressed.length || colorType === 0 || colorType === 4 || length < 3 || length % 3 !== 0 || length > 768 || (colorType === 3 && length / 3 > 2 ** bitDepth)) throw new HttpError(400, 'PNG 调色板无效');
        paletteEntries = length / 3;
      } else if (type === 'tRNS') {
        if (compressed.length || (colorType === 0 ? length !== 2 : colorType === 2 ? length !== 6 : colorType === 3 ? !paletteEntries || length > paletteEntries : true)) throw new HttpError(400, 'PNG 透明度分块无效');
      } else if ((file[offset + 4] & 32) === 0) throw new HttpError(400, 'PNG 包含未知关键分块');
    }
    offset += 12 + length;
  }
  if (!ended) throw new HttpError(400, 'PNG 缺少结束分块');
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => ({ width: Math.max(0, Math.ceil((width - x) / dx)), height: Math.max(0, Math.ceil((height - y) / dy)) }));
  const expected = rows.reduce((sum, row) => sum + (row.width ? (1 + Math.ceil(row.width * bits / 8)) * row.height : 0), 0);
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); }
  catch { throw new HttpError(400, 'PNG 压缩数据无效'); }
  if (inflated.length !== expected) throw new HttpError(400, 'PNG 像素数据长度无效');
  let cursor = 0;
  for (const row of rows) {
    if (!row.width) continue;
    const stride = 1 + Math.ceil(row.width * bits / 8);
    for (let y = 0; y < row.height; y++, cursor += stride) if (inflated[cursor] > 4) throw new HttpError(400, 'PNG 像素滤波类型无效');
  }
}
