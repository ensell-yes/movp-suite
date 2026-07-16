export interface ToolbarCommands {
  bold(): void
  h1(): void
  bullet(): void
  undo(): void
  redo(): void
}

export function Toolbar({ commands }: { commands: ToolbarCommands }) {
  return (
    <div role="toolbar" aria-label="Formatting">
      <button type="button" aria-label="Bold" onClick={commands.bold}>B</button>
      <button type="button" aria-label="Heading 1" onClick={commands.h1}>H1</button>
      <button type="button" aria-label="Bullet list" onClick={commands.bullet}>List</button>
      <button type="button" aria-label="Undo" onClick={commands.undo}>Undo</button>
      <button type="button" aria-label="Redo" onClick={commands.redo}>Redo</button>
    </div>
  )
}
