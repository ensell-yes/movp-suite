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
