import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(root, 'dist/nodes/Modelflare')
await mkdir(target, { recursive: true })
await copyFile(path.join(root, './shared/brand/logo.svg'), path.join(target, 'modelflare.svg'))
