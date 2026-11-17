<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, json } from '../api'
import type { Category, Kind } from '../contracts'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ kind: Kind; categories: Category[] }>()
const categoryLabel = computed(() => props.kind === 'asset' ? '资产分类' : props.kind === 'scene' ? '场景分类' : '看板分类')
const emit = defineEmits<{ close: []; changed: [] }>()
const busy = ref(false)
const error = ref('')
const name = ref('')
const parentId = ref('')
const editing = ref<Category | null>(null)
const deleting = ref<Category | null>(null)
function edit(category: Category) { editing.value = category; name.value = category.name; deleting.value = null; error.value = '' }
function reset() { editing.value = null; name.value = ''; parentId.value = ''; deleting.value = null; error.value = '' }
async function save() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    if (editing.value) await api(`/categories/${editing.value.id}`, { method: 'PATCH', body: json({ name: name.value.trim() }) })
    else await api('/categories', { method: 'POST', body: json({ kind: props.kind, name: name.value.trim(), parentId: parentId.value || null }) })
    reset(); emit('changed')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { busy.value = false }
}
async function remove() {
  if (!deleting.value || busy.value) return
  busy.value = true; error.value = ''
  try { await api(`/categories/${deleting.value.id}`, { method: 'DELETE' }); reset(); emit('changed') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '删除失败' }
  finally { busy.value = false }
}
</script>
<template>
  <div class="modal-overlay" @click.self="!busy && emit('close')"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="category-title">
    <header class="modal-header"><h2 id="category-title">管理{{ categoryLabel }}</h2><button class="icon-button" :disabled="busy" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p>
    <div class="category-management"><article v-for="category in categories" :key="category.id" :class="{ nested: category.parentId }"><span>{{ category.parentId ? `${categories.find(item => item.id === category.parentId)?.name} / ` : '' }}{{ category.name }}</span><button class="text-link" :disabled="busy" @click="edit(category)">重命名</button><button class="text-link danger-link" :disabled="busy" @click="deleting = category">删除</button></article></div>
    <section v-if="deleting" class="conflict-box"><p>确认删除「{{ deleting.name }}」及其子分类？其中所有条目将移至未分类，文件和版本完整保留。</p><div class="heading-actions"><button class="secondary" :disabled="busy" @click="deleting = null">取消</button><button class="secondary danger-link" :disabled="busy" @click="remove">确认删除分类</button></div></section>
    <form class="stack-form section-divider" @submit.prevent="save"><h3>{{ editing ? '重命名分类' : '新增分类' }}</h3><label>分类名称<input v-model="name" required maxlength="120" :disabled="busy"></label><label v-if="!editing">上级分类<select v-model="parentId" :disabled="busy"><option value="">顶级分类</option><option v-for="category in categories.filter(item => !item.parentId)" :key="category.id" :value="category.id">{{ category.name }}</option></select></label><footer class="modal-footer"><button v-if="editing" type="button" class="secondary" :disabled="busy" @click="reset">取消重命名</button><button class="primary" :disabled="busy || !name.trim()">{{ editing ? '保存名称' : '新增分类' }}</button></footer></form>
  </section></div>
</template>
