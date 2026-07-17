// @vitest-environment jsdom
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(cleanup)

function TiptapJsdomHarness() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    immediatelyRender: false,
  })
  return editor ? <EditorContent editor={editor} /> : null
}

describe('TipTap jsdom viability', () => {
  it('constructs and mounts an EditorView', async () => {
    render(<TiptapJsdomHarness />)
    await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull())
  })
})
