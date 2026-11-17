<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  cube: 'M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Zm0 9L3 7.5M12 12l9-4.5M12 12v9M7.5 5.25l9 4.5',
  scene: 'm3 17 6-8 4 5 3-3 5 6H3ZM4 21h16M17 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
  folder: 'M3 7V4h6l3 3h9v13H3V7Z',
  users: 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM2 21v-3a6 6 0 0 1 12 0v3M16 4a4 4 0 0 1 0 8m1 3a5 5 0 0 1 5 5v1',
  arrow: 'm9 5 7 7-7 7',
  back: 'm15 5-7 7 7 7',
  close: 'm6 6 12 12M6 18 18 6',
  download: 'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  logout: 'M9 4H3v16h6m6-13 5 5-5 5M8 12h12',
  edit: 'm4 16 11-11 4 4L8 20H4v-4ZM13 7l4 4',
  check: 'm5 12 4 4L19 6',
  settings: 'M9 3h6l.5 3 2 1.2 2.9-1 3 5.2-2.4 2v2.3l2.4 2-3 5.2-2.9-1L15.5 23h-6L9 20l-2-1.2-2.9 1-3-5.2 2.4-2v-2.3l-2.4-2 3-5.2 2.9 1L9 3ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42',
  moon: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z',
}
</script>
<template><svg :width="size || 20" :height="size || 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.cube" /></svg></template>
