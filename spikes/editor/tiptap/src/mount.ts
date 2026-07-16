import { tipTapAdapter, type TipTapDoc } from './adapter.ts'

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

interface TipTapEditorLike {
  commands: { setContent(content: TipTapDoc): boolean }
  getJSON(): TipTapDoc
  setEditable(value: boolean): void
}

export function registerMount(editor: TipTapEditorLike): void {
  window.__spike = {
    load(body) {
      editor.commands.setContent(tipTapAdapter.decode(body))
    },
    serialize() {
      return tipTapAdapter.encode(editor.getJSON())
    },
    setReadonly(value) {
      editor.setEditable(!value)
    },
  }
}
