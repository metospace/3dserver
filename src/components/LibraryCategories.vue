<script setup lang="ts">
import { computed } from 'vue'
import type { Category, Kind } from '../contracts'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ kind: Kind; categories: Category[]; selected: string; editable: boolean }>()
const emit = defineEmits<{ select: [id: string]; manage: [] }>()
const roots = computed(() => props.categories.filter(category => !category.parentId))
const categoryLabel = computed(() => props.kind === 'asset' ? '资产分类' : props.kind === 'scene' ? '场景分类' : '看板分类')
const selectedCategory = computed(() => props.categories.find(category => category.id === props.selected))
const activeRoot = computed(() => selectedCategory.value?.parentId || selectedCategory.value?.id || '')
const children = computed(() => props.categories.filter(category => category.parentId === activeRoot.value))
</script>
<template>
  <section class="category-filters" :aria-label="categoryLabel">
    <div class="category-filter-heading"><span>{{ categoryLabel }}</span><button v-if="editable" class="text-link" :aria-label="`管理${categoryLabel}`" @click="emit('manage')"><AppIcon name="edit" :size="14" />管理分类</button></div>
    <nav class="category-options" :aria-label="`${categoryLabel}筛选`">
      <button :class="{ active: !selected }" :aria-pressed="!selected" @click="emit('select', '')">全部</button>
      <button :class="{ active: selected === 'uncategorized' }" :aria-pressed="selected === 'uncategorized'" @click="emit('select', 'uncategorized')">未分类</button>
      <button v-for="root in roots" :key="root.id" :class="{ active: activeRoot === root.id }" :aria-pressed="activeRoot === root.id" @click="emit('select', root.id)">{{ root.name }}</button>
    </nav>
    <nav v-if="children.length" class="category-options category-suboptions" :aria-label="`${categoryLabel}子分类`">
      <span>子分类</span><button :class="{ active: selected === activeRoot }" :aria-pressed="selected === activeRoot" @click="emit('select', activeRoot)">全部子类</button>
      <button v-for="child in children" :key="child.id" :class="{ active: selected === child.id }" :aria-pressed="selected === child.id" @click="emit('select', child.id)">{{ child.name }}</button>
    </nav>
  </section>
</template>
