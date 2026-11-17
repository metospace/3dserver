<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { DashboardPackage } from '../contracts'
import { api } from '../api'
import AppIcon from './AppIcon.vue'
import { createUuid } from '../uuid'

const props = defineProps<{ versionId: string; title: string }>()
const emit = defineEmits<{ close: [] }>()
const frame = ref<HTMLIFrameElement>()
const loading = ref(true)
const problem = ref('')
const nonce = createUuid()
const abort = new AbortController()
let pack: DashboardPackage | undefined
let shellReady = false
let posted = false
let timer: number | undefined
function sendPackage() {
  if (!shellReady || !pack || posted || !frame.value?.contentWindow) return
  posted = true
  frame.value.contentWindow.postMessage({ kind: 'dashboard-init', nonce, package: pack }, '*')
  pack = undefined
}
function receive(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.origin !== 'null' || !event.data || event.data.nonce !== nonce) return
  if (event.data.kind === 'dashboard-shell-ready') { shellReady = true; sendPackage() }
  if (event.data.kind === 'dashboard-ready') { loading.value = false; window.clearTimeout(timer) }
  if (event.data.kind === 'dashboard-error') {
    loading.value = false
    problem.value = typeof event.data.message === 'string' ? event.data.message.slice(0, 500) : '看板脚本运行失败'
    window.clearTimeout(timer)
  }
}
onMounted(async () => {
  window.addEventListener('message', receive)
  timer = window.setTimeout(() => { loading.value = false; problem.value = '隔离预览启动超时，请检查模板入口及资源是否完整。' }, 60_000)
  try {
    pack = await api<DashboardPackage>(`/versions/${props.versionId}/package`, { signal: abort.signal })
    if (!abort.signal.aborted) sendPackage()
  } catch (error) {
    if (!abort.signal.aborted) { loading.value = false; problem.value = error instanceof Error ? error.message : '看板读取失败'; window.clearTimeout(timer) }
  }
})
onBeforeUnmount(() => { abort.abort(); window.clearTimeout(timer); window.removeEventListener('message', receive); pack = undefined })
</script>

<template>
  <div class="modal-overlay dashboard-preview-overlay" @click.self="emit('close')">
    <section class="dashboard-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="dashboard-preview-title">
      <header><div><h2 id="dashboard-preview-title">{{ title }} · 隔离运行预览</h2><p>仅执行当前固定版本的本地静态依赖，不共享登录信息，不连接外部业务数据。</p></div><button class="icon-button" aria-label="关闭运行预览" @click="emit('close')"><AppIcon name="close" /></button></header>
      <p v-if="problem" class="error-box" role="alert">{{ problem }}</p>
      <div class="dashboard-preview-stage"><iframe ref="frame" :src="`/dashboard-preview.html#${nonce}`" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="title + ' 隔离看板'" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe><div v-if="loading" class="dashboard-preview-loading" role="status"><span class="spinner"></span>正在准备隔离看板…</div></div>
      <footer>模板不具备父页面、Cookie、顶层导航或弹窗权限；不运行服务端脚本或构建命令。</footer>
    </section>
  </div>
</template>

<style scoped>
.dashboard-preview-dialog{width:min(1500px,96vw);max-height:95dvh;background:var(--panel);border:1px solid var(--line-strong);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 80px var(--shadow-large)}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}h2{font-size:17px}header p,footer{font-size:11px;color:var(--muted);line-height:1.8;margin-top:6px}.dashboard-preview-stage{position:relative;aspect-ratio:16/9;max-height:72dvh;background:#071329;overflow:hidden;border-radius:7px}.dashboard-preview-stage iframe{width:100%;height:100%;border:0;display:block}.dashboard-preview-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--panel);color:var(--muted)}
@media(max-width:760px){.dashboard-preview-dialog{padding:12px;width:100%}.dashboard-preview-stage{aspect-ratio:auto;height:65dvh}h2{font-size:14px}}
</style>
