import { snapdom } from '@zumer/snapdom'
import { encodeDashboardPng } from './capturePng'

export async function captureDashboardViewport(signal: AbortSignal): Promise<Blob> {
  const width = window.innerWidth, height = window.innerHeight
  if (!width || !height) throw new Error('看板预览没有可截图的区域。')
  // Reconstruct the live viewport in the same opaque document; never ask the host to fetch its assets.
  const snapshot = await snapdom(document.documentElement, {
    clip: 'viewport',
    dpr: 1,
    width: Math.min(width, 1600),
    invalidate: true,
    fast: false,
    exclude: 'script, iframe, frame, object, embed, portal',
    excludeMode: 'remove',
  })
  signal.throwIfAborted()
  const canvas = await snapshot.toCanvas()
  try {
    signal.throwIfAborted()
    const failure = snapshot.warnings.find(warning => warning.code !== 'raster-clamp' && warning.code !== 'canvas-clamp')
    if (failure) throw new Error('部分看板内容无法生成截图，请改用 PNG 文件上传。')
    return await encodeDashboardPng(canvas)
  } finally {
    canvas.width = canvas.height = 1
  }
}
