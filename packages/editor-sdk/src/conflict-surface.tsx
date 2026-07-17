export function ConflictSurface({
  onRefresh,
  onLoadLatest,
}: {
  onRefresh(): void
  onLoadLatest?(): void
}) {
  return (
    <div role="alert">
      <p>
        This field changed since you opened it. Refresh revision, then Save to keep your version (other
        fields keep their latest). Or load the latest version to discard your changes.
      </p>
      <button type="button" aria-label="Refresh revision" onClick={onRefresh}>
        Refresh revision
      </button>
      {onLoadLatest && (
        <button
          type="button"
          aria-label="Load latest field and discard my changes"
          onClick={onLoadLatest}
        >
          Load latest field
        </button>
      )}
    </div>
  )
}
