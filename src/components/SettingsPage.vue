<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import ThemeSwitch from './ThemeSwitch.vue'
import BrandLogo from './BrandLogo.vue'
import { api, bytes, date } from '../api'
import { preferences, savePreferences, type Preferences } from '../preferences'
import { appVersion, releases, type SystemInfo } from '../release'
import type { User } from '../contracts'

defineProps<{ user: User }>()
const emit = defineEmits<{ manageAccounts: [] }>()
const tab = ref<'general' | 'data' | 'about'>('general')
const form = ref<Preferences>({ ...preferences.value })
const info = ref<SystemInfo | null>(null)
const error = ref('')
const notice = ref('')
const loading = ref(false)
const checking = ref(false)
const newer = ref('')
const checkedAt = ref('')
const abort = new AbortController()
const origin = window.location.origin
async function refreshInfo() {
  loading.value = true; error.value = ''
  try { info.value = await api<SystemInfo>('/system', { signal: abort.signal }) }
  catch (cause) { if (!abort.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取部署信息失败' }
  finally { loading.value = false }
}
function save() {
  error.value = ''; notice.value = ''
  try { savePreferences({ ...form.value }); notice.value = '浏览偏好已保存到当前浏览器。' }
  catch { error.value = '浏览器不允许保存本地配置，请检查存储权限。' }
}
async function checkUpdate() {
  checking.value = true; error.value = ''; notice.value = ''; newer.value = ''
  try {
    const result = await api<SystemInfo>('/system', { cache: 'no-store', signal: abort.signal })
    info.value = result; checkedAt.value = new Date().toISOString()
    if (result.version !== appVersion) newer.value = result.version
    else notice.value = '当前页面与服务器版本一致。此检查仅访问当前内网服务器，不查询公网发行源。'
  } catch (cause) { if (!abort.signal.aborted) error.value = cause instanceof Error ? cause.message : '版本检查失败，请检查服务器连接' }
  finally { checking.value = false }
}
function reload() { window.location.reload() }
onMounted(refreshInfo)
onBeforeUnmount(() => abort.abort())
</script>

<template>
  <section class="settings-page">
    <header class="settings-heading"><h1>设置</h1></header>
    <nav class="settings-tabs" role="tablist" aria-label="设置分类"><button v-for="item in [{id:'general',label:'通用'},{id:'data',label:'数据与部署'},{id:'about',label:'关于与更新'}] as const" :key="item.id" role="tab" :aria-selected="tab === item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.label }}</button></nav>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p><p v-if="notice" class="settings-notice" role="status">{{ notice }}</p>
    <section v-if="tab === 'general'" class="settings-card" role="tabpanel" aria-label="通用设置">
      <h2>外观与浏览</h2><div class="settings-row"><div><h3>主题</h3></div><ThemeSwitch /></div>
      <form @submit.prevent="save"><div class="settings-row"><div><label for="default-library">默认打开的库</label></div><select id="default-library" v-model="form.defaultLibrary"><option value="asset">资产库</option><option value="scene">场景库</option><option value="dashboard">看板库</option></select></div><div class="settings-row"><div><label for="default-sort">默认排序</label></div><select id="default-sort" v-model="form.defaultSort"><option value="updated">最近更新</option><option value="name">名称排序</option><option value="size">文件大小</option></select></div><footer><button class="primary">保存偏好</button></footer></form>
      <div v-if="user.role === 'admin'" class="settings-row"><div><h3>团队账号与角色</h3></div><button class="secondary" @click="emit('manageAccounts')">管理团队账号</button></div>
    </section>
    <template v-else-if="tab === 'data'">
      <section class="settings-card"><header class="settings-card-header"><h2>当前数据与部署</h2><button class="secondary" :disabled="loading" @click="refreshInfo">{{ loading ? '读取中…' : '刷新信息' }}</button></header><p v-if="loading && !info" class="muted">正在读取服务器信息…</p><dl v-if="info" class="settings-info"><dt>服务地址</dt><dd>{{ origin }}</dd><dt>数据库结构</dt><dd>SQLite · v{{ info.databaseVersion }}</dd><dt>资源数量</dt><dd>资产 {{ info.records.asset }} · 场景 {{ info.records.scene }} · 看板 {{ info.records.dashboard }}（包含归档）</dd><dt>历史版本</dt><dd>{{ info.versionCount }} 个 · 原始内容累计 {{ bytes(info.sourceBytes) }}（非磁盘占用）</dd><dt v-if="info.dataDirectory">数据目录</dt><dd v-if="info.dataDirectory">{{ info.dataDirectory }}</dd><dt v-if="info.runtime">运行环境</dt><dd v-if="info.runtime">{{ info.runtime }}</dd><dt>文件限制</dt><dd>GLB {{ info.limits.modelMB }} MB；PNG {{ info.limits.screenshotMB }} MB；看板 {{ info.limits.dashboardMB }} MB / {{ info.limits.dashboardFiles }} 个文件；展开 {{ info.limits.expandedMB }} MB</dd><dt>当前账号</dt><dd>{{ user.displayName }} · {{ user.role === 'admin' ? '管理员' : user.role === 'editor' ? '编辑者' : '查看者' }}</dd></dl></section>
      <section class="settings-card"><h2>备份与服务配置</h2><p class="settings-description">停止服务后备份完整数据目录，包括 SQLite 及 WAL/SHM、files 和 dashboards。仅复制数据库不能恢复全部内容。备份含账号与会话，应按敏感数据保管。</p><p class="settings-description">监听地址、端口、数据目录与反向代理由服务器环境变量配置（HOST、PORT、DATA_DIR、TRUST_PROXY）。网页不修改这些部署参数；具体操作见部署目录中的 README.md。</p><p class="settings-description">本平台不会自动清理历史版本，也不会在此页面执行删除、数据库恢复或远程下载安装。</p></section>
    </template>
    <section v-else class="settings-card" role="tabpanel" aria-label="关于与更新">
      <h2>关于与更新</h2><div class="settings-row"><div><h3><BrandLogo /></h3><p>当前页面版本 <strong>{{ appVersion }}</strong><template v-if="info"> · 服务器版本 {{ info.version }}</template></p></div><button class="primary" :disabled="checking" @click="checkUpdate">{{ checking ? '检查中…' : '检查更新' }}</button></div>
      <div v-if="newer" class="settings-update" role="status"><p>服务器已部署 {{ newer }}，当前页面为 {{ appVersion }}。上传或编辑完成后再刷新，未提交内容不会自动保存。</p><button class="secondary" @click="reload">刷新使用已部署版本</button></div><p v-if="checkedAt" class="settings-check-time">上次检查：{{ date(checkedAt) }}</p>
      <div class="settings-history-heading"><h3>更新日志</h3></div><ol class="settings-history"><li v-for="release in releases" :key="release.version"><header><div><strong>v{{ release.version }}</strong><span v-if="release.version === appVersion" class="settings-badge">当前版本</span><span>{{ release.title }}</span></div><time :datetime="release.date">{{ release.date }}</time></header><ul><li v-for="change in release.changes" :key="change">{{ change }}</li></ul></li></ol>
    </section>
  </section>
</template>

<style scoped>
.settings-page{padding:32px 36px 45px}.settings-heading h1{font-size:25px}.settings-heading p{color:var(--muted);font-size:12px;line-height:1.8;margin-top:10px}.settings-tabs{display:flex;gap:26px;border-bottom:1px solid var(--line);margin:27px 0 24px}.settings-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);padding:12px 0;font-size:12px}.settings-tabs button.active{color:var(--accent);border-bottom-color:var(--accent)}.settings-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:24px;margin-top:18px}.settings-card h2{font-size:15px;margin-bottom:8px}.settings-card-header{display:flex;justify-content:space-between;align-items:center;gap:15px}.settings-row{display:flex;justify-content:space-between;align-items:center;gap:30px;padding:22px 0;border-bottom:1px solid var(--line)}.settings-row>div{min-width:0}.settings-row h3,.settings-row label{font-size:13px;font-weight:600;color:var(--text)}.settings-row p{font-size:12px;line-height:1.8;color:var(--muted);margin-top:7px}.settings-row select{min-width:150px}.settings-row>.theme-switch{flex-shrink:0}.settings-card footer{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:20px}.settings-card footer>span{font-size:11px;color:var(--muted)}.settings-description{font-size:12px;line-height:1.9;color:var(--text-secondary);margin-top:14px}.settings-info{display:grid;grid-template-columns:110px minmax(0,1fr);gap:16px 24px;margin:24px 0 0}.settings-info dt{font-size:12px}.settings-info dd{font-size:12px;overflow-wrap:anywhere}.settings-badge{display:inline-block;border:1px solid var(--line-strong);border-radius:4px;padding:2px 6px;margin-left:10px;font-size:10px;font-weight:400;color:var(--muted)}.settings-history-heading{display:flex;justify-content:space-between;gap:15px;padding:25px 0 20px}.settings-history-heading span,.settings-check-time{font-size:11px;color:var(--muted)}.settings-check-time{margin-top:14px}.settings-history{list-style:none;padding:0;margin:0}.settings-history>li{border-left:2px solid var(--line);padding:3px 0 24px 18px}.settings-history>li>header{display:flex;justify-content:space-between;align-items:center;gap:15px;font-size:12px}.settings-history header>div{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.settings-history header>div>span:last-child{color:var(--muted);font-size:11px}.settings-history time{color:var(--muted);font-size:11px;white-space:nowrap}.settings-history ul{margin:12px 0 0;padding-left:17px;color:var(--text-secondary);font-size:12px;line-height:2}.settings-notice,.settings-update{padding:13px 16px;border:1px solid var(--success-border);background:var(--success-bg);color:var(--success-text);border-radius:7px;font-size:12px;line-height:1.8}.settings-update{margin-top:16px}.settings-update button{margin-top:10px}
@media(max-width:760px){.settings-page{padding:25px 18px}.settings-card{padding:18px}.settings-tabs{gap:20px}.settings-row{flex-wrap:wrap;gap:15px}.settings-row select{width:100%}.settings-history>li>header{align-items:flex-start;flex-direction:column;gap:8px}.settings-info{grid-template-columns:80px minmax(0,1fr);gap:15px}.settings-card footer{align-items:flex-start;flex-direction:column}}
</style>
