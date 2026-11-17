import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUuid } from '../src/uuid'

test('UUID generation requires only getRandomValues, not secure-context randomUUID', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const source = Uint8Array.from({ length: 16 }, (_, index) => index)
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues(target: Uint8Array) { target.set(source); return target } },
  })
  try {
    assert.equal(createUuid(), '00010203-0405-4607-8809-0a0b0c0d0e0f')
    source.fill(255)
    assert.equal(createUuid(), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
})
