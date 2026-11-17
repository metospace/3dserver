<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { api, fileUrl } from '../api'
import { fetchGlb } from '../three/loader'
import { generateThumbnail } from '../three/thumbnail'
import { createUuid } from '../uuid'
import type { ModelRecord } from '../contracts'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ records: ModelRecord[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()
interface Task { versionId: string; name: string; filename: string; state: 'pending' | 'working' | 'done' | 'failed'; message: string; image: Blob | null; key: string }
const tasks = ref<Task[]>(props.records.filter(record => record.kind !== 'dashboard' && !record.currentVersion.hasThumbnail).map(record => ({ versionId: record.currentVersion.id, name: record.name, filename: record.currentVersion.originalName, state: 'pending', message: '', image: null, key: createUuid() })))
const busy = ref(false)
const aborted = new AbortController()
const finished = computed(() => tasks.value.filter(task => task.state === 'done').length)
async function start() {
  if (busy.value) return
  busy.value = true
  try {
    // Explicit operation only: one model and one GPU renderer at a time, never fetch all cards in parallel.
    for (const task of tasks.value.filter(item => item.state !== 'done')) {
      if (aborted.signal.aborted) return
      task.state = 'working'; task.message = '读取模型'
      try {
        if (!task.image) {
          const data = await fetchGlb(fileUrl(task.versionId), aborted.signal)
          task.message = '生成缩略图'
          task.image = await generateThumbnail(new File([data], task.filename, { type: 'model/gltf-binary' }))
        }
        if (aborted.signal.aborted) return
        task.message = '保存缩略图'
        const form = new FormData(); form.append('file', task.image, 'thumbnail.png'); form.append('idempotencyKey', task.key)
        await api(`/versions/${task.versionId}/thumbnail`, { method: 'POST', body: form })
        task.state = 'done'; task.message = ''; task.image = null; emit('changed')
      } catch (error) { task.state = 'failed'; task.message = error instanceof Error ? error.message : '缩略图生成失败' }
    }
  } finally { busy.value = false }
}
onBeforeUnmount(() => { aborted.abort(); for (const task of tasks.value) task.image = null })
</script>
<template>
  <div class="modal-overlay" @click.self="!busy && emit('close')"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="backfill-title"><header class="modal-header"><h2 id="backfill-title">补建缺失缩略图</h2><button class="icon-button" :disabled="busy" aria-label="关闭缩略图补建" @click="emit('close')"><AppIcon name="close" /></button></header><div class="backfill-list"><article v-for="task in tasks" :key="task.versionId"><strong>{{ task.name }}</strong><span>{{ task.state === 'done' ? '已保存' : task.state === 'working' ? task.message : task.state === 'failed' ? '失败' : '待处理' }}</span><p v-if="task.state === 'failed'" role="alert">{{ task.message }}</p></article></div><footer class="modal-footer"><span class="fine">{{ finished }} / {{ tasks.length }}</span><button class="secondary" :disabled="busy" @click="emit('close')">关闭</button><button v-if="finished !== tasks.length" class="primary" :disabled="busy" @click="start">{{ busy ? '正在处理…' : '开始 / 重试失败项' }}</button></footer></section></div>
</template>
<style scoped>
.backfill-list{max-height:50vh;overflow:auto}.backfill-list article{display:flex;flex-wrap:wrap;gap:8px 18px;padding:14px 0;border-bottom:1px solid var(--line)}.backfill-list strong{flex:1;font-size:12px;min-width:0;overflow-wrap:anywhere}.backfill-list span{font-size:11px;color:var(--muted)}.backfill-list p{flex-basis:100%;font-size:12px;color:var(--danger-text);line-height:1.7}
</style>
