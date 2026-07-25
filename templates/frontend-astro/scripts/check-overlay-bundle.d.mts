export const MAX_STATIC_REACHABLE_BYTES: number

export function assertStaticOverlayBoundary(input: Readonly<{
  bootstrapPath: string
  overlayPath: string
  sources: ReadonlyMap<string, string>
  maxBytes?: number
}>): void

export function checkOverlayBundle(clientRoot?: string): Promise<void>
