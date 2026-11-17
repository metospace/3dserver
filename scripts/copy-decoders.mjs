import { mkdir, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const threeRoot = resolve(dirname(require.resolve('three')), '..')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const decoderSets = [
  { name: 'draco', source: 'examples/jsm/libs/draco/gltf', files: ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'] },
  { name: 'basis', source: 'examples/jsm/libs/basis', files: ['basis_transcoder.js', 'basis_transcoder.wasm'] },
]

for (const { name, source, files } of decoderSets) {
  const target = join(projectRoot, 'public', 'decoders', name)
  await mkdir(target, { recursive: true })
  for (const file of files) await copyFile(join(threeRoot, source, file), join(target, file))
  await copyFile(join(threeRoot, 'examples', 'jsm', 'libs', name, 'README.md'), join(target, 'README.md'))
}
await copyFile(join(threeRoot, 'LICENSE'), join(projectRoot, 'public', 'decoders', 'THREE-LICENSE.txt'))
console.log('本地 Draco / KTX2 解码器已复制；Meshopt 由应用直接打包。')
