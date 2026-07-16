export function readTextBounded(path: string, maxBytes?: number): string
export function readJsonBounded(path: string, maxBytes?: number): unknown
export function assertSafeDirectory(path: string): void
export function walkRegularFiles(dir: string): string[]
export function writeTextAtomic(path: string, text: string, mode?: number): void
export function writeJsonAtomic(path: string, value: unknown): void
