export type WorkspaceMemberRow = {
  workspace_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  created_at: string
}

export type AdminInvite = {
  inviteId: string
  token: string
}

export type IngestKeyRow = {
  id: string
  label: string | null
  active: boolean
  created_at: string
}

export type IngestKeySecret = {
  keyId: string
  rawKey: string
}

export type DeadJobRow = {
  id: string
  kind: string
  attempts: number
  last_error_code: string | null
  updated_at: string
  payload_keys: string[]
}

export type CollectionFieldMeta = {
  name: string
  type: string
  label: string
  required: boolean
}

export type CollectionMeta = {
  name: string
  label: string
  labelPlural: string
  fields: CollectionFieldMeta[]
}

export type WorkspaceSettings = {
  workspace_id: string
  name: string | null
  member_count: number
}

export const WORKSPACE_MEMBERS_QUERY = /* GraphQL */ `
  query WorkspaceMembers($workspaceId: ID!) {
    workspaceMembers(workspaceId: $workspaceId) { workspace_id user_id role created_at }
  }
`

export const INVITE_MEMBER_MUTATION = /* GraphQL */ `
  mutation InviteMember($workspaceId: ID!, $email: String!, $role: String!) {
    inviteMember(workspaceId: $workspaceId, email: $email, role: $role) { inviteId token }
  }
`

export const SET_MEMBER_ROLE_MUTATION = /* GraphQL */ `
  mutation SetMemberRole($workspaceId: ID!, $userId: ID!, $role: String!) {
    setMemberRole(workspaceId: $workspaceId, userId: $userId, role: $role) { workspace_id user_id role created_at }
  }
`

export const REMOVE_MEMBER_MUTATION = /* GraphQL */ `
  mutation RemoveMember($workspaceId: ID!, $userId: ID!) {
    removeMember(workspaceId: $workspaceId, userId: $userId)
  }
`

export const ACCEPT_INVITE_MUTATION = /* GraphQL */ `
  mutation AcceptInvite($token: String!) {
    acceptInvite(token: $token) { workspace_id user_id role created_at }
  }
`

export const INGEST_KEYS_QUERY = /* GraphQL */ `
  query IngestKeys($workspaceId: ID!) {
    ingestKeys(workspaceId: $workspaceId) { id label active created_at }
  }
`

export const CREATE_INGEST_KEY_MUTATION = /* GraphQL */ `
  mutation CreateIngestKey($workspaceId: ID!, $label: String!) {
    createIngestKey(workspaceId: $workspaceId, label: $label) { keyId rawKey }
  }
`

export const ROTATE_INGEST_KEY_MUTATION = /* GraphQL */ `
  mutation RotateIngestKey($workspaceId: ID!, $keyId: ID!) {
    rotateIngestKey(workspaceId: $workspaceId, keyId: $keyId) { keyId rawKey }
  }
`

export const REVOKE_INGEST_KEY_MUTATION = /* GraphQL */ `
  mutation RevokeIngestKey($workspaceId: ID!, $keyId: ID!) {
    revokeIngestKey(workspaceId: $workspaceId, keyId: $keyId)
  }
`

export const ADMIN_JOBS_QUERY = /* GraphQL */ `
  query AdminJobs($workspaceId: ID!, $first: Int!) {
    jobCounts(workspaceId: $workspaceId)
    deadJobs(workspaceId: $workspaceId, first: $first) {
      id kind attempts last_error_code updated_at payload_keys
    }
  }
`

export const REPLAY_DEAD_JOBS_MUTATION = /* GraphQL */ `
  mutation ReplayDeadJobs($workspaceId: ID!, $kind: String) {
    replayDeadJobs(workspaceId: $workspaceId, kind: $kind) { replayed }
  }
`

export const COLLECTIONS_META_QUERY = /* GraphQL */ `
  query CollectionsMeta {
    collectionsMeta { name label labelPlural fields { name type label required } }
  }
`

export const WORKSPACE_SETTINGS_QUERY = /* GraphQL */ `
  query WorkspaceSettings($workspaceId: ID!) {
    workspaceSettings(workspaceId: $workspaceId) { workspace_id name member_count }
  }
`
