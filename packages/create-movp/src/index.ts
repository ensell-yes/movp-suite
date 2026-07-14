// The pack-staging scripts (Task 6, and 06e's CI matrix + gallery validator) import `copyTreeGuarded`,
// `copyFileGuarded` and `readFileGuarded` from the BUILT dist — this is the public seam, so all three
// MUST be re-exported here (INTERFACES F1 + round-6 F2).
export {
  copyFileGuarded,
  copyTemplate,
  copyTreeGuarded,
  readFileGuarded,
  resolveTargetDir,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TOKEN_PATTERN,
  type CopyOptions,
} from './copier.ts'
