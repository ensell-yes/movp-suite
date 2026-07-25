import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const CLIENT_ROOT = resolve('dist/client')
const MAX_FILE_BYTES = 2 * 1024 * 1024
const BOOTSTRAP_MARKERS = [
  'content_overlay_capability_probe_failed',
  'movp-overlay-negative-v1',
]
const OVERLAY_MARKERS = [
  'movp-overlay__control',
  'You no longer have permission to edit this field.',
]

async function regularFile(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`overlay_bundle_file_invalid:${path}`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`overlay_bundle_file_too_large:${path}`)
  return readFile(path, 'utf8')
}

async function guardedFiles(root) {
  const info = await lstat(root)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`overlay_bundle_directory_invalid:${root}`)
  }
  const names = await readdir(root)
  const files = []
  for (const name of names) {
    const path = join(root, name)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) throw new Error(`overlay_bundle_symlink_rejected:${path}`)
    if (entry.isFile()) files.push(path)
  }
  return files
}

function staticImports(source) {
  const imports = []
  const pattern = /\b(?:import|export)\s*(?:[^"'`]*?\sfrom\s*)?["'](\.[^"']+)["']/g
  for (const match of source.matchAll(pattern)) imports.push(match[1])
  return imports
}

const assetRoot = join(CLIENT_ROOT, '_astro')
const files = await guardedFiles(assetRoot)
const jsFiles = files.filter((path) => path.endsWith('.js'))
const cssFiles = files.filter((path) => path.endsWith('.css'))
const sources = new Map()
for (const path of jsFiles) sources.set(path, await regularFile(path))

const bootstrapEntries = [...sources].filter(([, source]) =>
  BOOTSTRAP_MARKERS.every((marker) => source.includes(marker))
)
if (bootstrapEntries.length !== 1) throw new Error('overlay_bootstrap_chunk_count_invalid')
const [bootstrapPath, bootstrapSource] = bootstrapEntries[0]
if (OVERLAY_MARKERS.some((marker) => bootstrapSource.includes(marker))) {
  throw new Error('overlay_bootstrap_contains_editor')
}

const dynamicPaths = [...bootstrapSource.matchAll(/import\([`'"](\.\/overlay\.[^`'"]+\.js)[`'"]\)/g)]
  .map((match) => resolve(dirname(bootstrapPath), match[1]))
if (dynamicPaths.length !== 2) throw new Error('overlay_dynamic_import_count_invalid')
const overlayEntries = dynamicPaths
  .map((path) => [path, sources.get(path)])
  .filter((entry) =>
    typeof entry[1] === 'string'
    && OVERLAY_MARKERS.every((marker) => entry[1].includes(marker))
  )
if (overlayEntries.length !== 1) throw new Error('overlay_lazy_chunk_invalid')
const [overlayPath] = overlayEntries[0]
const styleUrlChunks = dynamicPaths.filter((path) => {
  const source = sources.get(path)
  return typeof source === 'string' && /overlay\.[A-Za-z0-9_-]+\.css/.test(source)
})
if (styleUrlChunks.length !== 1) throw new Error('overlay_stylesheet_url_chunk_invalid')

const reachable = new Set([bootstrapPath])
const pending = [bootstrapPath]
while (pending.length > 0) {
  const current = pending.pop()
  if (!current) continue
  const source = sources.get(current)
  if (!source) throw new Error(`overlay_static_chunk_missing:${current}`)
  for (const specifier of staticImports(source)) {
    const target = resolve(dirname(current), specifier)
    if (target === overlayPath) throw new Error('overlay_static_import_detected')
    if (!reachable.has(target)) {
      reachable.add(target)
      pending.push(target)
    }
  }
}
for (const path of reachable) {
  const source = sources.get(path) ?? ''
  if (OVERLAY_MARKERS.some((marker) => source.includes(marker))) {
    throw new Error(`overlay_editor_static_reachability:${path}`)
  }
}

let stylesheetFound = false
for (const path of cssFiles) {
  const source = await regularFile(path)
  if (source.includes('.movp-overlay__control')) stylesheetFound = true
}
if (!stylesheetFound) throw new Error('overlay_stylesheet_missing')

console.log('overlay-bundle: ok')
