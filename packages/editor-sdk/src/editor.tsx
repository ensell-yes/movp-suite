import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useRef, useState } from 'react'
import { tipTapAdapter } from './adapter.ts'
import { classifySaveOutcome, type SaveHandler, type SaveResult } from './save.ts'
import { ConflictSurface } from './conflict-surface.tsx'
import { Toolbar, type ToolbarActiveState, type ToolbarCommands } from './toolbar.tsx'

export type EditorStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'

export interface MovpEditorProps {
  /** stored richtext string for the field this editor occupies */
  initialBody: string
  /** host-provided save; the host calls content.update server-side and returns a SaveResult */
  onSave: SaveHandler
  /** successful revision feedback; retain this as the next content.update expectedRevisionId */
  onSaved?(revisionId: string): void
  /** host-provided reload of the latest content (wired to the conflict Refresh control) */
  onRefresh(): void
  readOnly?: boolean
}

export function MovpEditor({ initialBody, onSave, onSaved, onRefresh, readOnly = false }: MovpEditorProps) {
  const [status, setStatus] = useState<EditorStatus>('idle')
  const savingRef = useRef(false)
  const editor = useEditor({
    extensions: [StarterKit],
    editable: !readOnly,
    immediatelyRender: false, // TipTap 2.27.2 warns on SSR unless false (useEditor.ts:110)
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Rich text editor', 'aria-multiline': 'true' },
    },
  })

  // The host refreshes and supplies a new body; TipTap does not react to content prop changes.
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(tipTapAdapter.decode(initialBody))
    setStatus('idle')
  }, [editor, initialBody])

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  const save = useCallback(async () => {
    if (!editor || savingRef.current) return
    savingRef.current = true
    setStatus('saving')
    let result: SaveResult
    try {
      result = await onSave(tipTapAdapter.encode(editor.getJSON()))
    } catch (err) {
      result = classifySaveOutcome(err)
    }
    savingRef.current = false
    setStatus(result.status)
    // onSaved is host-owned advisory revision feedback. Isolate it: a throwing host callback must
    // neither repaint a committed save as an error (hence: after setStatus) nor dangle an unhandled
    // rejection. The host owns error handling inside its own callback.
    if (result.status === 'saved') {
      try {
        onSaved?.(result.revisionId)
      } catch {
        /* host callback fault — contained by design */
      }
    }
  }, [editor, onSave, onSaved])

  if (!editor) return null

  const commands: ToolbarCommands = {
    bold: () => editor.chain().focus().toggleBold().run(),
    h1: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    bullet: () => editor.chain().focus().toggleBulletList().run(),
    undo: () => editor.chain().focus().undo().run(),
    redo: () => editor.chain().focus().redo().run(),
  }
  const active: ToolbarActiveState = {
    bold: editor.isActive('bold'),
    h1: editor.isActive('heading', { level: 1 }),
    bullet: editor.isActive('bulletList'),
  }

  return (
    <div>
      {!readOnly && <Toolbar commands={commands} active={active} />}
      {status === 'conflict' && <ConflictSurface onRefresh={onRefresh} />}
      {status === 'error' && <div role="alert">Save failed. Please try again.</div>}
      <EditorContent editor={editor} />
      {!readOnly && (
        <button type="button" aria-label="Save content" disabled={status === 'saving'} onClick={() => void save()}>
          Save
        </button>
      )}
      {status === 'saved' && <span role="status">Saved</span>}
    </div>
  )
}
