<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, ApiError, bytes, json, splitTags, upload } from '../api'
import type { Category, Detail, Kind, ModelRecord, Version } from '../contracts'
import { generateThumbnail } from '../three/thumbnail'
import { createUuid } from '../uuid'
import { MODEL_MAX_BYTES, MODEL_MAX_MB } from '../limits'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ kind: Kind; categories: Category[]; record?: ModelRecord; initialCategory: string }>()
const kind = props.kind
const record = props.record
const openingRevision = record?.revision ?? null
const emit = defineEmits<{ close: []; changed: [] }>()
type UploadState = 'pending' | 'uploading' | 'done' | 'error' | 'conflict' | 'mismatch'
interface Snapshot { key: string; kind: Kind; recordId: string | null; name: string; description: string; tags: string[]; categoryId: string; note: string; entry: string; expectedRevision: number | null }
interface UploadItem { id: string; files: File[]; paths: string[]; name: string; entry: string; state: UploadState; progress: number; message: string; snapshot: Snapshot | null }
const queue = ref<UploadItem[]>([])
const busy = ref(false)
const error = ref('')
const description = ref('')
const tags = ref('')
const categoryId = ref(props.initialCategory === 'uncategorized' ? '' : props.initialCategory)
const note = ref('')
const fileInput = ref<HTMLInputElement>()
const folderInput = ref<HTMLInputElement>()
const frozen = computed(() => queue.value.some(item => item.snapshot !== null))
const completed = computed(() => queue.value.length > 0 && queue.value.every(item => item.state === 'done'))
const retryable = computed(() => queue.value.some(item => item.state === 'pending' || item.state === 'error'))
const label = computed(() => kind === 'dashboard' ? '大屏' : kind === 'scene' ? '场景' : '资产')
function candidates(item: UploadItem) { return item.paths.filter(path => /\.html?$/i.test(path)) }
function close() {
  if (busy.value) return
  if (queue.value.some(item => item.state !== 'done') && !window.confirm('关闭将丢弃本次待提交内容和重试凭据。网络异常时建议保留窗口并使用原请求重试。确认关闭？')) return
  emit('close')
}
function accept(files: FileList | File[] | null, folder = false) {
  if (!files || busy.value || frozen.value) return
  const selected = Array.from(files)
  if (!selected.length) return
  error.value = ''
  if (kind === 'dashboard') {
    if (!folder && (selected.length !== 1 || !/\.(html?|zip)$/i.test(selected[0]!.name))) { error.value = '请选择单个 HTML / ZIP 文件，或使用选择文件夹。'; return }
    const paths = folder ? selected.map(file => file.webkitRelativePath.split('/').slice(1).join('/') || file.name) : []
    const htmlPaths = paths.filter(path => /\.html?$/i.test(path))
    const first = selected[0]!
    queue.value = [{ id: createUuid(), files: selected, paths, name: folder ? first.webkitRelativePath.split('/')[0]! : first.name.replace(/\.(html?|zip)$/i, ''), entry: folder ? htmlPaths.find(path => /(^|\/)index\.html?$/i.test(path)) || htmlPaths[0] || '' : /\.html?$/i.test(first.name) ? first.name : 'index.html', state: 'pending', progress: 0, message: '', snapshot: null }]
  } else {
    const accepted = selected.filter(file => /\.glb$/i.test(file.name))
    if (accepted.length !== selected.length) error.value = '已跳过非 GLB 文件。'
    const items = accepted.map(file => ({ id: createUuid(), files: [file], paths: [], name: file.name.replace(/\.glb$/i, ''), entry: '', state: 'pending' as const, progress: 0, message: '', snapshot: null }))
    queue.value = record ? items.slice(0, 1) : [...queue.value, ...items]
  }
  if (fileInput.value) fileInput.value.value = ''
  if (folderInput.value) folderInput.value.value = ''
}
function snapshot(item: UploadItem, revision = openingRevision): Snapshot {
  return { key: createUuid(), kind, recordId: record?.id ?? null, name: item.name.trim(), description: description.value, tags: splitTags(tags.value), categoryId: categoryId.value, note: note.value, entry: item.entry.trim(), expectedRevision: revision }
}
function formData(item: UploadItem, value: Snapshot) {
  const form = new FormData()
  if (item.paths.length) {
    item.files.forEach(file => form.append('files[]', file, file.name))
    form.append('paths', json(item.paths))
  } else form.append('file', item.files[0]!, item.files[0]!.name)
  form.append('idempotencyKey', value.key); form.append('note', value.note)
  if (value.kind === 'dashboard') form.append('entry', value.entry)
  if (value.recordId) form.append('expectedRevision', String(value.expectedRevision))
  else {
    form.append('kind', value.kind); form.append('name', value.name); form.append('description', value.description)
    form.append('tags', json(value.tags)); form.append('categoryId', value.categoryId)
  }
  return form
}
function validate(item: UploadItem) {
  if (!item.name.trim()) throw new Error('请填写条目名称')
  if (item.files.length > 2000) throw new Error('文件夹最多包含 2000 个文件')
  const limit = kind === 'dashboard' ? 100 * 1024 * 1024 : MODEL_MAX_BYTES
  if (item.files.reduce((sum, file) => sum + file.size, 0) > limit) throw new Error(`单次源文件总计不能超过 ${kind === 'dashboard' ? 100 : MODEL_MAX_MB} MB`)
  if (item.files.some(file => file.size > limit)) throw new Error(`单个文件不能超过 ${kind === 'dashboard' ? 100 : MODEL_MAX_MB} MB`)
  if (kind === 'dashboard' && !/\.html?$/i.test(item.entry.trim())) throw new Error('请指定相对路径的 HTML 入口文件')
  if (item.paths.length && !item.paths.includes(item.entry.trim())) throw new Error('入口必须为所选文件夹内的 HTML 文件')
}
async function send(item: UploadItem) {
  const value = item.snapshot
  if (!value) return
  item.state = 'uploading'; item.message = ''; item.progress = 0
  try {
    const path = value.recordId ? `/records/${value.recordId}/versions` : `/records?kind=${value.kind}`
    let version: Version
    if (value.recordId) version = await upload<Version>(path, formData(item, value), progress => { item.progress = progress })
    else version = (await upload<ModelRecord>(path, formData(item, value), progress => { item.progress = progress })).currentVersion
    item.state = 'done'; item.progress = 100; item.message = '原始文件已保存'
    if (value.kind !== 'dashboard') {
      try {
        const image = await generateThumbnail(item.files[0]!)
        const form = new FormData(); form.append('file', image, 'thumbnail.png'); form.append('idempotencyKey', createUuid())
        await api(`/versions/${version.id}/thumbnail`, { method: 'POST', body: form })
      } catch (cause) { item.message = `文件已保存；缩略图失败：${cause instanceof Error ? cause.message : '未知错误'}。可在列表补建。` }
    }
    emit('changed')
  } catch (cause) {
    item.state = cause instanceof ApiError && cause.code === 'VERSION_CONFLICT' ? 'conflict' : cause instanceof ApiError && cause.code === 'IDEMPOTENCY_MISMATCH' ? 'mismatch' : 'error'
    item.message = cause instanceof Error ? cause.message : '上传失败'
  }
}
async function start() {
  if (busy.value) return
  error.value = ''
  const pending = queue.value.filter(item => item.state === 'pending' || item.state === 'error')
  try { for (const item of pending) if (!item.snapshot) validate(item) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '请检查文件'; return }
  // Freeze the entire queue before the first network request, not as each item starts.
  for (const item of pending) if (!item.snapshot) item.snapshot = snapshot(item)
  busy.value = true
  try { for (const item of pending) await send(item) } finally { busy.value = false }
}
async function rebase(item: UploadItem) {
  if (!item.snapshot?.recordId || busy.value) return
  busy.value = true; error.value = ''
  try {
    const latest = await api<Detail>(`/records/${item.snapshot.recordId}`)
    if (latest.record.archived) throw new Error('条目已归档，请先在详情中取消归档，再重新提交')
    item.snapshot = { ...item.snapshot, expectedRevision: latest.record.revision, key: createUuid() }
    await send(item)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取最新版本失败' }
  finally { busy.value = false }
}
function newSubmission() {
  if (busy.value || !window.confirm('这会创建新的提交凭据；若之前的请求实际成功，重新上传会创建新的条目或版本。确认开始新的提交？')) return
  queue.value = queue.value.filter(item => item.state !== 'done').map(item => ({ ...item, snapshot: null, state: 'pending', progress: 0, message: '' }))
  error.value = ''
}
</script>
<template>
  <div class="modal-overlay" @click.self="close"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="upload-title">
    <header class="modal-header"><div><h2 id="upload-title">{{ record ? `为「${record.name}」上传新版本` : `上传${label}` }}</h2></div><button class="icon-button" :disabled="busy" aria-label="关闭上传" @click="close"><AppIcon name="close" /></button></header>
    <p class="fine">{{ kind === 'dashboard' ? 'HTML / ZIP / 文件夹 · 总计 ≤100 MB · 最多 2000 个文件 · 展开 ≤200 MB' : `GLB · 单文件 ≤${MODEL_MAX_MB} MB` }}</p>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p>
    <div v-if="frozen && !completed" class="conflict-box"><button class="text-link" :disabled="busy" @click="newSubmission">开始新的提交（解除冻结）</button></div>
    <div class="dropzone" @dragover.prevent @drop.prevent="accept($event.dataTransfer?.files || null)"><AppIcon name="upload" :size="28" /><strong>{{ kind === 'dashboard' ? '选择 HTML、ZIP 或大屏文件夹' : '拖入 GLB 文件，或选择文件' }}</strong><div><button class="secondary" :disabled="busy || frozen" @click="fileInput?.click()">选择文件</button><button v-if="kind === 'dashboard' || !record" class="text-link" :disabled="busy || frozen" @click="folderInput?.click()">选择文件夹</button></div><input ref="fileInput" class="sr-only" type="file" :accept="kind === 'dashboard' ? '.html,.htm,.zip' : '.glb'" :multiple="kind !== 'dashboard' && !record" :disabled="busy || frozen" @change="accept(($event.target as HTMLInputElement).files)"><input ref="folderInput" class="sr-only" type="file" webkitdirectory multiple :disabled="busy || frozen" @change="accept(($event.target as HTMLInputElement).files, true)"></div>
    <div class="upload-queue"><article v-for="(item, index) in queue" :key="item.id" class="upload-row"><div class="upload-row-main"><label v-if="!record" class="upload-name">名称<input v-model="item.name" required maxlength="160" :disabled="busy || !!item.snapshot" :aria-label="`条目名称 ${index + 1}`"></label><strong v-else>{{ item.files[0]?.name }}</strong><small>{{ item.files.length }} 个文件 · {{ bytes(item.files.reduce((sum, file) => sum + file.size, 0)) }}</small><label v-if="kind === 'dashboard'" class="entry-field">HTML 入口相对路径<input v-model="item.entry" :list="`entries-${item.id}`" :disabled="busy || !!item.snapshot" required placeholder="例如 index.html 或 pages/home.html"><datalist :id="`entries-${item.id}`"><option v-for="path in candidates(item)" :key="path" :value="path" /></datalist><small v-if="!item.paths.length && /\.zip$/i.test(item.files[0]?.name || '')">填写 ZIP 内的 HTML 入口路径。</small></label><p v-if="item.message" :class="{ 'upload-error': item.state !== 'done' }" role="status">{{ item.message }}</p><progress v-if="item.state === 'uploading'" :value="item.progress" max="100" /><button v-if="item.state === 'conflict'" class="text-link" :disabled="busy" @click="rebase(item)">重新读取最新版本并重新提交</button><p v-if="item.state === 'mismatch'" class="fine">该凭据已绑定其他内容。请使用上方“开始新的提交”，不要直接重试。</p></div><span class="upload-status">{{ ({ pending: '待上传', uploading: `${item.progress}%`, done: '已保存', error: '可重试', conflict: '版本冲突', mismatch: '凭据冲突' })[item.state] }}</span><button v-if="!item.snapshot" class="icon-button" :disabled="busy" :aria-label="`移除 ${item.name}`" @click="queue.splice(index, 1)"><AppIcon name="close" :size="16" /></button></article></div>
    <div class="stack-form"><template v-if="!record"><label>分类<select v-model="categoryId" :disabled="busy || frozen"><option value="">未分类</option><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.parentId ? `${categories.find(parent => parent.id === category.parentId)?.name} / ` : '' }}{{ category.name }}</option></select></label><label>描述<textarea v-model="description" rows="2" maxlength="4000" :disabled="busy || frozen" /></label><label>统一标签<input v-model="tags" maxlength="1000" placeholder="逗号分隔" :disabled="busy || frozen"></label></template><label>版本说明<textarea v-model="note" rows="2" maxlength="2000" :disabled="busy || frozen" /></label></div>
    <footer class="modal-footer"><span class="fine">{{ queue.filter(item => item.state === 'done').length }} / {{ queue.length }} 已保存</span><button class="secondary" :disabled="busy" @click="close">{{ completed ? '完成' : '关闭' }}</button><button v-if="retryable" class="primary" :disabled="busy" @click="start">{{ busy ? '正在处理…' : frozen ? '原请求重试失败项' : '开始上传' }}</button></footer>
  </section></div>
</template>
