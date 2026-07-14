/** The subtrees a `create-movp` pack/stage step reads. */
export declare const DEFAULT_ROOTS: string[]
/**
 * Deterministic, path-sorted content-hash manifest of `roots` under `root`.
 * Streams every file in bounded chunks; records symlinks WITHOUT following them; skips `node_modules`.
 */
export declare function snapshotTree(root: string, roots?: string[]): Promise<string>
