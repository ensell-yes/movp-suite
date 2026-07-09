import { graphql } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => {
  const workspace = { id: 'w-admin', name: 'Acme', created_at: '2026-07-08T00:00:00Z' }
  const owner = {
    workspace_id: 'w-admin',
    user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    role: 'owner',
    created_at: '2026-07-08T00:00:00Z',
  }
  return {
    createWorkspace: vi.fn(async () => workspace),
    inviteMember: vi.fn(async () => ({ inviteId: 'invite-1', token: 'invite-secret-token' })),
    acceptInvite: vi.fn(async () => owner),
    listMembers: vi.fn(async () => [owner]),
    setMemberRole: vi.fn(async () => ({ ...owner, user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'admin' })),
    removeMember: vi.fn(async () => undefined),
    listIngestKeys: vi.fn(async () => [{ id: 'key-1', label: 'ci', active: true, created_at: '2026-07-08T00:00:00Z' }]),
    createIngestKey: vi.fn(async () => ({ keyId: 'key-1', rawKey: 'a'.repeat(48) })),
    rotateIngestKey: vi.fn(async () => ({ keyId: 'key-1', rawKey: 'b'.repeat(48) })),
    revokeIngestKey: vi.fn(async () => undefined),
    jobCounts: vi.fn(async () => ({ dead: 1, failed: 2 })),
    deadJobs: vi.fn(async () => [{
      id: 'job-1',
      kind: 'webhook',
      attempts: 8,
      last_error_code: 'condition_invalid',
      updated_at: '2026-07-08T00:00:00Z',
      payload_keys: ['secret_url'],
    }]),
    replayDeadJobs: vi.fn(async () => 1),
    settings: vi.fn(async () => ({ workspace_id: 'w-admin', name: 'Acme', member_count: 2 })),
  }
})

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    admin: {
      createWorkspace: mocks.createWorkspace,
      inviteMember: mocks.inviteMember,
      acceptInvite: mocks.acceptInvite,
      listMembers: mocks.listMembers,
      setMemberRole: mocks.setMemberRole,
      removeMember: mocks.removeMember,
      listIngestKeys: mocks.listIngestKeys,
      createIngestKey: mocks.createIngestKey,
      rotateIngestKey: mocks.rotateIngestKey,
      revokeIngestKey: mocks.revokeIngestKey,
      jobCounts: mocks.jobCounts,
      deadJobs: mocks.deadJobs,
      replayDeadJobs: mocks.replayDeadJobs,
      settings: mocks.settings,
    },
  }),
}))

const ctx = { db: {} as never, userId: 'u' }
const run = (source: string) => graphql({ schema: buildSchema(movpSchema), source, contextValue: ctx })

describe('admin GraphQL surface', () => {
  it('routes workspace and member administration through the admin domain service', async () => {
    const created = await run('mutation { createWorkspace(name: "Acme") { id name } }')
    expect(created.errors).toBeUndefined()
    expect(mocks.createWorkspace).toHaveBeenCalledWith({ name: 'Acme' })
    expect((created.data as { createWorkspace: { name: string } }).createWorkspace.name).toBe('Acme')

    const members = await run('query { workspaceMembers(workspaceId: "w-admin") { user_id role } }')
    expect(members.errors).toBeUndefined()
    expect(mocks.listMembers).toHaveBeenCalledWith({ workspaceId: 'w-admin' })
    expect((members.data as { workspaceMembers: Array<{ role: string }> }).workspaceMembers[0].role).toBe('owner')

    const invite = await run('mutation { inviteMember(workspaceId: "w-admin", email: "new@example.test", role: "member") { inviteId token } }')
    expect(invite.errors).toBeUndefined()
    expect(mocks.inviteMember).toHaveBeenCalledWith({ workspaceId: 'w-admin', email: 'new@example.test', role: 'member' })
    expect((invite.data as { inviteMember: { token: string } }).inviteMember.token).toBe('invite-secret-token')

    const accepted = await run('mutation { acceptInvite(token: "invite-secret-token") { workspace_id user_id role } }')
    expect(accepted.errors).toBeUndefined()
    expect(mocks.acceptInvite).toHaveBeenCalledWith({ token: 'invite-secret-token' })

    await run('mutation { setMemberRole(workspaceId: "w-admin", userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role: "admin") { user_id role } }')
    expect(mocks.setMemberRole).toHaveBeenCalledWith({
      workspaceId: 'w-admin',
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      role: 'admin',
    })

    const removed = await run('mutation { removeMember(workspaceId: "w-admin", userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") }')
    expect(removed.errors).toBeUndefined()
    expect(mocks.removeMember).toHaveBeenCalledWith({
      workspaceId: 'w-admin',
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    expect((removed.data as { removeMember: boolean }).removeMember).toBe(true)
  })

  it('routes ingest key administration and exposes raw keys only on create/rotate', async () => {
    const keys = await run('query { ingestKeys(workspaceId: "w-admin") { id label active created_at } }')
    expect(keys.errors).toBeUndefined()
    expect(mocks.listIngestKeys).toHaveBeenCalledWith({ workspaceId: 'w-admin' })
    expect(JSON.stringify(keys.data)).not.toContain('rawKey')
    expect(JSON.stringify(keys.data)).not.toContain('key_hash')

    const created = await run('mutation { createIngestKey(workspaceId: "w-admin", label: "ci") { keyId rawKey } }')
    expect(created.errors).toBeUndefined()
    expect(mocks.createIngestKey).toHaveBeenCalledWith({ workspaceId: 'w-admin', label: 'ci' })
    expect((created.data as { createIngestKey: { rawKey: string } }).createIngestKey.rawKey).toHaveLength(48)

    const rotated = await run('mutation { rotateIngestKey(workspaceId: "w-admin", keyId: "key-1") { keyId rawKey } }')
    expect(rotated.errors).toBeUndefined()
    expect(mocks.rotateIngestKey).toHaveBeenCalledWith({ workspaceId: 'w-admin', keyId: 'key-1' })
    expect((rotated.data as { rotateIngestKey: { rawKey: string } }).rotateIngestKey.rawKey).toHaveLength(48)

    const revoked = await run('mutation { revokeIngestKey(workspaceId: "w-admin", keyId: "key-1") }')
    expect(revoked.errors).toBeUndefined()
    expect(mocks.revokeIngestKey).toHaveBeenCalledWith({ workspaceId: 'w-admin', keyId: 'key-1' })
    expect((revoked.data as { revokeIngestKey: boolean }).revokeIngestKey).toBe(true)
  })

  it('routes job operations and exposes dead-job payload keys only', async () => {
    const counts = await run('query { jobCounts(workspaceId: "w-admin") }')
    expect(counts.errors).toBeUndefined()
    expect(mocks.jobCounts).toHaveBeenCalledWith({ workspaceId: 'w-admin' })
    expect(JSON.parse((counts.data as { jobCounts: string }).jobCounts)).toEqual({ dead: 1, failed: 2 })

    const jobs = await run('query { deadJobs(workspaceId: "w-admin", first: 500) { id kind attempts last_error_code payload_keys } }')
    expect(jobs.errors).toBeUndefined()
    expect(mocks.deadJobs).toHaveBeenCalledWith({ workspaceId: 'w-admin', first: 100 })
    expect(JSON.stringify(jobs.data)).toContain('secret_url')
    expect(JSON.stringify(jobs.data)).not.toContain('evil.example')

    const replay = await run('mutation { replayDeadJobs(workspaceId: "w-admin", kind: "webhook") { replayed } }')
    expect(replay.errors).toBeUndefined()
    expect(mocks.replayDeadJobs).toHaveBeenCalledWith({ workspaceId: 'w-admin', kind: 'webhook' })
    expect((replay.data as { replayDeadJobs: { replayed: number } }).replayDeadJobs.replayed).toBe(1)
  })

  it('routes workspace settings through the admin domain service', async () => {
    const settings = await run('query { workspaceSettings(workspaceId: "w-admin") { workspace_id name member_count } }')
    expect(settings.errors).toBeUndefined()
    expect(mocks.settings).toHaveBeenCalledWith({ workspaceId: 'w-admin' })
    expect((settings.data as { workspaceSettings: { name: string; member_count: number } }).workspaceSettings).toMatchObject({
      name: 'Acme',
      member_count: 2,
    })
  })

  it('maps admin domain failures to typed GraphQL errors', async () => {
    mocks.inviteMember.mockRejectedValueOnce(new Error('domain.admin.inviteMember failed [42501]'))
    const denied = await run('mutation { inviteMember(workspaceId: "w-admin", email: "blocked@example.test", role: "member") { inviteId token } }')

    expect(denied.data).toEqual({ inviteMember: null })
    expect(denied.errors?.[0]?.message).toContain('[42501]')
    expect(denied.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', pgCode: '42501' })
  })
})
