import { readonly, ref } from 'vue'
import type { Kind } from './contracts'

export interface Preferences { defaultLibrary: Kind; defaultSort: 'updated' | 'name' | 'size' }
const key = 'model-library.preferences'
const defaults: Preferences = { defaultLibrary: 'asset', defaultSort: 'updated' }
function parse(value: unknown): Preferences {
  const source = value && typeof value === 'object' ? value : {}
  return {
    defaultLibrary: 'defaultLibrary' in source && (source.defaultLibrary === 'scene' || source.defaultLibrary === 'dashboard') ? source.defaultLibrary : 'asset',
    defaultSort: 'defaultSort' in source && (source.defaultSort === 'name' || source.defaultSort === 'size') ? source.defaultSort : 'updated',
  }
}
let initial = defaults
try { initial = parse(JSON.parse(localStorage.getItem(key) || 'null')) } catch { /* Use defaults when browser storage is unavailable or malformed. */ }
const value = ref<Preferences>(initial)
export const preferences = readonly(value)
export function savePreferences(next: Preferences) {
  const clean = parse(next)
  localStorage.setItem(key, JSON.stringify(clean))
  value.value = clean
}
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) {
    try { value.value = parse(event.newValue ? JSON.parse(event.newValue) : null) } catch { value.value = { ...defaults } }
  }
})
