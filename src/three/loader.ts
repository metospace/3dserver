import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { MODEL_MAX_BYTES, MODEL_MAX_MB, MODEL_TIMEOUT_MS } from '../limits'

export const MAX_GLB_BYTES = MODEL_MAX_BYTES
const LOAD_TIMEOUT = MODEL_TIMEOUT_MS

export function abortError(): DOMException {
  return new DOMException('加载已取消', 'AbortError')
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 300)
  return '无法读取此 GLB 文件，请检查文件是否完整以及浏览器是否支持其压缩格式。'
}

/** Validate before GLTFLoader can initiate any model-dependent network request. */
function validateGlb(data: ArrayBuffer): void {
  if (data.byteLength < 20 || data.byteLength > MAX_GLB_BYTES) {
    throw new Error(`GLB 文件为空、损坏或超过 ${MODEL_MAX_MB} MB 限制。`)
  }
  const view = new DataView(data)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) {
    throw new Error('只支持完整的 GLB 2.0 文件。')
  }
  const length = view.getUint32(12, true)
  if (view.getUint32(16, true) !== 0x4e4f534a || length > 32 * 1024 * 1024 || length > data.byteLength - 20) {
    throw new Error('GLB 文件的 JSON 数据无效。')
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, length)))
  } catch {
    throw new Error('GLB 文件的 JSON 数据无法解析。')
  }
  // Inspect extension properties too: no extension may bypass the self-contained rule.
  const pending: unknown[] = [json]
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    for (const [key, value] of Object.entries(node)) {
      if (key === 'uri' && typeof value === 'string' && !/^(data:|blob:)/i.test(value)) {
        throw new Error('GLB 必须自包含，不能引用外部图片或缓冲区。')
      }
      if (value && typeof value === 'object') pending.push(value)
    }
  }
}

function allowLocalResource(resource: string): string {
  if (/^(data:|blob:)/i.test(resource)) return resource
  const url = new URL(resource, window.location.href)
  if (url.origin === window.location.origin && /^\/decoders\/(draco|basis)\/[^/]+$/.test(url.pathname)) {
    return url.href
  }
  throw new Error('已阻止 GLB 加载外部资源。')
}

export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const images = new Set<ImageBitmap>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    if (mesh.material) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value)
        }
        if (material instanceof THREE.ShaderMaterial) {
          for (const uniform of Object.values(material.uniforms)) {
            if (uniform.value instanceof THREE.Texture) textures.add(uniform.value)
          }
        }
      }
    }
    if (object instanceof THREE.SkinnedMesh && object.skeleton.boneTexture) {
      textures.add(object.skeleton.boneTexture)
    }
  })
  for (const texture of textures) {
    const data = texture.source?.data
    for (const image of Array.isArray(data) ? data : [data]) {
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) images.add(image)
    }
    texture.dispose()
  }
  for (const image of images) image.close()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

export function disposeGltf(gltf: GLTF): void {
  // A synthetic parent deduplicates resources shared by the GLB's scenes.
  const root = new THREE.Group()
  for (const scene of gltf.scenes) root.add(scene)
  if (!gltf.scenes.includes(gltf.scene)) root.add(gltf.scene)
  disposeObject(root)
  root.clear()
}

/** Fetch only the authenticated same-origin model endpoint; redirects stay local. */
export async function fetchGlb(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin) throw new Error('只允许加载本站的 GLB 文件。')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const timer = window.setTimeout(abort, LOAD_TIMEOUT)
  try {
    const response = await fetch(target, { signal: controller.signal, credentials: 'same-origin', redirect: 'error' })
    if (!response.ok) throw new Error(`模型加载失败（${response.status}），请检查登录状态或访问权限。`)
    const declared = Number(response.headers.get('content-length'))
    if (declared > MAX_GLB_BYTES) throw new Error(`GLB 文件超过 ${MODEL_MAX_MB} MB 限制。`)
    if (!response.body) throw new Error('模型文件内容为空。')
    const reader = response.body.getReader()
    // Normal authenticated file responses have Content-Length. Fill one allocation rather than retain a second model-sized copy.
    const bounded = Number.isSafeInteger(declared) && declared > 0 ? new Uint8Array(declared) : undefined
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > MAX_GLB_BYTES || (bounded && size + value.byteLength > bounded.byteLength)) {
        await reader.cancel()
        throw new Error('模型传输长度超出声明或文件大小限制。')
      }
      if (bounded) bounded.set(value, size)
      else chunks.push(value)
      size += value.byteLength
    }
    if (bounded) {
      if (size !== bounded.byteLength) throw new Error('模型文件传输不完整，请重新加载。')
      return bounded.buffer
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result.buffer
  } catch (error) {
    if (signal.aborted) throw abortError()
    if (controller.signal.aborted) throw new Error('模型下载超时，请检查连接后重试。')
    throw error
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** One loader bundle per operation: workers are always terminated on completion. */
export async function parseGlb(data: ArrayBuffer, renderer: THREE.WebGLRenderer, signal?: AbortSignal): Promise<GLTF> {
  if (signal?.aborted) throw abortError()
  validateGlb(data)
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(allowLocalResource)
  const draco = new DRACOLoader(manager).setDecoderPath('/decoders/draco/')
  const ktx2 = new KTX2Loader(manager).setTranscoderPath('/decoders/basis/').detectSupport(renderer)
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder)
  let finished = false
  let timer: number | undefined
  let onAbort: (() => void) | undefined
  try {
    const { promise, resolve, reject } = Promise.withResolvers<GLTF>()
    const fail = (error: unknown) => {
      if (finished) return
      finished = true
      reject(error)
    }
    onAbort = () => fail(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = window.setTimeout(() => fail(new Error('模型解码超时，文件可能过于复杂或已损坏。')), LOAD_TIMEOUT)
    loader.parse(data, '', (gltf) => {
      if (finished || signal?.aborted) {
        disposeGltf(gltf)
        return
      }
      finished = true
      resolve(gltf)
    }, (error) => fail(error instanceof Error ? error : new Error('GLB 解码失败。')))
    return await promise
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    draco.dispose()
    ktx2.dispose()
  }
}

/** Frame with the camera; never rewrite an imported node's transform. */
export function frameObject(root: THREE.Object3D, camera: THREE.PerspectiveCamera): { center: THREE.Vector3; radius: number } {
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  const center = new THREE.Vector3()
  let radius = 1
  if (!bounds.isEmpty()) {
    bounds.getCenter(center)
    radius = bounds.getSize(new THREE.Vector3()).length() / 2
    if (!Number.isFinite(radius) || !center.toArray().every(Number.isFinite)) {
      throw new Error('模型包含无效的空间坐标。')
    }
    radius = Math.max(radius, 0.001)
  }
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2)
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.15
  camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance))
  camera.near = Math.max(radius / 1000, 0.000001)
  camera.far = Math.max(distance + radius * 100, camera.near * 100)
  camera.lookAt(center)
  camera.updateProjectionMatrix()
  return { center, radius }
}

export function createLights(): THREE.Group {
  const lights = new THREE.Group()
  lights.add(new THREE.HemisphereLight(0xe5efff, 0x6d665d, 2.5))
  const key = new THREE.DirectionalLight(0xffffff, 3)
  key.position.set(5, 8, 6)
  lights.add(key)
  const fill = new THREE.DirectionalLight(0xc7dcff, 1.5)
  fill.position.set(-5, 2, -4)
  lights.add(fill)
  return lights
}
