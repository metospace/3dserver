<script setup lang="ts">
import { setThemePreference, themePreference } from '../theme'

function changeTheme(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'light' || value === 'dark' || value === 'system') setThemePreference(value)
}
</script>

<template>
  <label class="theme-switch"><span>主题</span><select :value="themePreference" aria-label="主题" @change="changeTheme"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label>
</template>
