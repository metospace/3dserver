import { prepareDashboard } from './prepare'
import { captureDashboardViewport } from './capture'
import type { DashboardPackage } from '../contracts'

const nonce = window.location.hash.slice(1)
const hostOrigin = window.location.origin
let started = false
const receive = async (event: MessageEvent) => {
  if (event.source !== parent || event.origin !== hostOrigin || event.data?.kind !== 'dashboard-init' || event.data.nonce !== nonce || started || event.ports.length !== 1) return
  started = true
  window.removeEventListener('message', receive)
  const [capturePort] = event.ports
  try {
    const prepared = await prepareDashboard(event.data.package as DashboardPackage, nonce)
    let capturing = false
    document.open()
    // document.open clears Window listeners. Restore lifecycle hooks before uploaded scripts run.
    window.addEventListener('pagehide', () => { capturePort.close(); prepared.dispose() }, { once: true })
    window.addEventListener('load', () => {
      capturePort.onmessage = async ({ data }) => {
        if (data?.kind !== 'dashboard-capture' || data.nonce !== nonce || typeof data.requestId !== 'string') return
        const { requestId } = data
        const reply = (result: { png: Blob } | { error: string }) => capturePort.postMessage({ kind: 'dashboard-capture-result', nonce, requestId, ...result })
        if (capturing) {
          reply({ error: '上一次截图尚未结束，请稍后重试。' })
          return
        }
        capturing = true
        try {
          const png = await captureDashboardViewport(AbortSignal.timeout(10_000))
          reply({ png })
        } catch (error) {
          reply({ error: error instanceof Error ? error.message : '隔离预览截图失败。' })
        } finally {
          capturing = false
        }
      }
      capturePort.postMessage({ kind: 'dashboard-ready', nonce })
    }, { once: true })
    document.write(prepared.html)
    document.close()
  } catch (error) {
    capturePort.close()
    parent.postMessage({ kind: 'dashboard-error', nonce, message: error instanceof Error ? error.message : '看板预览准备失败' }, hostOrigin)
  }
}
window.addEventListener('message', receive)
parent.postMessage({ kind: 'dashboard-shell-ready', nonce }, hostOrigin)
