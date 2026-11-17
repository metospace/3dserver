<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { createLights, disposeGltf, disposeObject, errorMessage, fetchGlb, frameObject, parseGlb } from '../three/loader'
import { resolvedTheme } from '../theme'

const props = defineProps<{ url: string; kind: 'asset' | 'scene' }>()
const emit = defineEmits<{ loaded: [payload: { animations: string[] }]; error: [message: string] }>()
const host = ref<HTMLDivElement>()
const loading = ref(false)
const problem = ref('')
const ready = ref(false)
const wireframe = ref(false)
const showGrid = ref(true)
const showAxes = ref(false)
const animationNames = ref<string[]>([])
const selectedClip = ref(0)
const playing = ref(false)
const speed = ref(1)
const time = ref(0)
const duration = ref(0)
const title = computed(() => props.kind === 'scene' ? '场景预览' : '资产预览')
const timeLabel = computed(() => `${time.value.toFixed(1)} / ${duration.value.toFixed(1)} 秒`)
let renderer: THREE.WebGLRenderer | undefined
let camera: THREE.PerspectiveCamera | undefined
let scene: THREE.Scene | undefined
let controls: OrbitControls | undefined
let grid: THREE.GridHelper | undefined
let axes: THREE.AxesHelper | undefined
let gltf: GLTF | undefined
let mixer: THREE.AnimationMixer | undefined
let action: THREE.AnimationAction | undefined
let resizeObserver: ResizeObserver | undefined
let controller: AbortController | undefined
let generation = 0
let frame = 0
let lastFrame = 0
let mounted = false
let contextLost = false
let modelRadius = 1
const originalWireframes = new Map<THREE.Material & { wireframe: boolean }, boolean>()
const gridDivisions = 20
const backgroundColor = new THREE.Color()
const gridCenterColor = new THREE.Color()
const gridLineColor = new THREE.Color()

function updateTheme(): void {
  const light = resolvedTheme.value === 'light'
  backgroundColor.set(light ? 0xeef1f7 : 0x20232e)
  gridCenterColor.set(light ? 0x9690a6 : 0x666079)
  gridLineColor.set(light ? 0xc4cbd8 : 0x353c50)
  if (!grid) return
  const colors = grid.geometry.getAttribute('color')
  // GridHelper stores four vertices per division; the middle division is the center cross.
  const centerStart = gridDivisions * 2
  for (let index = 0; index < colors.count; index++) {
    const color = index >= centerStart && index < centerStart + 4 ? gridCenterColor : gridLineColor
    colors.setXYZ(index, color.r, color.g, color.b)
  }
  colors.needsUpdate = true
}

function clearModel(): void {
  ready.value = false
  playing.value = false
  animationNames.value = []
  time.value = 0
  duration.value = 0
  action = undefined
  if (mixer && gltf) {
    mixer.stopAllAction()
    mixer.uncacheRoot(gltf.scene)
  }
  mixer = undefined
  originalWireframes.clear()
  if (gltf) {
    scene?.remove(gltf.scene)
    disposeGltf(gltf)
    gltf = undefined
  }
  if (grid) {
    scene?.remove(grid)
    disposeObject(grid)
    grid = undefined
  }
  if (axes) {
    scene?.remove(axes)
    disposeObject(axes)
    axes = undefined
  }
}

function fitCamera(): void {
  if (!gltf || !camera || !controls) return
  const { center, radius } = frameObject(gltf.scene, camera)
  modelRadius = radius
  controls.target.copy(center)
  controls.minDistance = radius * 0.01
  controls.maxDistance = radius * 100
  controls.update()
  controls.saveState()
}

function updateWireframe(): void {
  for (const [material, original] of originalWireframes) {
    material.wireframe = wireframe.value || original
    material.needsUpdate = true
  }
}

function selectAnimation(): void {
  if (!mixer || !gltf) return
  mixer.stopAllAction()
  const clip = gltf.animations[selectedClip.value]
  action = undefined
  time.value = 0
  duration.value = clip?.duration ?? 0
  if (!clip) {
    playing.value = false
    return
  }
  action = mixer.clipAction(clip)
  action.reset().setLoop(THREE.LoopRepeat, Infinity).play()
  action.paused = !playing.value
  mixer.timeScale = speed.value
  mixer.update(0)
}

function seek(event: Event): void {
  if (!action || !mixer) return
  const target = event.target as HTMLInputElement
  const next = Number(target.value)
  action.time = Math.min(Math.max(next, 0), duration.value)
  mixer.update(0)
  time.value = action.time
}

async function loadModel(): Promise<void> {
  const request = ++generation
  controller?.abort()
  const active = new AbortController()
  controller = active
  clearModel()
  problem.value = ''
  loading.value = false
  if (!props.url || !renderer || !scene || contextLost) return
  loading.value = true
  try {
    const data = await fetchGlb(props.url, active.signal)
    if (request !== generation || !mounted) return
    const loaded = await parseGlb(data, renderer, active.signal)
    if (request !== generation || !mounted || active.signal.aborted) {
      disposeGltf(loaded)
      return
    }
    gltf = loaded
    scene.add(loaded.scene)
    fitCamera()
    const bounds = new THREE.Box3().setFromObject(loaded.scene)
    const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3())
    grid = new THREE.GridHelper(modelRadius * 2.5, gridDivisions, gridCenterColor, gridLineColor)
    grid.position.set(center.x, bounds.isEmpty() ? 0 : bounds.min.y, center.z)
    grid.visible = showGrid.value
    axes = new THREE.AxesHelper(modelRadius * 0.6)
    axes.position.copy(center)
    axes.visible = showAxes.value
    scene.add(grid, axes)
    loaded.scene.traverse((object) => {
      const material = (object as THREE.Mesh).material
      if (!material) return
      for (const item of Array.isArray(material) ? material : [material]) {
        if ('wireframe' in item && typeof item.wireframe === 'boolean') {
          originalWireframes.set(item as THREE.Material & { wireframe: boolean }, item.wireframe)
        }
      }
    })
    updateWireframe()
    animationNames.value = loaded.animations.map((clip, index) => clip.name || `动画 ${index + 1}`)
    selectedClip.value = 0
    mixer = new THREE.AnimationMixer(loaded.scene)
    playing.value = loaded.animations.length > 0
    selectAnimation()
    ready.value = true
    emit('loaded', { animations: [...animationNames.value] })
  } catch (error) {
    if (request !== generation || active.signal.aborted || !mounted) return
    clearModel()
    problem.value = errorMessage(error)
    emit('error', problem.value)
  } finally {
    if (request === generation) loading.value = false
  }
}

function resize(): void {
  if (!host.value || !renderer || !camera) return
  const { width, height } = host.value.getBoundingClientRect()
  if (width <= 0 || height <= 0) return
  renderer.setSize(Math.round(width), Math.round(height), false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function draw(now: number): void {
  if (!mounted || contextLost || !renderer || !scene || !camera) return
  frame = window.requestAnimationFrame(draw)
  const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0
  lastFrame = now
  try {
    if (mixer && action) {
      mixer.update(delta)
      time.value = action.time
    }
    controls?.update()
    renderer.render(scene, camera)
  } catch (error) {
    window.cancelAnimationFrame(frame)
    controller?.abort()
    ++generation
    loading.value = false
    clearModel()
    problem.value = `无法渲染模型：${errorMessage(error)}`
    emit('error', problem.value)
  }
}

function onContextLost(event: Event): void {
  event.preventDefault()
  contextLost = true
  window.cancelAnimationFrame(frame)
  controller?.abort()
  ++generation
  loading.value = false
  clearModel()
  problem.value = '浏览器的三维绘图上下文已丢失，请等待恢复或刷新页面。'
  emit('error', problem.value)
}

function onContextRestored(): void {
  contextLost = false
  lastFrame = 0
  frame = window.requestAnimationFrame(draw)
  void loadModel()
}

function retry(): void {
  if (contextLost || !renderer) return
  window.cancelAnimationFrame(frame)
  lastFrame = 0
  frame = window.requestAnimationFrame(draw)
  void loadModel()
}

watch(() => props.url, () => { if (mounted) void loadModel() })
watch(selectedClip, selectAnimation)
watch(playing, (value) => { if (action) action.paused = !value })
watch(speed, (value) => { if (mixer) mixer.timeScale = value })
watch(wireframe, updateWireframe)
watch(showGrid, (value) => { if (grid) grid.visible = value })
watch(showAxes, (value) => { if (axes) axes.visible = value })
watch(resolvedTheme, updateTheme, { immediate: true })

onMounted(() => {
  mounted = true
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    renderer.domElement.setAttribute('aria-label', `${title.value}，拖动旋转、滚轮缩放、右键平移`)
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)
    host.value!.appendChild(renderer.domElement)
    scene = new THREE.Scene()
    scene.background = backgroundColor
    scene.add(createLights())
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000)
    camera.position.set(3, 2, 3)
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host.value!)
    resize()
    frame = window.requestAnimationFrame(draw)
    void loadModel()
  } catch (error) {
    problem.value = `无法启用三维预览，请检查浏览器 WebGL 支持：${errorMessage(error)}`
    emit('error', problem.value)
  }
})

onBeforeUnmount(() => {
  mounted = false
  ++generation
  controller?.abort()
  window.cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  clearModel()
  controls?.dispose()
  scene?.clear()
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }
})
</script>

<template>
  <section class="model-viewer" :aria-label="title">
    <div class="viewer-toolbar">
      <strong>{{ title }}</strong>
      <button type="button" :disabled="!ready" @click="fitCamera">适配 / 重置视角</button>
      <label><input v-model="wireframe" type="checkbox" :disabled="!ready">线框</label>
      <label><input v-model="showGrid" type="checkbox">网格</label>
      <label><input v-model="showAxes" type="checkbox">坐标轴</label>
    </div>
    <div class="viewer-stage">
      <div ref="host" class="viewer-canvas" />
      <div v-if="loading" class="viewer-overlay" role="status" aria-live="polite">正在加载并解码模型…</div>
      <div v-else-if="problem" class="viewer-overlay viewer-error" role="alert">
        <p>{{ problem }}</p>
        <button v-if="renderer && !contextLost" type="button" @click="retry">重新加载</button>
      </div>
      <div v-else-if="!url" class="viewer-overlay">请选择要预览的版本</div>
      <span v-if="ready" class="viewer-hint">左键旋转 · 滚轮缩放 · 右键平移 · 触屏双指缩放 / 平移</span>
    </div>
    <div v-if="ready && animationNames.length" class="viewer-animation">
      <label>动画
        <select v-model="selectedClip">
          <option v-for="(name, index) in animationNames" :key="index" :value="index">{{ name }}</option>
        </select>
      </label>
      <button type="button" :aria-pressed="playing" @click="playing = !playing">{{ playing ? '暂停' : '播放' }}</button>
      <label>速度
        <select v-model="speed">
          <option :value="0.25">0.25 倍</option>
          <option :value="0.5">0.5 倍</option>
          <option :value="1">1 倍</option>
          <option :value="1.5">1.5 倍</option>
          <option :value="2">2 倍</option>
        </select>
      </label>
      <label class="viewer-timeline">进度
        <input type="range" min="0" :max="duration" step="0.01" :value="time" :disabled="duration <= 0" aria-label="动画播放进度" @input="seek">
      </label>
      <output class="viewer-time">{{ timeLabel }}</output>
    </div>
    <p v-else-if="ready" class="viewer-no-animation">此{{ kind === 'scene' ? '场景' : '资产' }}没有动画片段。</p>
  </section>
</template>

<style scoped>
.model-viewer { overflow: hidden; background: var(--panel, #181b24); color: var(--text-secondary, #b9c0d3); }
.viewer-toolbar, .viewer-animation { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 14px; }
.viewer-toolbar { border-bottom: 1px solid var(--line, #303442); }
.viewer-toolbar strong { margin-right: auto; font-size: 11px; font-weight: 500; color: var(--muted, #8b95ac); }
.viewer-toolbar label, .viewer-animation label { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }
.model-viewer button, .model-viewer select { min-height: 30px; padding: 4px 9px; border: 1px solid var(--input-border, #3b4050); border-radius: 6px; background: var(--input-bg, #242837); color: var(--text, #c8bfdc); font: inherit; font-size: 11px; }
.model-viewer button { cursor: pointer; }
.model-viewer button:disabled { opacity: 0.5; cursor: default; }
.model-viewer button:hover:not(:disabled) { background: var(--hover-bg, #313449); }
.model-viewer input[type='checkbox'] { margin: 0; accent-color: var(--accent, #bba4f8); }
.viewer-stage { position: relative; height: clamp(300px, 52vh, 620px); min-height: 300px; background: var(--viewer-bg, #20232e); }
.viewer-canvas { width: 100%; height: 100%; }
.viewer-canvas :deep(canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
.viewer-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px; padding: 24px; text-align: center; background: var(--overlay-bg, #20232ee8); overflow-wrap: anywhere; }
.viewer-error { color: var(--error-text, #f29c9c); }
.viewer-error p { max-width: 600px; margin: 0; }
.viewer-hint { position: absolute; bottom: 9px; left: 10px; right: 10px; pointer-events: none; font-size: 10px; color: var(--muted, #8e99b0); text-align: center; text-shadow: 0 1px var(--hint-shadow, #000); }
.viewer-animation { border-top: 1px solid var(--line, #303442); }
.viewer-animation select { max-width: 210px; }
.viewer-timeline { flex: 1; min-width: 160px; }
.viewer-timeline input { flex: 1; min-width: 80px; accent-color: var(--accent, #bba4f8); }
.viewer-time { font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.viewer-no-animation { margin: 0; padding: 10px 14px; border-top: 1px solid var(--line, #303442); font-size: 11px; color: var(--muted, #7c8aa3); }
@media (max-width: 600px) { .viewer-toolbar, .viewer-animation { gap: 9px; padding: 10px; } .viewer-toolbar strong { width: 100%; } .viewer-stage { height: 340px; } .viewer-timeline { width: 100%; } }
</style>
