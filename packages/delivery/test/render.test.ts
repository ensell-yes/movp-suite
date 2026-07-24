import { describe, expect, it } from 'vitest'
import {
  DELIVERY_MARK_TYPES,
  DELIVERY_MAX_DEPTH,
  DELIVERY_MAX_NODES,
  DELIVERY_MAX_TEXT_BYTES,
  DELIVERY_NODE_TYPES,
  DeliveryRenderError,
  renderDocToHtml,
} from '../src/index.ts'
import type { RenderOptions } from '../src/index.ts'

function expectRenderCode(input: unknown, code: string, options?: RenderOptions): void {
  try {
    renderDocToHtml(input, options)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DeliveryRenderError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected renderer error ${code}`)
}

function paragraph(text: string): unknown {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  }
}

function nestedBlockquote(depth: number): unknown {
  let node: unknown = { type: 'horizontalRule' }
  for (let index = 0; index < depth - 2; index += 1) {
    node = { type: 'blockquote', content: [node] }
  }
  return { type: 'doc', content: [node] }
}

describe('renderDocToHtml', () => {
  it('pins the exact StarterKit node and mark allowlists', () => {
    expect(DELIVERY_NODE_TYPES).toEqual([
      'doc',
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'blockquote',
      'codeBlock',
      'hardBreak',
      'horizontalRule',
      'text',
    ])
    expect(DELIVERY_MARK_TYPES).toEqual(['bold', 'italic', 'strike', 'code'])
    expect(DELIVERY_NODE_TYPES).not.toContain('link')
    expect(DELIVERY_MARK_TYPES).not.toContain('link')
  })

  it('renders the allowed block, inline, mark, and list shapes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            {
              type: 'text',
              text: 'Heading',
              marks: [{ type: 'bold' }, { type: 'italic' }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before' },
            { type: 'hardBreak' },
            { type: 'text', text: 'after', marks: [{ type: 'strike' }] },
          ],
        },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph('bullet')] }],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [paragraph('ordered')] }],
        },
        {
          type: 'blockquote',
          content: [paragraph('quoted')],
        },
        { type: 'horizontalRule' },
      ],
    }

    expect(renderDocToHtml(doc)).toBe(
      '<h2><strong><em>Heading</em></strong></h2>'
      + '<p>before<br><s>after</s></p>'
      + '<ul><li><p>bullet</p></li></ul>'
      + '<ol start="3"><li><p>ordered</p></li></ol>'
      + '<blockquote><p>quoted</p></blockquote>'
      + '<hr>',
    )
  })

  it('escapes script, image-handler, quote, and ampersand payloads as inert text', () => {
    const payload = '<script>alert("x")</script><img src=x onerror="boom"> & \'quoted\''
    expect(renderDocToHtml({
      type: 'doc',
      content: [paragraph(payload)],
    })).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
      + '&lt;img src=x onerror=&quot;boom&quot;&gt; &amp; &#39;quoted&#39;</p>',
    )
  })

  it('escapes codeBlock text and accepts StarterKit language without emitting it', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: '<img onerror="x">&' }],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    }
    const html = renderDocToHtml(doc)
    expect(html).toBe(
      '<pre><code>&lt;img onerror=&quot;x&quot;&gt;&amp;</code></pre>'
      + '<pre><code>const x = 1</code></pre>',
    )
    expect(html).not.toContain('typescript')
    expect(html).not.toContain('class=')
  })

  it('rejects link, href, unknown nodes, marks, attributes, and fields', () => {
    expectRenderCode(
      { type: 'doc', content: [{ type: 'link', content: [] }] },
      'delivery_render_unknown_node',
    )
    expectRenderCode(
      {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'x' } }] }],
        }],
      },
      'delivery_render_unknown_mark',
    )
    expectRenderCode(
      { type: 'doc', content: [{ type: 'paragraph', attrs: { class: 'x' } }] },
      'delivery_render_unknown_attribute',
    )
    expectRenderCode(
      {
        type: 'doc',
        content: [{
          type: 'codeBlock',
          attrs: { language: 'js" onmouseover="x' },
          content: [],
        }],
      },
      'delivery_render_unknown_attribute',
    )
    expectRenderCode(
      { type: 'doc', content: [{ type: 'paragraph', content: [], html: '<b>x</b>' }] },
      'delivery_render_invalid_document',
    )
  })

  it('rejects invalid nesting instead of silently dropping nodes', () => {
    expectRenderCode(paragraph('missing doc root'), 'delivery_render_invalid_nesting')
    expectRenderCode(
      { type: 'doc', content: [{ type: 'text', text: 'not a block' }] },
      'delivery_render_invalid_nesting',
    )
    expectRenderCode(
      { type: 'doc', content: [{ type: 'bulletList', content: [paragraph('not an item')] }] },
      'delivery_render_invalid_nesting',
    )
    expectRenderCode(
      {
        type: 'doc',
        content: [{
          type: 'listItem',
          content: [{ type: 'heading', attrs: { level: 2 }, content: [] }],
        }],
      },
      'delivery_render_invalid_nesting',
    )
    expectRenderCode(
      {
        type: 'doc',
        content: [{
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: 'x', marks: [{ type: 'code' }] }],
        }],
      },
      'delivery_render_invalid_nesting',
    )
  })

  it('pins exact heading, list, and language attribute validation', () => {
    expectRenderCode(
      { type: 'doc', content: [{ type: 'heading', attrs: { level: 7 }, content: [] }] },
      'delivery_render_unknown_attribute',
    )
    expectRenderCode(
      { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 0 }, content: [] }] },
      'delivery_render_unknown_attribute',
    )
    expectRenderCode(
      {
        type: 'doc',
        content: [{ type: 'codeBlock', attrs: { language: 'x'.repeat(33) }, content: [] }],
      },
      'delivery_render_unknown_attribute',
    )
  })

  it('enforces depth, node-count, and UTF-8 text bounds at their edges', () => {
    expect(DELIVERY_MAX_DEPTH).toBe(64)
    expect(DELIVERY_MAX_NODES).toBe(20_000)
    expect(DELIVERY_MAX_TEXT_BYTES).toBe(1024 * 1024)

    expect(() => renderDocToHtml(nestedBlockquote(64))).not.toThrow()
    expectRenderCode(nestedBlockquote(65), 'delivery_render_depth_exceeded')

    const passingNodes = Array.from(
      { length: DELIVERY_MAX_NODES - 1 },
      () => ({ type: 'horizontalRule' }),
    )
    expect(() => renderDocToHtml({ type: 'doc', content: passingNodes })).not.toThrow()
    expectRenderCode(
      { type: 'doc', content: [...passingNodes, { type: 'horizontalRule' }] },
      'delivery_render_node_limit_exceeded',
    )

    expect(() => renderDocToHtml({
      type: 'doc',
      content: [paragraph('a'.repeat(DELIVERY_MAX_TEXT_BYTES))],
    })).not.toThrow()
    expectRenderCode(
      {
        type: 'doc',
        content: [paragraph(`${'a'.repeat(DELIVERY_MAX_TEXT_BYTES)}é`)],
      },
      'delivery_render_text_limit_exceeded',
    )
  })

  it('emits binding attributes only for strict public locator shapes', () => {
    const doc = { type: 'doc', content: [paragraph('bound')] }
    expect(renderDocToHtml(doc, {
      bind: {
        itemId: 'd7100000-0000-0000-0000-000000000001',
        fieldKey: 'body_copy',
      },
    })).toBe(
      '<div data-movp-item="d7100000-0000-0000-0000-000000000001" '
      + 'data-movp-field="body_copy"><p>bound</p></div>',
    )
    expectRenderCode(doc, 'delivery_render_binding_invalid', {
      bind: {
        itemId: 'not-a-uuid',
        fieldKey: 'body',
      },
    })
    expectRenderCode(doc, 'delivery_render_binding_invalid', {
      bind: {
        itemId: 'd7100000-0000-0000-0000-000000000001',
        fieldKey: 'body" onmouseover="x',
      },
    })
  })

  it('does not mutate the input document', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'stable',
          marks: [{ type: 'italic' }, { type: 'bold' }],
        }],
      }],
    }
    const before = JSON.stringify(doc)
    renderDocToHtml(doc)
    expect(JSON.stringify(doc)).toBe(before)
  })
})
