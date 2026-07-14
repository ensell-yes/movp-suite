import { randomBytes } from 'node:crypto'

const SAFE_FILE_MODE = 0o600

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: unknown }).code === 'ENOENT'
}

export interface AtomicWriteOptions {
  onRefuse?: (reason: string) => never
}

export async function atomicWriteFile(
  path: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const fs = await import('node:fs/promises')
  const refuse = opts.onRefuse ?? ((reason: string): never => {
    throw new Error(`safe_write_refused: ${reason}`)
  })
  const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tempPath, contents, { flag: 'wx', mode: SAFE_FILE_MODE })

  try {
    let info: Awaited<ReturnType<typeof fs.lstat>> | undefined
    try {
      info = await fs.lstat(path)
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
    }
    if (info?.isSymbolicLink()) refuse(`${path}: refusing to overwrite a symlink`)
    if (info && !info.isFile()) refuse(`${path}: not a regular file`)
    await fs.rename(tempPath, path)
  } catch (error: unknown) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export async function atomicCreateFile(
  path: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const fs = await import('node:fs/promises')
  const refuse = opts.onRefuse ?? ((reason: string): never => {
    throw new Error(`safe_write_refused: ${reason}`)
  })
  const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tempPath, contents, { flag: 'wx', mode: SAFE_FILE_MODE })

  try {
    await fs.link(tempPath, path).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        refuse(`${path}: refusing to replace an existing path`)
      }
      throw error
    })
    await fs.unlink(tempPath)
  } catch (error: unknown) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw error
  }
}
