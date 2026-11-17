import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { zipSync, strToU8, unzipSync } from 'fflate'
import type { Category, DashboardPackage, Detail, ModelRecord, User, Version } from '../src/contracts'
import { createLegacyFixture, legacySession } from './legacy-fixture'
import { screenshotPng } from './png-fixture'
import { appVersion, type SystemInfo } from '../src/release'

interface RunningServer { child: ChildProcess; base: string }
interface Failure { error: string; code?: string; currentRevision?: number }
function glb(extra: Record<string, unknown> = {}): Buffer {
  const text = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], ...extra })
  const chunk = Buffer.from(text + ' '.repeat((4 - Buffer.byteLength(text) % 4) % 4))
  const output = Buffer.alloc(20 + chunk.length)
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(chunk.length, 12); output.writeUInt32LE(0x4e4f534a, 16); chunk.copy(output, 20)
  return output
}
async function start(data: string): Promise<RunningServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const lines = createInterface({ input: child.stdout! })
  try {
    for await (const line of lines) {
      const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (match && match[1] !== '0') return { child, base: match[0] }
    }
    throw new Error(`Server did not become ready: ${stderr}`)
  } finally { lines.close() }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit'); child.kill(); await exited
}
class Client {
  cookie = ''
  constructor(public base: string) {}
  async request<T = unknown>(path: string, method = 'GET', body?: unknown, expected = 200, headers: Record<string, string> = {}): Promise<T> {
    const form = body instanceof FormData
    const response = await fetch(this.base + '/api' + path, {
      method, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    })
    const cookie = response.headers.get('set-cookie')
    if (cookie) this.cookie = cookie.split(';')[0]!
    const value: unknown = response.status === 204 ? null : await response.json()
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`)
    return value as T
  }
  upload<T = ModelRecord>(path: string, buffer: Buffer, fields: Record<string, string> = {}, expected = 201, name = '设备.glb') {
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(buffer)]), name)
    form.append('idempotencyKey', fields.idempotencyKey || randomUUID())
    for (const [key, value] of Object.entries(fields)) if (key !== 'idempotencyKey') form.append(key, value)
    return this.request<T>(path, 'POST', form, expected)
  }
  async binary(path: string, expected = 200) {
    const response = await fetch(this.base + '/api' + path, { headers: { Cookie: this.cookie } })
    assert.equal(response.status, expected)
    return Buffer.from(await response.arrayBuffer())
  }
}

test('team libraries, categories, immutable versions, conflicts and idempotent upload', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-library-v2-'))
  let running: RunningServer | undefined
  try {
    running = await start(directory)
    const admin = new Client(running.base), editor = new Client(running.base), viewer = new Client(running.base), anonymous = new Client(running.base)
    await admin.request('/setup', 'POST', { username: 'admin', displayName: '管理员', password: '12345' }, 400)
    await admin.request('/setup', 'POST', { username: 'admin', displayName: '管理员', password: '123456' }, 201)
    const editorUser = await admin.request<User>('/users', 'POST', { username: 'editor', displayName: '编辑者', password: 'abcdef', role: 'editor' }, 201)
    await admin.request('/users', 'POST', { username: 'viewer', displayName: '查看者', password: 'abcdef', role: 'viewer' }, 201)
    await editor.request('/login', 'POST', { username: 'editor', password: 'abcdef' })
    await viewer.request('/login', 'POST', { username: 'viewer', password: 'abcdef' })
    const original = glb(), updated = glb({ extras: { revision: 2 } })
    let asset: ModelRecord, parentCategory: Category, childCategory: Category, sceneCategory: Category, dashboard: ModelRecord
    let uploadKey = '', firstVersion: Version
    await t.test('all team members read libraries; viewer writes and unauthenticated file reads denied', async () => {
      await admin.request('/setup', 'POST', { username: 'other', displayName: '其他', password: '123456' }, 409)
      await admin.request('/categories', 'POST', { kind: 'asset', name: '跨域' }, 403, { Origin: 'https://untrusted.invalid' })
      await admin.request('/projects', 'GET', undefined, 404)
      asset = await editor.upload('/records', original, { kind: 'asset', name: '设备', tags: '["工业"]' })
      firstVersion = asset.currentVersion
      assert.equal((await viewer.request<ModelRecord[]>('/records?kind=asset'))[0]!.id, asset.id)
      await viewer.upload('/records', original, { kind: 'asset', name: '禁止' }, 403)
      await anonymous.binary(`/versions/${firstVersion.id}/file`, 401)
      await anonymous.binary(`/versions/${firstVersion.id}/thumbnail`, 401)
      assert.deepEqual(await viewer.binary(`/versions/${firstVersion.id}/file`), original)
    })
    await t.test('system information is live, authenticated and hides deployment paths from viewers', async () => {
      await anonymous.request('/system', 'GET', undefined, 401)
      const info = await admin.request<SystemInfo>('/system')
      assert.equal(info.version, appVersion)
      assert.equal(info.records.asset, 1)
      assert.equal(info.versionCount, 1)
      assert.equal(info.sourceBytes, original.length)
      assert.equal(info.dataDirectory, directory)
      const publicInfo = await viewer.request<SystemInfo>('/system')
      assert.equal(publicInfo.dataDirectory, undefined)
      assert.equal(publicInfo.runtime, undefined)
    })
    await t.test('categories are independent two-level trees; parent includes descendants', async () => {
      parentCategory = await editor.request<Category>('/categories', 'POST', { kind: 'asset', name: '设备', parentId: null }, 201)
      childCategory = await editor.request<Category>('/categories', 'POST', { kind: 'asset', name: '水泵', parentId: parentCategory.id }, 201)
      sceneCategory = await editor.request<Category>('/categories', 'POST', { kind: 'scene', name: '设备', parentId: null }, 201)
      await editor.request('/categories', 'POST', { kind: 'asset', name: '三级', parentId: childCategory.id }, 400)
      await editor.request('/categories', 'POST', { kind: 'scene', name: '跨库', parentId: parentCategory.id }, 400)
      await viewer.request('/categories', 'POST', { kind: 'asset', name: '禁止', parentId: null }, 403)
      asset = await editor.request<ModelRecord>(`/records/${asset.id}`, 'PATCH', { categoryId: childCategory.id, expectedRevision: asset.revision })
      await editor.request(`/records/${asset.id}`, 'PATCH', { categoryId: sceneCategory.id, expectedRevision: asset.revision }, 400)
      const list = await viewer.request<ModelRecord[]>(`/records?kind=asset&categoryId=${parentCategory.id}`)
      assert.deepEqual(list.map(r => r.id), [asset.id])
      const filtered = await viewer.request<ModelRecord[]>(`/records?kind=asset&q=${encodeURIComponent('工业')}`)
      assert.deepEqual(filtered.map(r => r.id), [asset.id])
    })
    await t.test('stale metadata, upload and rollback reject; ABA rollback cannot hide changes', async () => {
      const baseline = asset.revision
      const key = randomUUID()
      const second = await editor.upload<Version>(`/records/${asset.id}/versions`, updated, { expectedRevision: String(baseline), note: '新版本', idempotencyKey: key })
      const conflict = await admin.upload<Failure>(`/records/${asset.id}/versions`, updated, { expectedRevision: String(baseline) }, 409)
      assert.equal(conflict.code, 'VERSION_CONFLICT')
      await editor.request(`/records/${asset.id}`, 'PATCH', { name: '过期改名', expectedRevision: baseline }, 409)
      await editor.request(`/records/${asset.id}/current`, 'POST', { versionId: firstVersion.id, expectedRevision: baseline }, 409)
      let detail = await editor.request<Detail>(`/records/${asset.id}`)
      assert.equal(detail.versions.length, 2); assert.equal(detail.record.currentVersionId, second.id)
      await editor.request(`/records/${asset.id}/current`, 'POST', { versionId: firstVersion.id, expectedRevision: detail.record.revision }, 204)
      detail = await editor.request<Detail>(`/records/${asset.id}`)
      assert.ok(detail.record.revision > baseline)
      await editor.request(`/records/${asset.id}`, 'PATCH', { name: 'ABA过期', expectedRevision: baseline }, 409)
      const replay = await editor.upload<Version>(`/records/${asset.id}/versions`, updated, { expectedRevision: String(baseline), note: '新版本', idempotencyKey: key })
      assert.equal(replay.id, second.id)
      detail = await editor.request<Detail>(`/records/${asset.id}`)
      assert.equal(detail.record.currentVersionId, firstVersion.id)
      assert.equal(detail.versions.length, 2)
      assert.deepEqual(await viewer.binary(`/versions/${firstVersion.id}/file?download=1`), original)
      asset = detail.record
    })
    await t.test('concurrent identical retries create one item; keys bind content and metadata', async () => {
      uploadKey = randomUUID()
      const fields = { kind: 'scene', name: '同名场景', idempotencyKey: uploadKey }
      const [one, two] = await Promise.all([editor.upload('/records', original, fields), editor.upload('/records', original, fields)])
      assert.equal(one.id, two.id)
      const list = await editor.request<ModelRecord[]>('/records?kind=scene')
      assert.deepEqual(list.map(r => r.id), [one.id])
      assert.equal((await editor.upload<Failure>('/records', updated, fields, 409)).code, 'IDEMPOTENCY_MISMATCH')
      assert.equal((await editor.upload<Failure>('/records', original, { ...fields, name: '改变名字' }, 409)).code, 'IDEMPOTENCY_MISMATCH')
      const independent = await editor.upload('/records', original, { ...fields, idempotencyKey: randomUUID() })
      assert.notEqual(independent.id, one.id)
      await editor.request(`/records/${asset.id}/current`, 'POST', { versionId: one.currentVersion.id, expectedRevision: asset.revision }, 400)
    })
    await t.test('category deletion preserves records under uncategorized', async () => {
      await editor.request(`/categories/${parentCategory.id}`, 'DELETE', undefined, 204)
      const list = await editor.request<ModelRecord[]>('/records?kind=asset&categoryId=uncategorized')
      assert.deepEqual(list.map(r => r.id), [asset.id])
      assert.equal((await editor.request<Detail>(`/records/${asset.id}`)).versions.length, 2)
    })
    await t.test('malformed GLB and external references fail without creating resources', async () => {
      await editor.upload('/records', Buffer.from('not a model'), { kind: 'asset', name: '坏文件' }, 400)
      await editor.upload('/records', glb({ images: [{ uri: 'https://untrusted.invalid/image.png' }] }), { kind: 'asset', name: '外部贴图' }, 400)
      assert.equal((await editor.request<ModelRecord[]>('/records?kind=asset')).length, 1)
    })
    await t.test('dashboard immutable HTML source, admin writes, screenshot not fabricated', async () => {
      const html = Buffer.from('<!doctype html><html><body><h1>生产看板</h1></body></html>')
      await editor.upload('/records', html, { kind: 'dashboard', name: '看板', entry: 'index.html' }, 403, 'index.html')
      dashboard = await admin.upload('/records', html, { kind: 'dashboard', name: '生产看板', entry: 'index.html' }, 201, 'index.html')
      assert.equal(dashboard.currentVersion.hasThumbnail, false)
      assert.deepEqual(await viewer.binary(`/versions/${dashboard.currentVersion.id}/source`), html)
      const pack = await viewer.request<DashboardPackage>(`/versions/${dashboard.currentVersion.id}/package`)
      assert.equal(pack.entry, 'index.html')
      assert.deepEqual(Buffer.from(pack.files.find(f => f.path === pack.entry)!.base64, 'base64'), html)
      await anonymous.binary(`/versions/${dashboard.currentVersion.id}/source`, 401)
      const archived = await admin.request<ModelRecord>(`/records/${dashboard.id}/archive`, 'PATCH', { archived: true, expectedRevision: dashboard.revision })
      assert.equal((await viewer.request<ModelRecord[]>('/records?kind=dashboard')).length, 0)
      assert.equal((await admin.request<ModelRecord[]>('/records?kind=dashboard&includeArchived=1'))[0]!.id, dashboard.id)
      assert.deepEqual(await viewer.binary(`/versions/${dashboard.currentVersion.id}/source`), html)
      dashboard = await admin.request<ModelRecord>(`/records/${dashboard.id}/archive`, 'PATCH', { archived: false, expectedRevision: archived.revision })
    })
    await t.test('screenshots require admin and are tied to one immutable version', async () => {
      const png = screenshotPng(), version = dashboard.currentVersion
      const fields = { idempotencyKey: randomUUID() }
      await editor.upload(`/versions/${version.id}/thumbnail`, png, fields, 403, 'screenshot.png')
      await admin.upload(`/versions/${version.id}/thumbnail`, png, fields, 204, 'screenshot.png')
      await admin.upload(`/versions/${version.id}/thumbnail`, png, fields, 204, 'screenshot.png')
      assert.deepEqual(await viewer.binary(`/versions/${version.id}/thumbnail`), png)
      const next = await admin.upload<Version>(`/records/${dashboard.id}/versions`, Buffer.from('<html><body>新版看板</body></html>'), { expectedRevision: String(dashboard.revision), entry: 'index.html' }, 201, 'index.html')
      assert.equal(next.hasThumbnail, false)
      await viewer.binary(`/versions/${next.id}/thumbnail`, 404)
      assert.deepEqual(await viewer.binary(`/versions/${version.id}/thumbnail`), png)
    })
    await t.test('ZIPs preserve bytes; folder exports preserve files; traversal and case collisions rejected', async () => {
      const files = { 'dist/index.html': strToU8('<html><script src="./app.js"></script></html>'), 'dist/app.js': strToU8('document.body.dataset.ready="yes"'), 'README.md': strToU8('说明') }
      const archive = Buffer.from(zipSync(files))
      const record = await admin.upload('/records', archive, { kind: 'dashboard', name: 'ZIP看板', entry: 'dist/index.html' }, 201, 'board.zip')
      assert.deepEqual(await viewer.binary(`/versions/${record.currentVersion.id}/source`), archive)
      const form = new FormData(); form.append('kind', 'dashboard'); form.append('name', '文件夹看板'); form.append('entry', 'dist/index.html'); form.append('idempotencyKey', randomUUID()); form.append('paths', JSON.stringify(Object.keys(files)))
      for (const [path, bytes] of Object.entries(files)) form.append('files[]', new Blob([new Uint8Array(bytes)]), path.split('/').pop())
      const folder = await admin.request<ModelRecord>('/records', 'POST', form, 201)
      const exported = unzipSync(await viewer.binary(`/versions/${folder.currentVersion.id}/source`))
      for (const [path, bytes] of Object.entries(files)) assert.deepEqual(exported[path], bytes)
      for (const entries of [{ '../index.html': strToU8('<html/>') }, { 'index.html': strToU8('<html/>'), 'A.js': strToU8('a'), 'a.js': strToU8('b') }]) await admin.upload('/records', Buffer.from(zipSync(entries)), { kind: 'dashboard', name: '危险包', entry: 'index.html' }, 400, 'bad.zip')
    })
    await t.test('role downgrade revokes session, last admin protected', async () => {
      const me = await admin.request<{ user: User }>('/me')
      await admin.request(`/users/${me.user.id}`, 'PATCH', { role: 'viewer' }, 400)
      await admin.request(`/users/${editorUser.id}`, 'PATCH', { role: 'viewer' })
      await editor.request('/me', 'GET', undefined, 401)
      await editor.request('/login', 'POST', { username: 'editor', password: 'abcdef' })
      await editor.upload('/records', original, { kind: 'asset', name: '不允许' }, 403)
    })
    await t.test('restart retains receipt and session, retry cannot duplicate successful upload', async () => {
      await stop(running!.child); running = await start(directory)
      admin.base = running.base; viewer.base = running.base; editor.base = running.base
      assert.equal((await admin.request<{ user: User }>('/me')).user.role, 'admin')
      // Restore editor permission and login: receipt belongs to the same account after session renewal.
      await admin.request(`/users/${editorUser.id}`, 'PATCH', { role: 'editor' })
      await editor.request('/login', 'POST', { username: 'editor', password: 'abcdef' })
      const before = await editor.request<ModelRecord[]>('/records?kind=scene')
      const replay = await editor.upload('/records', original, { kind: 'scene', name: '同名场景', idempotencyKey: uploadKey })
      assert.ok(before.some(r => r.id === replay.id))
      assert.equal((await editor.request<ModelRecord[]>('/records?kind=scene')).length, before.length)
    })
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})

test('v1 migration preserves model identities, source bytes, history, sessions and derives roles', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-library-migration-'))
  let running: RunningServer | undefined
  try {
    const original = glb()
    createLegacyFixture(directory, original)
    running = await start(directory)
    const admin = new Client(running.base); admin.cookie = `glb_session=${legacySession}`
    assert.equal((await admin.request<{ user: User }>('/me')).user.role, 'admin')
    const detail = await admin.request<Detail>('/records/legacy-record')
    assert.equal(detail.record.currentVersionId, 'legacy-version'); assert.equal(detail.record.categoryId, null)
    assert.equal(detail.versions[0]!.number, 1)
    assert.deepEqual(await admin.binary('/versions/legacy-version/file'), original)
    const users = await admin.request<User[]>('/users')
    assert.equal(users.find(u => u.id === 'legacy-editor')!.role, 'editor')
    assert.equal(users.find(u => u.id === 'legacy-viewer')!.role, 'viewer')
    await admin.request('/projects', 'GET', undefined, 404)
    await stop(running.child); running = undefined
    const database = new Database(join(directory, 'manager.sqlite'), { readonly: true })
    assert.equal(database.pragma('user_version', { simple: true }), 2)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('projects','project_members')").all().length, 0)
    database.close()
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})
