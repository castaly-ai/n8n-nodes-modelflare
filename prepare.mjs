// Copies the network-free parts of @modelflare/core into the node, because
// verified n8n community nodes may not have runtime dependencies. HTTP goes
// through n8n's own request helpers instead.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(root, './shared/core-ts/src')
const target = path.join(root, 'nodes/Modelflare/core')
const files = ['attribution.ts', 'classify.ts', 'config.ts', 'errors.ts', 'messages.ts', 'signup.ts']

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const file of files) await copyFile(path.join(source, file), path.join(target, file))

const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
await writeFile(path.join(target, 'version.ts'), `export const VERSION = ${JSON.stringify(version)}\n`)
