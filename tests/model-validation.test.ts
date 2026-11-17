import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_MAX_BYTES } from '../src/limits.js'
import { HttpError, validateGlb } from '../server/validation.js'

function jsonChunk(extra: Record<string, unknown>): Buffer {
  const json = JSON.stringify({ asset: { version: '2.0' }, ...extra })
  return Buffer.from(json + ' '.repeat((4 - Buffer.byteLength(json) % 4) % 4))
}

// Write only headers/JSON: the binary body is a sparse zero-filled file, not a huge allocation.
async function sparseGlb(filename: string, extra: Record<string, unknown>, binLength?: number): Promise<number> {
  const json = jsonChunk(extra)
  const size = 20 + json.length + (binLength === undefined ? 0 : 8 + binLength)
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(size, 8)
  header.writeUInt32LE(json.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16)
  const file = await open(filename, 'w')
  try {
    await file.write(header, 0, header.length, 0)
    await file.write(json, 0, json.length, 20)
    if (binLength !== undefined) {
      const binHeader = Buffer.alloc(8)
      binHeader.writeUInt32LE(binLength, 0)
      binHeader.writeUInt32LE(0x004e4942, 4)
      await file.write(binHeader, 0, binHeader.length, 20 + json.length)
    }
    await file.truncate(size)
  } finally { await file.close() }
  return size
}

function triangle(bufferLength: number): Record<string, unknown> {
  return {
    buffers: [{ byteLength: bufferLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }
}

function failure(pattern: RegExp): (error: unknown) => boolean {
  return error => error instanceof HttpError && error.status === 400 && pattern.test(error.message)
}

test('GLB models above 100 MiB and at the inclusive 512 MiB boundary validate without reading the BIN body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-large-validation-'))
  try {
    const large = join(directory, 'large.glb')
    const size = await sparseGlb(large, triangle(101 * 1024 * 1024), 101 * 1024 * 1024)
    assert.ok(size > 100 * 1024 * 1024)
    await validateGlb(large, size)

    const boundary = join(directory, 'boundary.glb')
    // Iterate the decimal byteLength field until JSON and BIN sizes produce exactly 512 MiB.
    let binLength = MODEL_MAX_BYTES - 1024
    for (;;) {
      const next = MODEL_MAX_BYTES - 28 - jsonChunk(triangle(binLength)).length
      if (next === binLength) break
      binLength = next
    }
    const boundarySize = await sparseGlb(boundary, triangle(binLength), binLength)
    assert.equal(boundarySize, MODEL_MAX_BYTES)
    await validateGlb(boundary, boundarySize)
    // The size guard runs before opening a file or allocating JSON.
    await assert.rejects(validateGlb(join(directory, 'not-created.glb'), MODEL_MAX_BYTES + 1), failure(/512 MiB.*536870913/))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('GLB permits alignment padding and unused BIN tail while still bounding bufferViews to declared buffer bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-bin-validation-'))
  try {
    const filename = join(directory, 'model.glb')
    for (const padding of [0, 1, 2, 3]) {
      const declared = 4 - padding
      const size = await sparseGlb(filename, { buffers: [{ byteLength: declared }], bufferViews: [{ buffer: 0, byteLength: declared }] }, 4)
      await validateGlb(filename, size)
    }
    // Khronos glTF 2.0 GLB-stored Buffer requires BIN >= byteLength, not a <=3-byte tail.
    // GLTFLoader.loadBuffer returns BIN; loadBufferView slices only the declared view range.
    // https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-stored-buffer
    const tailSize = await sparseGlb(filename, triangle(36), 64)
    await validateGlb(filename, tailSize)
    const badView = await sparseGlb(filename, { buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 32, byteLength: 8 }] }, 64)
    await assert.rejects(validateGlb(filename, badView), failure(/bufferViews\[0\].*32.*8.*36/))
    const emptyView = await sparseGlb(filename, { buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteLength: 0 }] }, 4)
    await assert.rejects(validateGlb(filename, emptyView), failure(/bufferViews\[0\]/))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('GLB rejects missing, short, truncated and malformed BIN with declared and actual sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-truncation-validation-'))
  try {
    const filename = join(directory, 'model.glb')
    const missing = await sparseGlb(filename, { buffers: [{ byteLength: 8 }] })
    await assert.rejects(validateGlb(filename, missing), failure(/8.*缺少 BIN/))
    const short = await sparseGlb(filename, { buffers: [{ byteLength: 8 }] }, 4)
    await assert.rejects(validateGlb(filename, short), failure(/声明 8 字节.*实际只有 4 字节/))

    const full = await sparseGlb(filename, triangle(36), 36)
    const handle = await open(filename, 'r+')
    try { await handle.truncate(full - 4) } finally { await handle.close() }
    await assert.rejects(validateGlb(filename, full), failure(new RegExp(`上传报告 ${full} 字节.*实际 ${full - 4} 字节`)))
    await assert.rejects(validateGlb(filename, full - 4), failure(new RegExp(`文件头声明 ${full} 字节.*实际 ${full - 4} 字节`)))

    const truncated = await open(filename, 'r+')
    try {
      const size = Buffer.alloc(4); size.writeUInt32LE(full - 4)
      await truncated.write(size, 0, 4, 8)
    } finally { await truncated.close() }
    await assert.rejects(validateGlb(filename, full - 4), failure(/BIN.*声明 36 字节.*实际剩余 32 字节/))
    const unaligned = await sparseGlb(filename, { buffers: [{ byteLength: 3 }] }, 3)
    await assert.rejects(validateGlb(filename, unaligned), failure(/3 字节未按 4 字节对齐/))
    await writeFile(filename, Buffer.alloc(20))
    await assert.rejects(validateGlb(filename, 20), failure(/有效的 GLB 2.0/))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('JSON-only GLB is valid; zero-byte buffers are not valid under the official glTF schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-empty-validation-'))
  try {
    const filename = join(directory, 'model.glb')
    const emptyScene = await sparseGlb(filename, { scenes: [{ nodes: [] }], scene: 0 })
    await validateGlb(filename, emptyScene)
    // https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/schema/buffer.schema.json
    const zero = await sparseGlb(filename, { buffers: [{ byteLength: 0 }] })
    await assert.rejects(validateGlb(filename, zero), failure(/buffers\[0\].*1–.*实际为 0/))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
