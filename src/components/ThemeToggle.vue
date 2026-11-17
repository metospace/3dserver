<script setup lang="ts">
import { computed } from 'vue'
import { resolvedTheme, setThemePreference } from '../theme'
import AppIcon from './AppIcon.vue'
const dark = computed(() => resolvedTheme.value === 'dark')
const label = computed(() => dark.value ? '切换为浅色主题' : '切换为深色主题')
</script>
<template>
  <button class="theme-toggle" :class="{ 'is-dark': dark }" type="button" role="switch" aria-label="深色主题" :aria-checked="dark" :title="label" @click="setThemePreference(dark ? 'light' : 'dark')"><span class="theme-sun" aria-hidden="true"><AppIcon name="sun" :size="20" /></span><span class="theme-moon" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M19.5 15.7A8.3 8.3 0 0 1 8.3 4.5a8.5 8.5 0 1 0 11.2 11.2Z"/><path d="m17 2 .7 2.3L20 5l-2.3.7L17 8l-.7-2.3L14 5l2.3-.7ZM21 8l.4 1.3L23 10l-1.6.5L21 12l-.5-1.5L19 10l1.5-.7Z"/></svg></span><span class="theme-thumb" aria-hidden="true"></span></button>
</template>
<style scoped>
.theme-toggle{position:relative;display:inline-flex;align-items:center;justify-content:space-between;flex-shrink:0;width:72px;height:38px;padding:0 8px;border:1px solid #555b66;border-radius:999px;background:#17191e;box-shadow:inset 0 1px 3px #0006;cursor:pointer;isolation:isolate}.theme-sun,.theme-moon{display:flex;align-items:center;justify-content:center;width:23px;height:26px;color:#f7ce49;transition:opacity .18s ease}.theme-sun{opacity:0}.theme-moon{opacity:1}.theme-thumb{position:absolute;top:4px;left:4px;width:28px;height:28px;border-radius:50%;background:#fff;box-shadow:0 1px 4px #0005;transition:transform .2s ease;z-index:1}.theme-toggle.is-dark .theme-thumb{transform:translateX(34px)}.theme-toggle.is-dark .theme-sun{opacity:1}.theme-toggle.is-dark .theme-moon{opacity:0}.theme-toggle:hover{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-ring)}.theme-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(prefers-reduced-motion:reduce){.theme-thumb,.theme-sun,.theme-moon{transition:none}}
</style>
