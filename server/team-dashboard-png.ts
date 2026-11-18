import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { deflate, inflate } from 'node:zlib';
import { HttpError } from './validation.js';

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const unzip = promisify(inflate), zip = promisify(deflate);
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i & 1 ? 0xedb88320 : 0) ^ (i >>> 1);
  return i;
});
function crc32(buffer: Buffer, start: number, end: number) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ buffer[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result, 4, result.length - 4), result.length - 4);
  return result;
}
export function decodeBase64(value: unknown, limit: number, message: string): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new HttpError(400, message);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== value) throw new HttpError(400, message);
  return bytes;
}

export async function screenshotPng(base64: unknown) {
  const input = decodeBase64(base64, MAX_SCREENSHOT_BYTES, '截图必须为不超过 8 MiB 的 PNG');
  const bad = (message: string): never => { throw new HttpError(400, message); };
  if (input.length < 45 || !input.subarray(0, 8).equals(signature) || input.readUInt32BE(8) !== 13 || input.toString('latin1', 12, 16) !== 'IHDR') bad('只接受有效的 PNG 截图');
  const width = input.readUInt32BE(16), height = input.readUInt32BE(20);
  const channels = [1, 0, 3, 0, 2, 0, 4][input[25]];
  if (width < 320 || height < 180 || width > 7680 || height > 4320 || width * height > 16777216 || !channels || input[24] !== 8 || input[26] || input[27] || input[28]) bad('截图须为 320×180 至 7680×4320、最多 1600 万像素的非交错 8 位 PNG');
  const data: Buffer[] = [];
  let dataEnded = false, ended = false;
  for (let offset = 8; offset < input.length;) {
    if (offset + 12 > input.length) bad('PNG 数据不完整');
    const length = input.readUInt32BE(offset), end = offset + 12 + length, type = input.toString('latin1', offset + 4, offset + 8);
    if (end > input.length || !/^[A-Za-z]{4}$/.test(type) || crc32(input, offset + 4, end - 4) !== input.readUInt32BE(end - 4)) bad('PNG 无效或 CRC 校验失败');
    if (type === 'IHDR' && offset === 8) { /* Header checked above. */ }
    else if (type === 'IDAT') {
      if (dataEnded) bad('PNG 像素块必须连续');
      data.push(input.subarray(offset + 8, end - 4));
    } else if (type === 'IEND') {
      if (length || end !== input.length) bad('PNG 尾部无效');
      ended = true;
    } else if (!/^[a-z]/.test(type) || type === 'acTL' || type === 'fcTL' || type === 'fdAT' || type === 'tRNS') bad('PNG 包含不支持的关键数据、动画或透明色表');
    if (data.length && type !== 'IDAT') dataEnded = true;
    offset = end;
  }
  if (!ended || !data.length) bad('PNG 数据不完整');
  const rowBytes = width * channels + 1, expected = height * rowBytes;
  const pixels = await unzip(data.length === 1 ? data[0] : Buffer.concat(data), { maxOutputLength: expected })
    .catch(() => bad('PNG 无法完整解码'));
  if (pixels.length !== expected) bad('PNG 像素数据不完整');
  for (let i = 0; i < expected; i += rowBytes) if (pixels[i] > 4) bad('PNG 像素过滤器无效');
  // Re-encode only validated scanlines; no supplied metadata or unused compressed bytes survive.
  const compressed = await zip(pixels);
  if (compressed.length + 57 > MAX_SCREENSHOT_BYTES) bad('净化后的截图超过 8 MiB');
  const bytes = Buffer.concat([signature, chunk('IHDR', input.subarray(16, 29)), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), width, height };
}
