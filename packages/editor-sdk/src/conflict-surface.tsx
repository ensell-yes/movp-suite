export function ConflictSurface({ onRefresh }: { onRefresh(): void }) {
  return (
    <div role="alert">
      <p>This content changed since you started editing. Refresh to load the latest version before saving again.</p>
      <button type="button" aria-label="Refresh and reload latest content" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  )
}
