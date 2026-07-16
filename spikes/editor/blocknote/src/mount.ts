import { blockNoteAdapter, type BlockNoteDoc } from './adapter.ts'

export interface SpikeMount {
  load(body: string): void
  serialize(): string
  setReadonly(value: boolean): void
}

declare global {
  interface Window {
    __spike?: SpikeMount
  }
}

interface BlockNoteEditorLike {
  replaceBlocks(target: BlockNoteDoc, blocks: BlockNoteDoc): void
  document: BlockNoteDoc
  isEditable: boolean
}

export function registerMount(editor: BlockNoteEditorLike): void {
  window.__spike = {
    load(body) {
      const blocks = blockNoteAdapter.decode(body)
      if (blocks.length) editor.replaceBlocks(editor.document, blocks)
    },
    serialize() {
      return blockNoteAdapter.encode(editor.document)
    },
    setReadonly(value) {
      editor.isEditable = !value
    },
  }
}
