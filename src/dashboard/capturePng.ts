// Busboy treats reaching its native upload limit as truncation.
const maxPngBytes = 2 * 1024 * 1024 - 1
const maxPngDimension = 2048
const pngType = 'image/png'

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const { promise, resolve, reject } = Promise.withResolvers<Blob>()
  canvas.toBlob(png => {
    if (png?.type === pngType && png.size) resolve(png)
    else reject(new Error('浏览器无法生成 PNG 截图。'))
  }, pngType)
  return promise
}

export async function encodeDashboardPng(source: HTMLCanvasElement): Promise<Blob> {
  if (!source.width || !source.height || Math.max(source.width, source.height) > maxPngDimension) {
    throw new Error('看板截图尺寸无效。')
  }
  const png = await encode(source)
  if (png.size <= maxPngBytes) return png

  // A second encode at no more than 700×700 keeps even densely colored previews small.
  const scale = 700 / Math.max(source.width, source.height)
  const smaller = document.createElement('canvas')
  smaller.width = Math.max(1, Math.floor(source.width * scale))
  smaller.height = Math.max(1, Math.floor(source.height * scale))
  const context = smaller.getContext('2d')
  if (!context) throw new Error('浏览器无法缩放看板截图。')
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, smaller.width, smaller.height)
  const reduced = await encode(smaller)
  if (reduced.size > maxPngBytes) throw new Error('看板截图超过 2 MiB，无法保存。')
  return reduced
}

/** The dashboard runs untrusted code. Decode only a bounded PNG and return browser-encoded pixels. */
export async function normalizeDashboardPng(input: unknown): Promise<Blob> {
  const invalid = '隔离预览未返回有效的 PNG 截图。'
  if (!(input instanceof Blob) || input.type !== pngType || input.size < 57 || input.size > maxPngBytes) {
    throw new Error(invalid)
  }
  const header = new DataView(await input.slice(0, 24).arrayBuffer())
  const width = header.getUint32(16), height = header.getUint32(20)
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a ||
      header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 ||
      !width || !height || width > maxPngDimension || height > maxPngDimension) {
    throw new Error(invalid)
  }
  const bitmap = await createImageBitmap(input).catch(() => { throw new Error(invalid) })
  try {
    if (bitmap.width !== width || bitmap.height !== height) throw new Error(invalid)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法处理看板截图。')
    context.drawImage(bitmap, 0, 0)
    return await encodeDashboardPng(canvas)
  } finally {
    bitmap.close()
  }
}
