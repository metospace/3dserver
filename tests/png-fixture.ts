import { deflateSync } from 'node:zlib'

/** A real deterministic 256x256 RGBA PNG, not a signature-only image. */
export function screenshotPng() {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name)
    const output = Buffer.alloc(data.length + 12)
    output.writeUInt32BE(data.length, 0); type.copy(output, 4); data.copy(output, 8)
    output.writeUInt32BE(crc(Buffer.concat([type, data])), output.length - 4)
    return output
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((256 * 4 + 1) * 256)
  for (let row = 0; row < 256; row++) for (let col = 0; col < 256; col++) {
    const offset = row * (256 * 4 + 1) + 1 + col * 4
    pixels[offset] = 32; pixels[offset + 1] = 96; pixels[offset + 2] = 168; pixels[offset + 3] = 255
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
