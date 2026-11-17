import { readonly, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
const storageKey = 'model-library.theme'
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const preference = ref<ThemePreference>('system')
const resolved = ref<ResolvedTheme>('light')
export const themePreference = readonly(preference)
export const resolvedTheme = readonly(resolved)

function parsePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}
function applyTheme() {
  resolved.value = preference.value === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference.value
  document.documentElement.dataset.theme = resolved.value
  document.documentElement.style.colorScheme = resolved.value
}
export function setThemePreference(value: ThemePreference) {
  preference.value = parsePreference(value)
  try { window.localStorage.setItem(storageKey, preference.value) } catch { /* In restricted browsers, keep the preference for this page. */ }
  applyTheme()
}
try { preference.value = parsePreference(window.localStorage.getItem(storageKey)) } catch { /* System mode also works when storage is unavailable. */ }
applyTheme()
systemTheme.addEventListener('change', () => { if (preference.value === 'system') applyTheme() })
window.addEventListener('storage', event => {
  if (event.storageArea === window.localStorage && (event.key === storageKey || event.key === null)) {
    preference.value = parsePreference(event.newValue)
    applyTheme()
  }
})
