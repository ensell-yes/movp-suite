export type PersonalAccessToken = {
  id: string
  name: string
  defaultWorkspaceId: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export type CreatedPat = { tokenId: string; token: string }

export const PERSONAL_ACCESS_TOKENS_QUERY = /* GraphQL */ `
  query PersonalAccessTokens {
    personalAccessTokens { id name defaultWorkspaceId createdAt lastUsedAt expiresAt revokedAt }
  }
`

export const CREATE_PAT_MUTATION = /* GraphQL */ `
  mutation CreatePersonalAccessToken($defaultWorkspaceId: ID!, $name: String!, $ttlDays: Int) {
    createPersonalAccessToken(defaultWorkspaceId: $defaultWorkspaceId, name: $name, ttlDays: $ttlDays) { tokenId token }
  }
`

export const REVOKE_PAT_MUTATION = /* GraphQL */ `
  mutation RevokePersonalAccessToken($tokenId: ID!) {
    revokePersonalAccessToken(tokenId: $tokenId)
  }
`
