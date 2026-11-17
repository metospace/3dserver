import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { createLights, disposeGltf, frameObject, MAX_GLB_BYTES, parseGlb } from './loader'

/** Render locally; no upload or external model-resource requests are performed. */
export async function generateThumbnail(file: File): Promise<Blob> {
  if (file.size > MAX_GLB_BYTES || file.size < 20) throw new Error('GLB 文件大小无效。')
  const canvas = document.createElement('canvas')
  let renderer: THREE.WebGLRenderer | undefined
  let gltf: GLTF | undefined
  let mixer: THREE.AnimationMixer | undefined
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x20232e)
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setSize(256, 256, false)
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
    renderer.render(scene, camera)
    const { promise, resolve, reject } = Promise.withResolvers<Blob>()
    const timer = window.setTimeout(() => reject(new Error('缩略图生成超时。')), 10_000)
    canvas.toBlob((blob) => {
      window.clearTimeout(timer)
      if (blob) resolve(blob)
      else reject(new Error('浏览器无法生成 PNG 缩略图。'))
    }, 'image/png')
    return await promise
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
