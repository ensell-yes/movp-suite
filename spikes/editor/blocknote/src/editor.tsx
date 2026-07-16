import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { useEffect } from 'react'
import { Toolbar } from './toolbar.tsx'
import { registerMount } from './mount.ts'

export function Editor() {
  const editor = useCreateBlockNote()
  useEffect(() => registerMount(editor), [editor])
  const cmds = {
    bold: () => editor.toggleStyles({ bold: true }),
    h1: () => {
      const block = editor.getTextCursorPosition().block
      editor.updateBlock(block, { type: 'heading', props: { level: 1 } })
    },
    bullet: () => {
      const block = editor.getTextCursorPosition().block
      editor.updateBlock(block, { type: 'bulletListItem' })
    },
    undo: () => editor.undo(),
    redo: () => editor.redo(),
  }
  return <div><Toolbar cmds={cmds} /><BlockNoteView editor={editor} /></div>
}
