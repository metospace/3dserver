import { prepareDashboard } from './prepare'
import type { DashboardPackage } from '../contracts'

const nonce = window.location.hash.slice(1)
let started = false
const receive = async (event: MessageEvent) => {
  if (event.source !== parent || !event.data || event.data.kind !== 'dashboard-init' || event.data.nonce !== nonce || started) return
  started = true
  window.removeEventListener('message', receive)
  try {
    const prepared = await prepareDashboard(event.data.package as DashboardPackage, nonce)
    window.addEventListener('pagehide', prepared.dispose, { once: true })
    document.open()
    document.write(prepared.html)
    document.close()
    parent.postMessage({ kind: 'dashboard-ready', nonce }, '*')
  } catch (error) {
    parent.postMessage({ kind: 'dashboard-error', nonce, message: error instanceof Error ? error.message : '看板预览准备失败' }, '*')
  }
}
window.addEventListener('message', receive)
parent.postMessage({ kind: 'dashboard-shell-ready', nonce }, '*')
