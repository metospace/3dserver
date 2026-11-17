import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { createLights, disposeGltf, errorMessage, frameObject, MAX_GLB_BYTES, parseGlb } from './loader'

export interface ThumbnailCapture {
  captureThumbnail(): Promise<Blob>
}

const THUMBNAIL_SIZE = 256
let thumbnailQueue: Promise<void> = Promise.resolve()

/** Copy the fresh frame synchronously: WebGL may clear its drawing buffer before an async callback. */
export async function captureRenderedThumbnail(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<Blob> {
  const source = renderer.domElement
  if (renderer.getContext().isContextLost()) throw new Error('浏览器的三维绘图上下文已丢失，无法生成缩略图。')
  if (!source.width || !source.height) throw new Error('预览画布没有有效尺寸，无法生成缩略图。')
  const canvas = document.createElement('canvas')
  canvas.width = THUMBNAIL_SIZE
  canvas.height = THUMBNAIL_SIZE
  let timer: number | undefined
  try {
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' })
    if (!context) throw new Error('浏览器无法创建缩略图画布。')
    context.fillStyle = scene.background instanceof THREE.Color ? scene.background.getStyle(THREE.SRGBColorSpace) : '#20232e'
    context.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    const scale = Math.min(THUMBNAIL_SIZE / source.width, THUMBNAIL_SIZE / source.height)
    const width = Math.max(1, Math.round(source.width * scale))
    const height = Math.max(1, Math.round(source.height * scale))
    renderer.render(scene, camera)
    if (renderer.getContext().isContextLost()) throw new Error('浏览器的三维绘图上下文已丢失，无法生成缩略图。')
    context.drawImage(source, (THUMBNAIL_SIZE - width) / 2, (THUMBNAIL_SIZE - height) / 2, width, height)
    const { promise, resolve, reject } = Promise.withResolvers<Blob>()
    timer = window.setTimeout(() => reject(new Error('浏览器生成 PNG 缩略图超时。')), 10_000)
    canvas.toBlob((blob) => {
      if (blob?.size && blob.type === 'image/png') resolve(blob)
      else reject(new Error('浏览器无法生成有效的 PNG 缩略图。'))
    }, 'image/png')
    return await promise
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    canvas.width = 1
    canvas.height = 1
  }
}

/** Render locally; serialize jobs so overlapping uploads never hold multiple thumbnail contexts. */
export function generateThumbnail(file: File): Promise<Blob> {
  const result = thumbnailQueue.then(() => renderFileThumbnail(file))
  thumbnailQueue = result.then(() => undefined, () => undefined)
  return result
}

async function renderFileThumbnail(file: File): Promise<Blob> {
  if (file.size < 20) throw new Error('GLB 文件不足 20 字节，无法生成缩略图。')
  if (file.size > MAX_GLB_BYTES) throw new Error(`GLB 文件超过 ${Math.floor(MAX_GLB_BYTES / 1024 / 1024)} MB 限制，无法生成缩略图。`)
  const canvas = document.createElement('canvas')
  let renderer: THREE.WebGLRenderer | undefined
  let gltf: GLTF | undefined
  let mixer: THREE.AnimationMixer | undefined
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x20232e)
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    renderer.setPixelRatio(1)
    renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    gltf = await parseGlb(await file.arrayBuffer(), renderer)
    scene.add(gltf.scene, createLights())
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(gltf.scene)
      mixer.clipAction(gltf.animations[0]!).play()
      mixer.update(0)
    }
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000)
    frameObject(gltf.scene, camera)
    return await captureRenderedThumbnail(renderer, scene, camera)
  } catch (error) {
    throw new Error(`缩略图生成失败：${errorMessage(error)}`)
  } finally {
    if (mixer && gltf) {
      mixer.stopAllAction()
      mixer.uncacheRoot(gltf.scene)
    }
    if (gltf) disposeGltf(gltf)
    scene.clear()
    renderer?.dispose()
    renderer?.forceContextLoss()
    canvas.width = 1
    canvas.height = 1
  }
}
