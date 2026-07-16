#!/usr/bin/env node
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateRuntime(node, browserChannel, browserVersion) {
  if (!/^22\.\d+\.\d+$/.test(node)) throw new Error('runtime-preflight:E_NODE_MAJOR')
  if (browserChannel !== 'chrome') throw new Error('runtime-preflight:E_BROWSER_CHANNEL')
  if (typeof browserVersion !== 'string' || browserVersion.length === 0 || browserVersion.length > 128 ||
      !/^[\x20-\x7e]+$/.test(browserVersion)) throw new Error('runtime-preflight:E_BROWSER_VERSION')
  return { node, browserChannel, browserVersion }
}

async function measureRuntime(packageDir) {
  if (!/^22\.\d+\.\d+$/.test(process.versions.node)) throw new Error('runtime-preflight:E_NODE_MAJOR')
  let chromium
  try {
    const require = createRequire(resolve(packageDir, 'package.json'))
    ;({ chromium } = require('@playwright/test'))
  } catch {
    throw new Error('runtime-preflight:E_PLAYWRIGHT')
  }
  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    return validateRuntime(process.versions.node, 'chrome', browser.version())
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('runtime-preflight:')) throw error
    throw new Error('runtime-preflight:E_BROWSER_LAUNCH')
  } finally {
    if (browser) await browser.close()
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const packageDir = process.argv[2]
  if (!packageDir) {
    console.error('runtime-preflight:E_USAGE')
    process.exit(2)
  }
  try {
    const runtime = await measureRuntime(packageDir)
    console.log(JSON.stringify(runtime))
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith('runtime-preflight:')
      ? error.message
      : 'runtime-preflight:E_UNKNOWN')
    process.exit(1)
  }
}
