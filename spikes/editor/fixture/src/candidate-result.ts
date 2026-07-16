export interface LicenseEntry {
  name: string
  versions: string[]
  license: string
}

export type NoticeEvidence =
  | { package: string; status: 'file'; path: string; sha256: string }
  | { package: string; status: 'declared_only'; declaredLicense: string }

export interface RuntimeEvidence {
  node: string
  browserChannel: 'chrome'
  browserVersion: string
}

export interface CandidateResult {
  schemaVersion: 1
  candidate: 'blocknote' | 'tiptap'
  resolvedVersions: Record<string, string>
  idempotent: boolean
  exactEdit: boolean
  lifecycleOrder: boolean
  publishedRead: boolean
  staleSabotage: boolean
  boundary: boolean
  a11y: boolean
  license: 'pass' | 'fail'
  prodHasCopyleft: boolean
  prodLicenses: LicenseEntry[]
  fullLicenses: LicenseEntry[]
  noticeEvidence: NoticeEvidence[]
  runtime: RuntimeEvidence
  blockIdPreserved: boolean
  bundle: { jsRaw: number; jsGzip: number; cssRaw: number; cssGzip: number }
  toolbarLoc?: number
}
