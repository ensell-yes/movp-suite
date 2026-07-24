import { describe, expect, it } from 'vitest'
import * as delivery from '../src/index.ts'

describe('@movp/delivery public surface', () => {
  it('exports only the renderer runtime contract', () => {
    expect(Object.keys(delivery).sort()).toEqual([
      'DELIVERY_MARK_TYPES',
      'DELIVERY_MAX_DEPTH',
      'DELIVERY_MAX_NODES',
      'DELIVERY_MAX_TEXT_BYTES',
      'DELIVERY_NODE_TYPES',
      'DeliveryRenderError',
      'renderDocToHtml',
    ])
  })
})
