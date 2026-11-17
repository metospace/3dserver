import type { Version } from './contracts'
export type { Category, DashboardManifest, DashboardPackage, Detail, Kind, ModelKind, ModelRecord, Role, User, Version } from './contracts'

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public currentRevision?: number) { super(message) }
}

function failure(status: number, body: unknown): ApiError {
  const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : `请求失败（${status}）`
  const code = typeof body === 'object' && body && 'code' in body && typeof body.code === 'string' ? body.code : undefined
  const revision = typeof body === 'object' && body && 'currentRevision' in body && typeof body.currentRevision === 'number' ? body.currentRevision : undefined
  return new ApiError(message, status, code, revision)
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => null)
  if (!response.ok) throw failure(response.status, body)
  return body as T
}

export function upload<T>(path: string, data: FormData, progress: (value: number) => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const xhr = new XMLHttpRequest()
  xhr.open('POST', `/api${path}`)
  xhr.responseType = 'json'
  xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)) }
  xhr.onerror = () => reject(new Error('网络连接中断，请检查服务后重试'))
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T)
    else reject(failure(xhr.status, xhr.response))
  }
  xhr.send(data)
  return promise
}

export const json = (value: unknown) => JSON.stringify(value)
export const fileUrl = (id: string, download = false) => `/api/versions/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`
export const thumbnailUrl = (id: string) => `/api/versions/${encodeURIComponent(id)}/thumbnail`
export const sourceUrl = (version: Version) => version.sourceKind === 'glb' ? fileUrl(version.id, true) : `/api/versions/${encodeURIComponent(version.id)}/source`
export const splitTags = (value: string) => [...new Set(value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))]
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
export const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
