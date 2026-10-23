import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(root, 'dist/nodes/Modelflare')
await mkdir(target, { recursive: true })
for (const icon of ['modelflare.svg', 'modelflare.dark.svg']) {
  await copyFile(path.join(root, 'nodes/Modelflare', icon), path.join(target, icon))
}
