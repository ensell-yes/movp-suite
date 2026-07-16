import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { registerMount } from './mount.ts'
import { Toolbar } from './toolbar.tsx'

export function Editor() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: { type: 'doc', content: [] },
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Rich text editor',
        'aria-multiline': 'true',
      },
    },
  })
  useEffect(() => {
    if (editor) registerMount(editor)
  }, [editor])
  if (!editor) return null
  const cmds = {
    bold: () => editor.chain().focus().toggleBold().run(),
    h1: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    bullet: () => editor.chain().focus().toggleBulletList().run(),
    undo: () => editor.chain().focus().undo().run(),
    redo: () => editor.chain().focus().redo().run(),
  }
  return <div><Toolbar cmds={cmds} /><EditorContent editor={editor} /></div>
}
