interface Cmds {
  bold(): void
  h1(): void
  bullet(): void
  undo(): void
  redo(): void
}

export function Toolbar({ cmds }: { cmds: Cmds }) {
  return (
    <div role="toolbar" aria-label="Formatting">
      <button type="button" aria-label="Bold" onClick={cmds.bold}>B</button>
      <button type="button" aria-label="Heading 1" onClick={cmds.h1}>H1</button>
      <button type="button" aria-label="Bullet list" onClick={cmds.bullet}>List</button>
      <button type="button" aria-label="Undo" onClick={cmds.undo}>Undo</button>
      <button type="button" aria-label="Redo" onClick={cmds.redo}>Redo</button>
    </div>
  )
}
