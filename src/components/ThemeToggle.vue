<script setup lang="ts">
import { computed } from 'vue'
import { resolvedTheme, setThemePreference } from '../theme'
import AppIcon from './AppIcon.vue'
const nextTheme = computed(() => resolvedTheme.value === 'dark' ? 'light' : 'dark')
const label = computed(() => nextTheme.value === 'light' ? '切换为浅色主题' : '切换为深色主题')
</script>
<template>
  <button class="theme-toggle" type="button" :aria-label="label" :title="label" @click="setThemePreference(nextTheme)"><AppIcon :name="nextTheme === 'light' ? 'sun' : 'moon'" :size="20" /></button>
</template>
<style scoped>
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:36px;height:36px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--text-secondary);cursor:pointer}.theme-toggle:hover{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-soft-border)}.theme-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
