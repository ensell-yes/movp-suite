#!/usr/bin/env node
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readTextBounded } from './lib/safe-io.mjs'

const DEFAULT_PIN_PATH = fileURLToPath(new URL('../.node-version', import.meta.url))

export function readNodePin(path = DEFAULT_PIN_PATH) {
  const pin = readTextBounded(path, 64).trim()
  if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('runtime-preflight:E_PIN_SHAPE')
  return pin
}

function assertPinnedNode(pin, node) {
  if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('runtime-preflight:E_PIN_SHAPE')
  if (node !== pin) throw new Error('runtime-preflight:E_NODE_MISMATCH')
}

export function validateRuntime(pin, node, browserChannel, browserVersion) {
  assertPinnedNode(pin, node)
  if (browserChannel !== 'chrome') throw new Error('runtime-preflight:E_BROWSER_CHANNEL')
  if (typeof browserVersion !== 'string' || browserVersion.length === 0 || browserVersion.length > 128 ||
      !/^[\x20-\x7e]+$/.test(browserVersion)) throw new Error('runtime-preflight:E_BROWSER_VERSION')
  return { node, browserChannel, browserVersion }
}

async function measureRuntime(packageDir, pin) {
  assertPinnedNode(pin, process.versions.node)
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
    return validateRuntime(pin, process.versions.node, 'chrome', browser.version())
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('runtime-preflight:')) throw error
    throw new Error('runtime-preflight:E_BROWSER_LAUNCH')
  } finally {
    if (browser) await browser.close()
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const args = process.argv.slice(2)
  const checkNodeOnly = args.includes('--check-node-only')
  const pinAt = args.indexOf('--pin')
  const pinPath = pinAt >= 0 ? args[pinAt + 1] : DEFAULT_PIN_PATH
  const packageDir = args.find((arg, index) => !arg.startsWith('--') && !(pinAt >= 0 && index === pinAt + 1))
  if (!pinPath || (!checkNodeOnly && !packageDir)) {
    console.error('runtime-preflight:E_USAGE')
    process.exit(2)
  }
  try {
    const pin = readNodePin(pinPath)
    assertPinnedNode(pin, process.versions.node)
    if (checkNodeOnly) console.log('runtime-preflight:node-ok')
    else console.log(JSON.stringify(await measureRuntime(packageDir, pin)))
  } catch (error) {
    console.error(error instanceof Error &&
      (error.message.startsWith('runtime-preflight:') || error.message.startsWith('safe-io:'))
      ? error.message
      : 'runtime-preflight:E_UNKNOWN')
    process.exit(1)
  }
}
