/** UUID v4 using Web Crypto available on both HTTPS and ordinary intranet HTTP. */
export function createUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  let uuid = ''
  for (let index = 0; index < bytes.length; index++) {
    if (index === 4 || index === 6 || index === 8 || index === 10) uuid += '-'
    uuid += bytes[index]!.toString(16).padStart(2, '0')
  }
  return uuid
}
