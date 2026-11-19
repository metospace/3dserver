import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
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
async function start(data: string, environment: NodeJS.ProcessEnv = {}): Promise<RunningServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, CHAT3D_TEAM_PASSWORD_LOGIN: '1', CHAT3D_PLATFORM_AUTH_BASE: '', ...environment, PORT: '0', HOST: '127.0.0.1', DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
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
      asset = await editor.upload('/records', original, { kind: 'asset', name: '设备', tags: '["工业"]', note: '初次导入 · 原始材质 ✅' })
      firstVersion = asset.currentVersion
      assert.equal(firstVersion.note, '初次导入 · 原始材质 ✅')
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
    await t.test('Unicode version notes round-trip and can be explicitly corrected with conflict protection', async () => {
      const current = await editor.request<Detail>(`/records/${asset.id}`)
      const note = '高压线束工作台 · 初次导入，保留原始材质 ✅'
      const changed = await editor.request<Detail>(`/versions/${firstVersion.id}/note`, 'PATCH', { note, expectedRevision: current.record.revision })
      assert.equal(changed.versions.find(version => version.id === firstVersion.id)!.note, note)
      await viewer.request(`/versions/${firstVersion.id}/note`, 'PATCH', { note: '禁止修改', expectedRevision: changed.record.revision }, 403)
      await editor.request(`/versions/${firstVersion.id}/note`, 'PATCH', { note: '过期修改', expectedRevision: current.record.revision }, 409)
      assert.deepEqual(await viewer.binary(`/versions/${firstVersion.id}/file`), original)
      const read = await viewer.request<Detail>(`/records/${asset.id}`)
      assert.equal(read.versions.find(version => version.id === firstVersion.id)!.note, note)
      asset = changed.record
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
    assert.equal(database.pragma('user_version', { simple: true }), 3)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('projects','project_members')").all().length, 0)
    database.close()
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})

interface TeamItem { id: string; version: number; kind: string; owner: string; name: string; description: string; categoryPath: string[]; sourceKind: string; payload?: unknown }
interface TeamSession { token: string; user: { id: string; name: string; role: string } }
async function teamRequest<T>(base: string, path: string, options: { token?: string; body?: unknown; status?: number; headers?: Record<string, string>; binary?: boolean } = {}) {
  const { token, body, status = 200, headers, binary } = options
  const response = await fetch(`${base}/api/team/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (binary) {
    assert.equal(response.status, status, path)
    return Buffer.from(await response.arrayBuffer()) as T
  }
  const value = await response.json()
  assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`)
  return value as T
}

test('team items expose management GLB pointers, metadata, original bytes and thumbnails', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'team-management-glb-'))
  let running: RunningServer | undefined
  try {
    running = await start(directory)
    const { base } = running, manager = new Client(base)
    await manager.request('/setup', 'POST', { username: 'admin', password: 'example-admin', displayName: '管理员' }, 201)
    const { token } = await teamRequest<TeamSession>(base, 'login', { body: { name: 'admin', password: 'example-admin' } })
    const parent = await manager.request<Category>('/categories', 'POST', { kind: 'asset', name: '设备', parentId: null }, 201)
    const child = await manager.request<Category>('/categories', 'POST', { kind: 'asset', name: '水泵', parentId: parent.id }, 201)
    const original = glb(), newer = glb({ extras: { revision: 2 } }), png = screenshotPng()
    const asset = await manager.upload('/records', original, { kind: 'asset', name: '管理水泵', description: '独有说明', categoryId: child.id })
    await manager.upload(`/versions/${asset.currentVersion.id}/thumbnail`, png, {}, 204, 'thumbnail.png')
    let detail = await manager.request<Detail>(`/records/${asset.id}`)
    const next = await manager.upload<Version>(`/records/${asset.id}/versions`, newer, { expectedRevision: String(detail.record.revision) })
    detail = await manager.request<Detail>(`/records/${asset.id}`)
    await manager.request(`/records/${asset.id}/current`, 'POST', { expectedRevision: detail.record.revision, versionId: asset.currentVersion.id }, 204)
    const scene = await manager.upload('/records', newer, { kind: 'scene', name: '管理场景', description: '未分类场景' })
    const dashboard = await manager.upload('/records', Buffer.from('<h1>看板</h1>'), { kind: 'dashboard', name: '管理看板' }, 201, 'index.html')
    const assets = await teamRequest<TeamItem[]>(base, 'items?kind=asset&q=', { token })
    assert.equal(assets.length, 1)
    assert.deepEqual(assets.map(item => [item.id, item.version, item.sourceKind, item.name, item.description, item.categoryPath]), [
      [asset.id, asset.currentVersion.number, 'glb', '管理水泵', '独有说明', ['设备', '水泵']],
    ])
    const scenes = await teamRequest<TeamItem[]>(base, 'items?kind=scene', { token })
    assert.deepEqual(scenes.map(item => [item.id, item.version, item.sourceKind, item.name, item.description, item.categoryPath]), [
      [scene.id, scene.currentVersion.number, 'glb', '管理场景', '未分类场景', []],
    ])
    assert.ok(!(await readdir(join(directory, 'files'))).some(name => name.endsWith('.json')))
    assert.ok(![...assets, ...scenes].some(item => item.id === dashboard.id))
    for (const query of ['管理水泵', '独有说明']) {
      assert.deepEqual((await teamRequest<TeamItem[]>(base, `items?kind=asset&q=${encodeURIComponent(query)}`, { token })).map(item => item.id), [asset.id])
    }
    const route = `items/${asset.id}/${asset.currentVersion.number}`
    assert.deepEqual(await teamRequest<Buffer>(base, route, { token, binary: true }), original)
    assert.equal(original.length, asset.currentVersion.size)
    const response = await fetch(`${base}/api/team/${route}`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') || '', /^(model\/gltf-binary|application\/octet-stream)(;|$)/)
    assert.equal(response.headers.get('content-length'), String(asset.currentVersion.size))
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original)
    assert.deepEqual(await teamRequest<Buffer>(base, `items/${scene.id}/1`, { token, binary: true }), newer)
    await teamRequest(base, `items/${asset.id}/${next.number}`, { token, status: 404 })
    assert.deepEqual(await teamRequest<Buffer>(base, `${route}/thumbnail`, { token, binary: true }), png)
    await teamRequest(base, `${route}/thumbnail`, { status: 401 })
    await teamRequest(base, `items/${scene.id}/1/thumbnail`, { token, status: 404 })
    await teamRequest(base, `items/${asset.id}/${next.number}/thumbnail`, { token, status: 404 })
    await teamRequest(base, 'publish', { token, status: 404, body: {
      key: randomUUID(), itemId: scene.id, expectedVersion: 1, kind: 'scene', name: '不可追加', description: '', categoryPath: [],
      payload: { format: 'chat3d-project', version: 1, scene: { schemaVersion: 1, projectId: 'native', revision: 1, unit: 'm', upAxis: 'Y', nodes: [], materials: [], assets: [] } },
    } })
    detail = await manager.request<Detail>(`/records/${asset.id}`)
    await manager.request(`/records/${asset.id}/archive`, 'PATCH', { archived: true, expectedRevision: detail.record.revision })
    assert.deepEqual(await teamRequest(base, 'items?kind=asset', { token }), [])
    await teamRequest(base, route, { token, status: 404 })
    await teamRequest(base, `${route}/thumbnail`, { token, status: 404 })
    assert.deepEqual((await teamRequest<TeamItem[]>(base, 'items?kind=scene', { token })).map(item => item.id), [scene.id])
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})

test('Chat3D sessions, resumable publications and historical reads share the management library', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat3d-publications-'))
  let running: RunningServer | undefined
  const clientOrigin = 'https://client.example.test'
  try {
    running = await start(directory, { CHAT3D_TEAM_ORIGINS: clientOrigin })
    let { base } = running
    const manager = new Client(base)
    await manager.request('/setup', 'POST', { username: 'admin', password: 'example-admin', displayName: '管理员' }, 201)
    const publisher = await manager.request<User>('/users', 'POST', { username: 'editor', password: 'example-editor', displayName: '编辑者', role: 'editor' }, 201)
    await manager.request('/users', 'POST', { username: 'viewer', password: 'example-viewer', displayName: '查看者', role: 'viewer' }, 201)
    const preflight = await fetch(`${base}/api/team/items`, { method: 'OPTIONS', headers: { Origin: clientOrigin, 'Access-Control-Request-Headers': 'authorization', 'Access-Control-Request-Method': 'GET' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), clientOrigin)
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
    await teamRequest(base, 'items?kind=scene', { headers: { Origin: 'https://untrusted.example.test' }, status: 403 })
    await teamRequest(base, 'me', { headers: { Cookie: manager.cookie }, status: 401 })
    const login = (name: string) => teamRequest<TeamSession>(base, 'login', { body: { name, password: `example-${name}` } })
    const { token, user } = await login('editor'), viewer = (await login('viewer')).token
    assert.equal(user.id, publisher.id)
    assert.equal(user.role, 'member')
    const desktop = await fetch(`${base}/api/team/me`, { headers: { Origin: 'tauri://localhost', Authorization: `Bearer ${token}` } })
    assert.equal(desktop.status, 200)
    assert.equal(desktop.headers.get('access-control-allow-origin'), 'tauri://localhost')
    assert.equal((await desktop.json()).id, publisher.id)
    await new Client(base).request('/me', 'GET', undefined, 401, { Authorization: `Bearer ${token}` })
    const key = randomUUID(), payload = { format: 'chat3d-project', version: 1, scene: {
      schemaVersion: 1, projectId: 'assembly', revision: 1, unit: 'm', upAxis: 'Y', nodes: [], materials: [], assets: [],
      viewState: { displayUnit: 'm' },
    } }
    const body = { payload, name: '团队场景一', description: '', kind: 'scene', key, expectedVersion: 0, categoryPath: ['车间', '装配线'] }
    // Keep the published project small, but exercise a real multi-chunk wire package.
    const bytes = gzipSync(JSON.stringify({ ...body, transportFixture: randomBytes(1100000).toString('base64') }))
    const chunkBytes = 1024 * 1024, overall = createHash('sha256'), chunks: Buffer[] = []
    for (let cursor = 0; cursor < bytes.length; cursor += chunkBytes) {
      const chunk = bytes.subarray(cursor, cursor + chunkBytes); chunks.push(chunk)
      overall.update(createHash('sha256').update(chunk).digest('hex'))
    }
    assert.equal(chunks.length, 2)
    const startBody = { key, total: bytes.length, digest: overall.digest('hex'), encoding: 'gzip' }
    await teamRequest(base, 'publish-uploads/start', { token: viewer, body: startBody, status: 403 })
    const startUpload = () => teamRequest<{ uploadId: string; offset: number; result?: TeamItem }>(base, 'publish-uploads/start', { token, body: startBody })
    const upload = await startUpload()
    const chunk = (index: number) => ({ offset: index * chunkBytes, data: chunks[index]!.toString('base64') })
    const chunkRoute = `publish-uploads/${upload.uploadId}/chunk`
    await teamRequest(base, chunkRoute, { token, body: chunk(1), status: 409 })
    await teamRequest(base, chunkRoute, { token, body: chunk(0) })
    await teamRequest(base, chunkRoute, { token, body: chunk(0) })
    await stop(running.child); running = undefined
    running = await start(directory, { CHAT3D_TEAM_ORIGINS: clientOrigin }); base = running.base; manager.base = base
    assert.equal((await startUpload()).offset, chunkBytes)
    await teamRequest(base, chunkRoute, { token, body: chunk(1) })
    const first = await teamRequest<TeamItem>(base, `publish-uploads/${upload.uploadId}/complete`, { token, body: {} })
    assert.deepEqual((await startUpload()).result, first)
    await teamRequest(base, 'publish', { token, body: { ...body, payload: {}, key: randomUUID() }, status: 400 })
    const replacement = { ...body, key: randomUUID(), itemId: first.id, name: '团队场景二', expectedVersion: 1 }
    const second = await teamRequest<TeamItem>(base, 'publish', { token, body: replacement })
    assert.equal(second.version, 2)
    assert.deepEqual(await teamRequest(base, 'publish', { token, body: replacement }), second)
    await teamRequest(base, 'publish', { token, body: { ...replacement, key: randomUUID() }, status: 409 })
    const rows = await teamRequest<TeamItem[]>(base, 'items?kind=scene', { token: viewer })
    assert.deepEqual(rows.map(row => [row.id, row.version, row.name]), [[second.id, 2, replacement.name]])
    assert.equal(rows[0]!.sourceKind, 'chat3d')
    const fixed = await teamRequest<TeamItem>(base, `items/${first.id}/1`, { token: viewer })
    assert.deepEqual(fixed.categoryPath, ['车间', '装配线'])
    assert.deepEqual(fixed.payload, payload)
    assert.equal(fixed.sourceKind, 'chat3d')
    const detail = await manager.request<Detail>(`/records/${first.id}`)
    assert.equal(detail.record.currentVersion.sourceKind, 'chat3d')
    assert.deepEqual(JSON.parse((await manager.binary(`/versions/${detail.versions[1]!.id}/source`)).toString()), payload)
    await manager.request(`/records/${first.id}/current`, 'POST', { expectedRevision: detail.record.revision, versionId: detail.versions[1]!.id }, 204)
    const rolledBack = await teamRequest<TeamItem[]>(base, 'items?kind=scene', { token: viewer })
    assert.deepEqual(rolledBack.map(item => [item.id, item.version, item.name, item.categoryPath]), [[second.id, 2, replacement.name, ['车间', '装配线']]])
    assert.deepEqual((await teamRequest<TeamItem>(base, `items/${first.id}/1`, { token: viewer })).payload, payload)
    await teamRequest(base, `items/${first.id}/99`, { token: viewer, status: 404 })
    const third = await teamRequest<TeamItem>(base, 'publish', { token, body: { ...replacement, key: randomUUID(), expectedVersion: 2 } })
    assert.equal(third.version, 3)
    const beforeDelete = await manager.request<Detail>(`/records/${first.id}`)
    await manager.request(`/records/${first.id}`, 'DELETE', { expectedRevision: beforeDelete.record.revision }, 204)
    assert.deepEqual(await teamRequest(base, 'items?kind=scene', { token: viewer }), [])
    for (const version of beforeDelete.versions) {
      await teamRequest(base, `items/${first.id}/${version.number}`, { token: viewer, status: 404 })
      await manager.binary(`/versions/${version.id}/source`, 404)
    }
    await teamRequest(base, 'publish-uploads/start', { token, body: startBody, status: 410 })
    await teamRequest(base, `publish-uploads/${upload.uploadId}/complete`, { token, body: {}, status: 410 })
    await teamRequest(base, 'publish', { token, body: replacement, status: 410 })
    assert.deepEqual(await readdir(join(directory, 'files')), [])
    await manager.request(`/users/${publisher.id}`, 'PATCH', { role: 'viewer' })
    await teamRequest(base, 'me', { token, status: 401 })
    await teamRequest(base, 'logout', { token: viewer, body: {} })
    await teamRequest(base, 'items?kind=scene', { token: viewer, status: 401 })
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})

test('administrators can delete complete native models without affecting other resources', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), '3dserver-delete-'))
  let running: RunningServer | undefined
  try {
    running = await start(directory)
    const admin = new Client(running.base), editor = new Client(running.base)
    await admin.request('/setup', 'POST', { username: 'admin', password: 'example-admin', displayName: '管理员' }, 201)
    await admin.request('/users', 'POST', { username: 'editor', password: 'example-editor', displayName: '编辑者', role: 'editor' }, 201)
    await editor.request('/login', 'POST', { username: 'editor', password: 'example-editor' })
    const binary = glb(), fields = { kind: 'asset', name: '待删资产', idempotencyKey: randomUUID() }
    const asset = await editor.upload('/records?kind=asset', binary, fields)
    const record = `/records/${asset.id}`
    const second = await editor.upload<Version>(`${record}/versions`, binary, { expectedRevision: String(asset.revision) })
    await editor.upload(`/versions/${second.id}/thumbnail`, screenshotPng(), {}, 204, 'thumbnail.png')
    const scene = await admin.upload('/records?kind=scene', binary, { kind: 'scene', name: '保留场景' })
    const board = await admin.upload('/records?kind=dashboard', Buffer.from('<h1>保留看板</h1>'), { kind: 'dashboard', name: '保留看板' }, 201, 'index.html')
    await admin.request(`/records/${board.id}`, 'DELETE', { expectedRevision: board.revision }, 400)
    await editor.request(record, 'DELETE', { expectedRevision: asset.revision + 1 }, 403)
    const stale = await admin.request<Failure>(record, 'DELETE', { expectedRevision: asset.revision }, 409)
    assert.equal(stale.code, 'VERSION_CONFLICT')
    const archived = await admin.request<ModelRecord>(`${record}/archive`, 'PATCH', { archived: true, expectedRevision: stale.currentRevision })
    await admin.request(record, 'DELETE', { expectedRevision: archived.revision }, 204)
    assert.deepEqual(await admin.request('/records?kind=asset&includeArchived=1'), [])
    await admin.request(record, 'GET', undefined, 404)
    await admin.binary(`/versions/${asset.currentVersionId}/file`, 404)
    await admin.binary(`/versions/${second.id}/thumbnail`, 404)
    await editor.upload('/records?kind=asset', binary, fields, 410)
    assert.deepEqual(await admin.binary(`/versions/${scene.currentVersionId}/file`), binary)
    assert.deepEqual(await readdir(join(directory, 'files')), [`${scene.currentVersionId}.glb`])
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})

test('Chat3D and management clients resolve the same dashboard versions, source, and confirmed screenshot', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat3d-dashboards-'))
  let running: RunningServer | undefined
  try {
    running = await start(directory)
    const { base } = running, manager = new Client(base)
    await manager.request('/setup', 'POST', { username: 'admin', password: 'example-admin', displayName: '管理员' }, 201)
    const { token } = await teamRequest<TeamSession>(base, 'login', { body: { name: 'admin', password: 'example-admin' } })
    const html = Buffer.from('<!doctype html><h1>看板模板</h1>')
    const native = await manager.upload('/records?kind=dashboard', html, { kind: 'dashboard', name: '车间监控' }, 201, 'index.html')
    const items = await teamRequest<TeamItem[]>(base, 'dashboards', { token })
    assert.deepEqual(items.map(item => item.id), [native.id])
    const key = randomUUID(), body = { key, itemId: native.id, name: '车间监控二', description: '', system: 'MES', entry: 'index.html', expectedVersion: 1, sourceKind: 'file', fileName: 'index.html' }
    const { uploadId } = await teamRequest<{ uploadId: string }>(base, 'dashboards/uploads', { token, body })
    const root = `dashboards/uploads/${uploadId}`
    const { fileId } = await teamRequest<{ fileId: string }>(base, `${root}/files`, { token, body: { path: 'index.html', size: html.length } })
    await teamRequest(base, `${root}/files/${fileId}/chunks`, { token, body: { offset: 0, base64: html.toString('base64') } })
    assert.deepEqual(await teamRequest(base, `${root}/complete`, { token, body: {} }), { id: native.id, version: 2 })
    assert.deepEqual(await teamRequest(base, `${root}/complete`, { token, body: {} }), { id: native.id, version: 2 })
    const source = await manager.request<Detail>(`/records/${native.id}`)
    assert.equal(source.record.currentVersion.number, 2)
    assert.deepEqual(await manager.binary(`/versions/${source.record.currentVersionId}/source`), html)
    const path = `dashboards/${native.id}/2`
    const manifest = await teamRequest<{ files: { path: string; bytes: number }[] }>(base, path, { token })
    assert.deepEqual(manifest.files, [{ path: 'index.html', bytes: html.length }])
    assert.deepEqual(await teamRequest<Buffer>(base, `${path}/files?path=index.html`, { token, binary: true }), html)
    const png = screenshotPng(320, 180)
    const identity = await teamRequest<{ packageHash: string }>(base, `${path}/screenshot/info`, { token })
    const screenshot = await teamRequest<{ id: string; width: number; height: number; sha256: string }>(base, `${path}/screenshot`, { token, body: {
      packageHash: identity.packageHash, expectedScreenshotId: null, source: '浏览器实际渲染', capturedAt: new Date().toISOString(), confirmed: true, base64: png.toString('base64'),
    } })
    assert.deepEqual([screenshot.width, screenshot.height], [320, 180])
    const stored = await teamRequest<Buffer>(base, `${path}/screenshot/${screenshot.id}`, { token, binary: true })
    assert.equal(createHash('sha256').update(stored).digest('hex'), screenshot.sha256)
    assert.deepEqual(await manager.binary(`/versions/${source.record.currentVersionId}/thumbnail`), stored)
    await teamRequest(base, `dashboards/${native.id}/archive`, { token, body: { archived: true } })
    assert.deepEqual(await teamRequest(base, 'dashboards', { token }), [])
    assert.deepEqual(await teamRequest<Buffer>(base, `${path}/source`, { token, binary: true }), html)
  } finally {
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})

test('Chat3D OAuth callback exchanges an exact redirect, claims once, and isolates platform identity', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat3d-auth-'))
  let running: RunningServer | undefined, revoked = false, tokenRequests = 0
  const platform = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/admin-api/system/oauth2/token') {
      tokenRequests++
      for await (const _ of req) { /* consume authorization form */ }
      res.end(JSON.stringify({ code: 0, data: { access_token: 'test-provider-access', refresh_token: 'test-provider-refresh', expires_in: 1200 } }))
    } else if (req.url === '/admin-api/system/auth/get-permission-info' && req.headers.authorization === 'Bearer test-provider-access' && req.headers['tenant-id'] === '1') {
      res.end(JSON.stringify(revoked ? { code: 401 } : { code: 0, data: { user: { id: 42, username: 'admin' } } }))
    } else { res.writeHead(404).end('{}') }
  })
  try {
    platform.listen(0, '127.0.0.1'); await once(platform, 'listening')
    const address = platform.address() as { port: number }
    running = await start(directory, { CHAT3D_PLATFORM_AUTH_BASE: `http://127.0.0.1:${address.port}`, CHAT3D_PLATFORM_OAUTH_CLIENT_SECRET: 'test-only-secret' })
    const { base } = running, manager = new Client(base)
    const { user: admin } = await manager.request<{ user: User }>('/setup', 'POST', { username: 'admin', displayName: '本地管理员', password: 'example-admin' }, 201)
    const state = randomUUID(), body = { code: 'test-provider-code', state, tenantId: '1', redirectUri: `${base}/team/sso/callback` }
    const callback = await fetch(body.redirectUri + '?code=test-provider-code&state=' + state)
    assert.equal(callback.status, 200)
    assert.ok(callback.headers.get('content-security-policy'))
    assert.doesNotMatch(await callback.text(), /test-provider-code/)
    await teamRequest(base, 'login/sso/code', { body: { ...body, redirectUri: 'https://unknown.example.test/team/sso/callback' }, status: 400 })
    assert.equal(tokenRequests, 0)
    const result = await teamRequest<TeamSession>(base, 'login/sso/code', { body })
    assert.notEqual(result.user.id, admin.id)
    assert.equal(result.user.role, 'member')
    const claim = await teamRequest<{ platform: { accessToken: string } }>(base, 'login/sso/claim', { body: { state } })
    assert.equal(claim.platform.accessToken, 'test-provider-access')
    await teamRequest(base, 'login/sso/claim', { body: { state }, status: 404 })

    assert.deepEqual(await manager.request('/auth/sso'), { available: true })
    await manager.request('/auth/sso/start', 'POST', {}, 403, { Origin: 'https://untrusted.example.test' })
    const startResponse = await fetch(`${base}/api/auth/sso/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(startResponse.status, 200)
    const stateCookie = startResponse.headers.get('set-cookie')!
    assert.match(stateCookie, /HttpOnly; SameSite=Lax/)
    const authorize = new URL((await startResponse.json()).url)
    const params = new URLSearchParams(authorize.hash.split('?')[1])
    const managerRedirect = params.get('redirect_uri')!
    assert.equal(managerRedirect, `${base}/api/auth/sso/callback`)
    const managerCallback = `${managerRedirect}?code=management-test-code&state=${params.get('state')}`
    const noCookie = await fetch(managerCallback, { redirect: 'manual' })
    assert.equal(noCookie.headers.get('location'), '/?sso=expired')
    assert.equal(tokenRequests, 1)
    const boundCallback = () => fetch(managerCallback, { redirect: 'manual', headers: { Cookie: stateCookie.split(';')[0]! } })
    const authorized = await boundCallback()
    assert.equal(authorized.headers.get('location'), '/')
    const browserSession = authorized.headers.getSetCookie().find(cookie => cookie.startsWith('glb_session='))!
    assert.match(browserSession, /HttpOnly; SameSite=Strict/)
    const web = new Client(base); web.cookie = browserSession.split(';')[0]!
    const { user: collaborative } = await web.request<{ user: User }>('/me')
    assert.equal(collaborative.id, result.user.id)
    assert.equal(collaborative.role, 'editor')
    await web.request('/users', 'GET', undefined, 403)
    assert.equal((await boundCallback()).headers.get('location'), '/?sso=expired')
    assert.equal(tokenRequests, 2)
    revoked = true
    await web.request('/categories', 'POST', { kind: 'asset', name: '已失效' }, 401)
    await web.request('/me', 'GET', undefined, 401)
    assert.equal((await manager.request<{ user: User }>('/me')).user.id, admin.id)
    await teamRequest(base, 'publish-uploads/start', { token: result.token, body: { key: randomUUID(), encoding: 'gzip', digest: '0'.repeat(64), total: 10 }, status: 401 })
    await teamRequest(base, 'me', { token: result.token, status: 401 })
  } finally {
    platform.closeAllConnections(); platform.close()
    if (running) await stop(running.child)
    await rm(directory, { recursive: true, force: true })
  }
})
