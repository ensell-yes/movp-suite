import { describe, expect, it } from 'vitest'
import {
  MAX_STATIC_REACHABLE_BYTES,
  assertStaticOverlayBoundary,
} from '../scripts/check-overlay-bundle.mjs'

const bootstrapPath = '/dist/client/_astro/bootstrap.js'
const overlayPath = '/dist/client/_astro/overlay.lazy.js'

describe('overlay static bundle boundary', () => {
  it('rejects a statically reachable editor runtime even without overlay copy markers', () => {
    const editorPath = '/dist/client/_astro/editor.js'
    const sources = new Map([
      [bootstrapPath, 'import "./editor.js"; export const start = true'],
      [editorPath, 'globalThis.ProseMirror = class ProseMirror {}'],
      [overlayPath, 'export const lazy = true'],
    ])

    expect(() => assertStaticOverlayBoundary({
      bootstrapPath,
      overlayPath,
      sources,
    })).toThrow(/overlay_editor_runtime_static_reachability/)
  })

  it('rejects a statically reachable graph over the explicit byte budget', () => {
    const sharedPath = '/dist/client/_astro/shared.js'
    const sources = new Map([
      [bootstrapPath, 'import "./shared.js"; export const start = true'],
      [sharedPath, 'x'.repeat(MAX_STATIC_REACHABLE_BYTES)],
      [overlayPath, 'export const lazy = true'],
    ])

    expect(() => assertStaticOverlayBoundary({
      bootstrapPath,
      overlayPath,
      sources,
    })).toThrow(/overlay_static_bytes_exceeded/)
  })

  it('accepts a small bootstrap whose editor is reachable only by dynamic import', () => {
    const sources = new Map([
      [bootstrapPath, 'export const load = () => import("./overlay.lazy.js")'],
      [overlayPath, 'globalThis.ProseMirror = class ProseMirror {}'],
    ])

    expect(() => assertStaticOverlayBoundary({
      bootstrapPath,
      overlayPath,
      sources,
    })).not.toThrow()
  })
})
