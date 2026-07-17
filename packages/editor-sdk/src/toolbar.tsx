export interface ToolbarCommands {
  bold(): void
  h1(): void
  bullet(): void
  undo(): void
  redo(): void
}

export interface ToolbarActiveState {
  bold: boolean
  h1: boolean
  bullet: boolean
}

export function Toolbar({ commands, active }: { commands: ToolbarCommands; active: ToolbarActiveState }) {
  return (
    <div role="toolbar" aria-label="Formatting">
      <button type="button" aria-label="Bold" aria-pressed={active.bold} onClick={commands.bold}>B</button>
      <button type="button" aria-label="Heading 1" aria-pressed={active.h1} onClick={commands.h1}>H1</button>
      <button type="button" aria-label="Bullet list" aria-pressed={active.bullet} onClick={commands.bullet}>List</button>
      <button type="button" aria-label="Undo" onClick={commands.undo}>Undo</button>
      <button type="button" aria-label="Redo" onClick={commands.redo}>Redo</button>
    </div>
  )
}
