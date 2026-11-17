<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from './components/AppIcon.vue'
import ModelViewer from './components/ModelViewer.vue'
import DashboardViewer from './components/DashboardViewer.vue'
import ThemeSwitch from './components/ThemeSwitch.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import LibraryCategories from './components/LibraryCategories.vue'
import CategoryDialog from './components/CategoryDialog.vue'
import AccountDialog from './components/AccountDialog.vue'
import UploadDialog from './components/UploadDialog.vue'
import SettingsPage from './components/SettingsPage.vue'
import BrandLogo from './components/BrandLogo.vue'
import { preferences } from './preferences'
import { api, ApiError, bytes, date, fileUrl, json, sourceUrl, splitTags, thumbnailUrl } from './api'
import type { Category, DashboardManifest, Detail, Kind, ModelRecord, User, Version } from './contracts'
import { generateThumbnail } from './three/thumbnail'
import { createUuid } from './uuid'
import './library.css'

const modules: { kind: Kind; label: string; icon: string }[] = [
  { kind: 'asset', label: '资产库', icon: 'cube' },
  { kind: 'scene', label: '场景库', icon: 'scene' },
  { kind: 'dashboard', label: '看板库', icon: 'folder' },
]
const booting = ref(true)
const setupRequired = ref(false)
const user = ref<User | null>(null)
const login = ref({ username: '', password: '', displayName: '' })
const error = ref('')
const notice = ref('')
const busy = ref(false)
const loading = ref(false)
const kind = ref<Kind>('asset')
const settingsOpen = ref(false)
const categories = ref<Category[]>([])
const categoryId = ref('')
const records = ref<ModelRecord[]>([])
const includeArchived = ref(false)
const query = ref('')
const tag = ref('')
const sort = ref(preferences.value.defaultSort)
const detail = ref<Detail | null>(null)
const selectedVersionId = ref('')
const dashboardPreviewId = ref('')
const manifest = ref<DashboardManifest | null>(null)
const manifestLoading = ref(false)
const modal = ref<'' | 'upload' | 'version' | 'edit' | 'categories' | 'accounts'>('')
const metaForm = ref({ name: '', description: '', tags: '', categoryId: '' })
const metaRevision = ref(0)
const conflict = ref('')
const thumbnailStamp = ref(0)
interface ThumbnailRequest { versionId: string; file: Blob; key: string }
const thumbnailRequest = ref<ThumbnailRequest | null>(null)
const thumbnailError = ref('')
const screenshotInput = ref<HTMLInputElement>()
const activeModule = computed(() => modules.find(module => module.kind === kind.value)!)
const canEdit = computed(() => kind.value === 'dashboard' ? user.value?.role === 'admin' : user.value?.role === 'admin' || user.value?.role === 'editor')
const selectedVersion = computed(() => detail.value?.versions.find(version => version.id === selectedVersionId.value))
const tags = computed(() => [...new Set(records.value.flatMap(record => record.tags))].sort())
const roleLabel = computed(() => user.value?.role === 'admin' ? '管理员' : user.value?.role === 'editor' ? '编辑者' : '查看者')
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return records.value.filter(record => (!needle || [record.name, record.description, ...record.tags].join(' ').toLocaleLowerCase().includes(needle)) && (!tag.value || record.tags.includes(tag.value)))
    .sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort.value === 'size' ? b.currentVersion.size - a.currentVersion.size : b.updatedAt.localeCompare(a.updatedAt))
})
watch(() => preferences.value.defaultSort, value => { sort.value = value })
let routeSequence = 0
let recordsSequence = 0
function report(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '操作失败，请重试'
  if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') conflict.value = '内容已被其他人更新。本次操作未保存，请主动重新读取最新版本后再决定是否提交。'
  if (cause instanceof ApiError && cause.status === 401) { user.value = null; modal.value = ''; detail.value = null; dashboardPreviewId.value = '' }
}
async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (cause) { report(cause) } finally { busy.value = false }
}
function navigate(nextKind = kind.value, recordId = '') {
  const hash = `#/${nextKind}${recordId ? `/${encodeURIComponent(recordId)}` : ''}`
  if (window.location.hash === hash) void loadRoute()
  else window.location.hash = hash
}
async function refreshRecords() {
  const sequence = ++recordsSequence
  const params = new URLSearchParams({ kind: kind.value })
  if (categoryId.value) params.set('categoryId', categoryId.value)
  if (user.value?.role === 'admin' && includeArchived.value) params.set('includeArchived', '1')
  const result = await api<ModelRecord[]>(`/records?${params}`)
  if (sequence === recordsSequence) records.value = result
}
async function refreshCategories() {
  const currentKind = kind.value
  const result = await api<Category[]>(`/categories?kind=${currentKind}`)
  if (currentKind !== kind.value) return
  categories.value = result
  if (categoryId.value && categoryId.value !== 'uncategorized' && !result.some(category => category.id === categoryId.value)) categoryId.value = ''
  await refreshRecords()
}
async function loadRoute() {
  if (!user.value) return
  const sequence = ++routeSequence
  const parts = window.location.hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'settings') {
    settingsOpen.value = true; detail.value = null; dashboardPreviewId.value = ''; modal.value = ''; loading.value = false; error.value = ''; conflict.value = ''; ++recordsSequence
    return
  }
  settingsOpen.value = false
  const nextKind: Kind = parts[0] === 'scene' ? 'scene' : parts[0] === 'dashboard' ? 'dashboard' : parts[0] === 'asset' ? 'asset' : preferences.value.defaultLibrary
  if (kind.value !== nextKind) { query.value = ''; tag.value = ''; categoryId.value = ''; categories.value = []; records.value = []; sort.value = preferences.value.defaultSort }
  kind.value = nextKind; detail.value = null; dashboardPreviewId.value = ''; manifest.value = null; conflict.value = ''; thumbnailRequest.value = null; thumbnailError.value = ''; loading.value = true; error.value = ''
  try {
    await refreshCategories()
    if (sequence !== routeSequence) return
    if (parts[1]) {
      const result = await api<Detail>(`/records/${encodeURIComponent(decodeURIComponent(parts[1]))}`)
      if (sequence !== routeSequence) return
      if (result.record.kind !== nextKind) throw new Error('条目不属于当前库')
      detail.value = result; selectedVersionId.value = result.record.currentVersionId
    }
  } catch (cause) { if (sequence === routeSequence) report(cause) }
  finally { if (sequence === routeSequence) loading.value = false }
}
async function authenticate() {
  await act(async () => {
    user.value = (await api<{ user: User }>(setupRequired.value ? '/setup' : '/login', { method: 'POST', body: json(login.value) })).user
    setupRequired.value = false; login.value.password = ''; await loadRoute()
  })
}
async function logout() {
  await act(async () => { await api('/logout', { method: 'POST' }); user.value = null; records.value = []; categories.value = []; detail.value = null; modal.value = ''; dashboardPreviewId.value = ''; ++routeSequence; ++recordsSequence })
}
async function selectCategory(id: string) { categoryId.value = id; if (detail.value) navigate(); else await act(refreshRecords) }
async function selectArchiveFilter() { await act(refreshRecords) }
async function refreshDetail(selectCurrent = false) {
  const id = detail.value?.record.id
  if (!id) return
  const result = await api<Detail>(`/records/${id}`)
  if (detail.value?.record.id !== id) return
  if (result.record.currentVersionId !== detail.value.record.currentVersionId) dashboardPreviewId.value = ''
  detail.value = result
  if (selectCurrent || !result.versions.some(version => version.id === selectedVersionId.value)) selectedVersionId.value = result.record.currentVersionId
}
async function uploadChanged() { await act(async () => { await refreshRecords(); await refreshDetail(true); notice.value = '文件已保存，历史版本完整保留' }) }
function openEdit() {
  if (!detail.value) return
  const record = detail.value.record
  metaForm.value = { name: record.name, description: record.description, tags: record.tags.join('，'), categoryId: record.categoryId || '' }
  metaRevision.value = record.revision; conflict.value = ''; error.value = ''; modal.value = 'edit'
}
async function saveMeta() {
  await act(async () => {
    if (!detail.value) return
    detail.value.record = await api<ModelRecord>(`/records/${detail.value.record.id}`, { method: 'PATCH', body: json({ ...metaForm.value, tags: splitTags(metaForm.value.tags), categoryId: metaForm.value.categoryId || null, expectedRevision: metaRevision.value }) })
    modal.value = ''; conflict.value = ''; await refreshRecords(); notice.value = '条目信息已更新'
  })
}
async function reloadLatest() {
  await act(async () => { await refreshDetail(); if (detail.value) metaRevision.value = detail.value.record.revision; conflict.value = ''; notice.value = modal.value === 'edit' ? '已重新读取最新修订号，待编辑内容保留。请检查后再点击保存。' : '已重新读取最新版本，请检查后重新操作。' })
}
async function setCurrent(version: Version) {
  await act(async () => {
    if (!detail.value) return
    await api(`/records/${detail.value.record.id}/current`, { method: 'POST', body: json({ versionId: version.id, expectedRevision: detail.value.record.revision }) })
    dashboardPreviewId.value = ''; await refreshDetail(); await refreshRecords(); notice.value = `已将 v${version.number} 设为当前版本`
  })
}
async function archive() {
  if (!detail.value || !window.confirm(detail.value.record.archived ? '确认取消归档，重新显示在库中？' : '确认归档此条目？默认列表将隐藏，历史版本仍可查看和下载。')) return
  await act(async () => {
    if (!detail.value) return
    detail.value.record = await api<ModelRecord>(`/records/${detail.value.record.id}/archive`, { method: 'PATCH', body: json({ archived: !detail.value.record.archived, expectedRevision: detail.value.record.revision }) })
    dashboardPreviewId.value = ''; await refreshRecords(); notice.value = detail.value.record.archived ? '条目已归档' : '已取消归档'
  })
}
async function loadManifest() {
  const id = selectedVersionId.value
  manifestLoading.value = true; error.value = ''
  try { const result = await api<DashboardManifest>(`/versions/${id}/manifest`); if (selectedVersionId.value === id) manifest.value = result }
  catch (cause) { report(cause) } finally { manifestLoading.value = false }
}
async function sendThumbnail() {
  const request = thumbnailRequest.value
  if (!request) return
  await act(async () => {
    thumbnailError.value = ''
    const form = new FormData(); form.append('file', request.file, 'thumbnail.png'); form.append('idempotencyKey', request.key)
    try {
      await api(`/versions/${request.versionId}/thumbnail`, { method: 'POST', body: form })
      thumbnailRequest.value = null; ++thumbnailStamp.value; await refreshDetail(); await refreshRecords(); notice.value = '版本截图已更新'
    } catch (cause) { thumbnailError.value = cause instanceof Error ? cause.message : '截图上传失败'; throw cause }
  })
}
async function screenshotSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]; input.value = ''
  if (!file || !selectedVersion.value) return
  if (!/\.png$/i.test(file.name) || file.size > 2 * 1024 * 1024) { error.value = '截图必须是 2 MB 以内的 PNG 文件'; return }
  thumbnailRequest.value = { versionId: selectedVersion.value.id, file, key: createUuid() }; await sendThumbnail()
}
async function regenerateThumbnail() {
  const version = selectedVersion.value
  if (!version) return
  await act(async () => {
    const response = await fetch(fileUrl(version.id), { credentials: 'same-origin' })
    if (!response.ok) throw new Error('无法读取模型文件')
    const image = await generateThumbnail(new File([await response.blob()], version.originalName, { type: 'model/gltf-binary' }))
    thumbnailRequest.value = { versionId: version.id, file: image, key: createUuid() }
  })
  if (thumbnailRequest.value) await sendThumbnail()
}
function accountChanged(account: User) { if (user.value?.id === account.id) { user.value = account; if (account.role !== 'admin') modal.value = '' } }
watch(selectedVersionId, () => { dashboardPreviewId.value = ''; manifest.value = null; thumbnailRequest.value = null; thumbnailError.value = '' })
onMounted(async () => {
  window.addEventListener('hashchange', loadRoute)
  try {
    setupRequired.value = (await api<{ required: boolean }>('/setup')).required
    if (!setupRequired.value) {
      try { user.value = (await api<{ user: User }>('/me')).user; await loadRoute() }
      catch (cause) { if (!(cause instanceof ApiError && cause.status === 401)) report(cause) }
    }
  } catch (cause) { report(cause) } finally { booting.value = false }
})
onUnmounted(() => { window.removeEventListener('hashchange', loadRoute) })
</script>

<template>
  <div v-if="booting" class="boot"><span class="spinner" />正在连接资源库…</div>
  <main v-else-if="!user" class="auth-shell">
    <section class="auth-story"><a class="brand" href="#/"><BrandLogo /></a><div class="auth-art" aria-hidden="true"><div class="orbit orbit-one" /><div class="orbit orbit-two" /><img src="/scenivo.svg" alt="" width="132" height="132"></div><h1>让每次创作，<br>都有自己的位置。</h1></section>
    <section class="auth-panel"><ThemeSwitch /><form class="auth-form" @submit.prevent="authenticate"><h2>{{ setupRequired ? '创建管理员账号' : '登录工作空间' }}</h2><label>用户名<input v-model="login.username" required pattern="[A-Za-z0-9_-]{3,40}" minlength="3" maxlength="40" autocomplete="username" placeholder="至少 3 位字母、数字、_ 或 -"></label><label v-if="setupRequired">显示名称<input v-model="login.displayName" required maxlength="80" autocomplete="name"></label><label>密码<input v-model="login.password" type="password" required :minlength="setupRequired ? 6 : 1" maxlength="200" :autocomplete="setupRequired ? 'new-password' : 'current-password'"></label><p v-if="error" class="error-box" role="alert">{{ error }}</p><button class="primary auth-submit" :disabled="busy">{{ busy ? '正在连接…' : setupRequired ? '创建账号并进入' : '登录' }}<AppIcon name="arrow" :size="18" /></button></form></section>
  </main>
  <div v-else class="app-shell library-app">
    <aside class="sidebar"><a class="brand" href="#/"><BrandLogo /></a><div class="workspace-label">团队资源空间<span class="online-dot" /></div><nav class="module-navigation" aria-label="资源库"><button v-for="module in modules" :key="module.kind" :class="{ active: !settingsOpen && kind === module.kind }" @click="navigate(module.kind)"><AppIcon :name="module.icon" :size="19" /><span>{{ module.label }}</span><AppIcon v-if="!settingsOpen && kind === module.kind" name="arrow" :size="14" /></button></nav><div class="sidebar-bottom"><a class="sidebar-action settings-link" :class="{ active: settingsOpen }" href="#/settings"><AppIcon name="settings" :size="18" />设置</a><div class="user-row"><span class="avatar">{{ user.displayName.slice(0, 1) }}</span><div><strong>{{ user.displayName }}</strong><small>{{ roleLabel }}</small></div><button class="icon-button" title="退出登录" aria-label="退出登录" :disabled="busy" @click="logout"><AppIcon name="logout" :size="18" /></button></div></div></aside>
    <main class="workspace"><header class="topbar"><div class="breadcrumb"><a href="#/">资源空间</a><AppIcon name="arrow" :size="13" /><strong>{{ settingsOpen ? '设置' : activeModule.label }}</strong><template v-if="detail"><AppIcon name="arrow" :size="13" /><span>{{ detail.record.name }}</span></template></div><ThemeToggle /></header>
      <div v-if="error && modal !== 'edit'" class="error-box global-error" role="alert">{{ error }}<button class="icon-button" aria-label="关闭错误" @click="error = ''"><AppIcon name="close" :size="16" /></button></div>
      <div v-if="conflict && modal !== 'edit'" class="conflict-box global-error"><p>{{ conflict }}</p><button class="text-link" :disabled="busy" @click="reloadLatest">重新读取最新版本</button></div>
      <SettingsPage v-if="settingsOpen" :user="user" @manage-accounts="modal = 'accounts'" />
      <div v-else-if="loading" class="loading-state"><span class="spinner" />正在读取资源库…</div>
      <template v-else-if="!detail"><section class="page-heading"><div><h1>{{ activeModule.label }}</h1></div><div class="heading-actions"><button v-if="canEdit" class="primary" @click="modal = 'upload'"><AppIcon name="plus" :size="18" />{{ kind === 'dashboard' ? '上传大屏' : '上传模型' }}</button></div></section>
        <section class="library-body">
          <LibraryCategories :kind="kind" :categories="categories" :selected="categoryId" :editable="canEdit" @select="selectCategory" @manage="modal = 'categories'" />
          <div class="library-summary"><div><h2>{{ categoryId === 'uncategorized' ? '未分类' : categories.find(category => category.id === categoryId)?.name || '全部内容' }}<span>{{ records.length }}</span></h2></div></div><div class="toolbar"><label class="search-field"><AppIcon name="search" :size="18" /><input v-model="query" aria-label="搜索资源" placeholder="搜索名称、描述或标签…"></label><select v-model="tag" aria-label="筛选标签"><option value="">全部标签</option><option v-for="value in tags" :key="value" :value="value">{{ value }}</option></select><select v-model="sort" aria-label="排序方式"><option value="updated">最近更新</option><option value="name">名称排序</option><option value="size">文件大小</option></select><label v-if="user.role === 'admin'" class="archive-toggle"><input v-model="includeArchived" type="checkbox" @change="selectArchiveFilter">包含归档</label></div>
          <div v-if="!filtered.length" class="library-empty"><div class="empty-symbol"><AppIcon :name="query || tag ? 'search' : activeModule.icon" :size="38" /></div><h3>{{ query || tag ? '没有找到匹配内容' : '此分类还没有内容' }}</h3><button v-if="query || tag" class="secondary" @click="query = ''; tag = ''">清除筛选</button><button v-else-if="canEdit" class="secondary" @click="modal = 'upload'">上传第一个条目</button></div>
          <div v-else class="model-grid"><button v-for="record in filtered" :key="record.id" class="model-card" @click="navigate(kind, record.id)"><div class="card-preview"><img v-if="record.currentVersion.hasThumbnail" :src="`${thumbnailUrl(record.currentVersion.id)}?v=${thumbnailStamp}`" :alt="record.name + '截图'" loading="lazy"><div v-else class="preview-placeholder"><AppIcon :name="activeModule.icon" :size="48" /><span>{{ kind === 'dashboard' ? '暂无截图' : '暂无缩略图' }}</span></div><span class="file-chip">{{ record.currentVersion.sourceKind.toUpperCase() }}</span><span class="version-chip">v{{ record.currentVersion.number }}</span><span class="preview-open">查看详情<AppIcon name="arrow" :size="15" /></span></div><div class="card-content"><h3>{{ record.name }}<span v-if="record.archived" class="archived-badge">已归档</span></h3><div class="card-tags"><span v-for="value in record.tags.slice(0, 3)" :key="value">{{ value }}</span><span v-if="!record.tags.length" class="no-tag">{{ activeModule.label }}</span></div><div class="card-meta"><span>{{ bytes(record.currentVersion.size) }}</span><span>{{ new Date(record.updatedAt).toLocaleDateString('zh-CN') }}</span></div></div></button></div><div v-if="filtered.length" class="list-footer">显示 {{ filtered.length }} 个条目</div>
        </section></template>
      <template v-else><section class="detail-heading"><div><button class="back-link" @click="navigate()"><AppIcon name="back" :size="16" />返回{{ activeModule.label }}</button><h1>{{ detail.record.name }}<span class="type-badge">{{ activeModule.label }}</span><span v-if="detail.record.archived" class="archived-badge">已归档</span></h1></div><div class="heading-actions"><button v-if="user.role === 'admin'" class="secondary" :disabled="busy || !!conflict" @click="archive">{{ detail.record.archived ? '取消归档' : '归档' }}</button><button v-if="canEdit" class="secondary" @click="openEdit"><AppIcon name="edit" :size="16" />编辑信息</button><button v-if="canEdit && !detail.record.archived" class="primary" @click="modal = 'version'"><AppIcon name="upload" :size="17" />上传新版本</button></div></section>
        <div class="detail-layout"><section class="viewer-panel"><div class="viewer-topline"><span>{{ kind === 'dashboard' ? '大屏版本截图' : '实时 3D 预览' }}</span><div><label for="preview-version">预览版本</label><select id="preview-version" v-model="selectedVersionId"><option v-for="version in detail.versions" :key="version.id" :value="version.id">v{{ version.number }}{{ version.id === detail.record.currentVersionId ? ' · 当前' : '' }}</option></select></div></div><template v-if="selectedVersion"><ModelViewer v-if="detail.record.kind !== 'dashboard'" :url="fileUrl(selectedVersion.id)" :kind="detail.record.kind" /><div v-else class="dashboard-cover"><img v-if="selectedVersion.hasThumbnail" :src="`${thumbnailUrl(selectedVersion.id)}?v=${thumbnailStamp}`" :alt="`${detail.record.name} v${selectedVersion.number}截图`"><div v-else class="preview-placeholder"><AppIcon name="folder" :size="52" /><span>暂无截图</span></div><button class="primary" @click="dashboardPreviewId = selectedVersion.id">隔离运行预览</button></div><div class="viewer-caption"><a class="text-link" :href="sourceUrl(selectedVersion)"><AppIcon name="download" :size="15" />下载{{ kind === 'dashboard' ? '源文件' : '原文件' }} v{{ selectedVersion.number }}</a></div><div v-if="kind === 'dashboard'" class="dashboard-files"><button class="text-link" :disabled="manifestLoading" @click="loadManifest">{{ manifestLoading ? '正在读取…' : manifest ? '重新读取文件清单' : '查看文件清单' }}</button><template v-if="manifest"><p class="fine">入口：{{ manifest.entry }} · {{ manifest.files.length }} 个文件</p><ul><li v-for="file in manifest.files" :key="file.path"><span>{{ file.path }}</span><small>{{ bytes(file.size) }}</small></li></ul></template></div></template></section>
          <aside class="detail-sidebar"><section class="info-section"><h3>条目信息</h3><p class="record-description">{{ detail.record.description || '暂无描述' }}</p><div class="detail-tags"><span v-for="value in detail.record.tags" :key="value" class="tag">{{ value }}</span><span v-if="!detail.record.tags.length" class="muted">未添加标签</span></div><dl><dt>分类</dt><dd>{{ categories.find(category => category.id === detail?.record.categoryId)?.name || '未分类' }}</dd><dt>修订号</dt><dd>{{ detail.record.revision }}</dd><template v-if="selectedVersion"><dt>文件名</dt><dd>{{ selectedVersion.originalName }}</dd><dt>文件大小</dt><dd>{{ bytes(selectedVersion.size) }}</dd><dt>源文件格式</dt><dd>{{ selectedVersion.sourceKind.toUpperCase() }}</dd><template v-if="selectedVersion.entry"><dt>入口</dt><dd>{{ selectedVersion.entry }}</dd></template><dt>上传者</dt><dd>{{ selectedVersion.uploadedBy }}</dd><dt>上传时间</dt><dd>{{ date(selectedVersion.createdAt) }}</dd></template></dl><template v-if="canEdit && selectedVersion"><button v-if="kind !== 'dashboard'" class="text-link" :disabled="busy || !!thumbnailRequest" @click="regenerateThumbnail">重新生成预览缩略图</button><button v-else class="text-link" :disabled="busy || !!thumbnailRequest" @click="screenshotInput?.click()">上传此版本截图（PNG ≤2 MB）</button><input ref="screenshotInput" class="sr-only" type="file" accept="image/png,.png" @change="screenshotSelected"><div v-if="thumbnailRequest && thumbnailError" class="conflict-box"><p>{{ thumbnailError }}。原图片和提交凭据已保留。</p><button class="text-link" :disabled="busy" @click="sendThumbnail">使用原请求重试截图</button><button class="text-link" :disabled="busy" @click="thumbnailRequest = null; thumbnailError = ''">放弃本次截图提交</button></div></template></section><section class="version-section"><h3><AppIcon name="clock" :size="17" />版本记录<span>{{ detail.versions.length }}</span></h3><article v-for="version in detail.versions" :key="version.id" class="version-item" :class="{ viewing: version.id === selectedVersionId }"><div class="version-item-top"><button class="version-title" @click="selectedVersionId = version.id">v{{ version.number }}<span v-if="version.id === detail.record.currentVersionId" class="current-badge">当前</span></button><a :href="sourceUrl(version)" class="icon-button" :aria-label="`下载版本 ${version.number} 源文件`" title="下载原文件"><AppIcon name="download" :size="16" /></a></div><p>{{ version.note || '无版本说明' }}</p><small>{{ version.uploadedBy }} · {{ date(version.createdAt) }}</small><button v-if="canEdit && !detail.record.archived && version.id !== detail.record.currentVersionId" class="text-link" :disabled="busy || !!conflict" @click="setCurrent(version)">设为当前版本</button></article></section></aside>
        </div></template>
    </main>
    <div v-if="notice" class="toast" role="status"><AppIcon name="check" :size="18" />{{ notice }}<button class="icon-button" aria-label="关闭通知" @click="notice = ''"><AppIcon name="close" :size="16" /></button></div>
    <UploadDialog v-if="modal === 'upload' || modal === 'version'" :kind="kind" :categories="categories" :record="modal === 'version' ? detail?.record : undefined" :initial-category="categoryId" @close="modal = ''" @changed="uploadChanged" />
    <CategoryDialog v-if="modal === 'categories'" :kind="kind" :categories="categories" @close="modal = ''" @changed="act(refreshCategories)" />
    <AccountDialog v-if="modal === 'accounts' && user.role === 'admin'" @close="modal = ''" @changed="accountChanged" />
    <div v-if="modal === 'edit'" class="modal-overlay" @click.self="!busy && (modal = '')"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"><header class="modal-header"><h2 id="edit-title">编辑条目信息</h2><button class="icon-button" :disabled="busy" aria-label="关闭" @click="modal = ''"><AppIcon name="close" /></button></header><p v-if="error" class="error-box" role="alert">{{ error }}</p><div v-if="conflict" class="conflict-box"><p>{{ conflict }}待编辑内容会保留。</p><button class="text-link" :disabled="busy" @click="reloadLatest">重新读取最新版本，保留待编辑内容</button></div><form class="stack-form" @submit.prevent="saveMeta"><label>名称<input v-model="metaForm.name" required maxlength="160" :disabled="busy"></label><label>描述<textarea v-model="metaForm.description" maxlength="4000" rows="3" :disabled="busy" /></label><label>标签<input v-model="metaForm.tags" maxlength="1000" placeholder="逗号分隔" :disabled="busy"></label><label>分类<select v-model="metaForm.categoryId" :disabled="busy"><option value="">未分类</option><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.parentId ? `${categories.find(parent => parent.id === category.parentId)?.name} / ` : '' }}{{ category.name }}</option></select></label><footer class="modal-footer"><button type="button" class="secondary" :disabled="busy" @click="modal = ''">取消</button><button class="primary" :disabled="busy || !!conflict || !metaForm.name.trim()">保存修改</button></footer></form></section></div>
    <DashboardViewer v-if="dashboardPreviewId && detail" :version-id="dashboardPreviewId" :title="detail.record.name" @close="dashboardPreviewId = ''" />
  </div>
</template>
