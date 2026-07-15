#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { copyFileGuarded, copyTreeGuarded } from '../../packages/create-movp/dist/index.js'

const [repoRoot, stagingDir, ...templates] = process.argv.slice(2)
if (!repoRoot || !stagingDir || templates.length === 0) {
  console.error('usage: stage-create-movp.mjs <repoRoot> <stagingDir> <template>...')
  process.exit(2)
}

const pkgDir = join(repoRoot, 'packages', 'create-movp')
mkdirSync(stagingDir, { recursive: true })
copyFileGuarded(join(pkgDir, 'package.json'), join(stagingDir, 'package.json'))
copyTreeGuarded(join(pkgDir, 'dist'), join(stagingDir, 'dist'))

for (const template of templates) {
  if (!/^[a-z][a-z0-9-]*$/.test(template)) {
    console.error(`invalid template name: ${template}`)
    process.exit(2)
  }
  copyTreeGuarded(join(repoRoot, 'templates', template), join(stagingDir, 'templates', template))
}

console.log(`staged create-movp (${templates.join(', ')}) -> ${stagingDir}`)
