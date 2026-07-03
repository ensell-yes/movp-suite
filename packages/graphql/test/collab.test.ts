import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => ({
  commentCreate: vi.fn(async (i: { entityType: string; entityId: string; body: string }) => ({
    id: 'c1',
    workspace_id: 'w',
    entity_type: i.entityType,
    entity_id: i.entityId,
    body: i.body,
    author_id: 'u',
    parent_id: null,
    created_at: 't',
    updated_at: 't',
  })),
  react: vi.fn(async () => undefined),
  unreact: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
  createShareLink: vi.fn(async () => ({ token: 'raw-token' })),
  inbox: vi.fn(async () => [
    { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: { body: 'hi' } },
  ]),
  resolveShareLink: vi.fn(async () => ({ entity_type: 'note', entity_id: 'n1', workspace_id: 'w' })),
}))

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    collab: {
      comment: { create: mocks.commentCreate, listByEntity: vi.fn() },
      react: mocks.react,
      unreact: mocks.unreact,
      save: mocks.save,
      unsave: vi.fn(),
      createShareLink: mocks.createShareLink,
      inbox: mocks.inbox,
    },
  }),
  resolveShareLink: mocks.resolveShareLink,
}))

const ctx = { db: {} as never, userId: 'u' }

describe('collab GraphQL surface', () => {
  it('addComment routes to collab.comment.create with mentions', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { addComment(entityType: "note", entityId: "n1", body: "hi", mentions: ["u2"]) { id entity_id } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.commentCreate).toHaveBeenCalledWith({
      entityType: 'note',
      entityId: 'n1',
      body: 'hi',
      parentId: undefined,
      mentions: ['u2'],
    })
    expect((res.data as { addComment: { id: string } }).addComment.id).toBe('c1')
  })

  it('toggleReaction on:true calls react; on:false calls unreact', async () => {
    mocks.react.mockClear()
    mocks.unreact.mockClear()
    await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { toggleReaction(entityType: "note", entityId: "n1", kind: "like", on: true) }',
      contextValue: ctx,
    })
    expect(mocks.react).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', kind: 'like' })
    await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { toggleReaction(entityType: "note", entityId: "n1", kind: "like", on: false) }',
      contextValue: ctx,
    })
    expect(mocks.unreact).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', kind: 'like' })
  })

  it('inbox returns items with a stringified payload', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { inbox(workspaceId: "w", tab: "mentions") { kind entity_id payload } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: 20 })
    const item = (res.data as { inbox: Array<{ kind: string; payload: string }> }).inbox[0]
    expect(item.kind).toBe('user.mentioned')
    expect(JSON.parse(item.payload).body).toBe('hi')
  })

  it('createShareLink returns the raw token; resolveShareLink returns the entity ref', async () => {
    const c = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { createShareLink(entityType: "note", entityId: "n1") { token } }',
      contextValue: ctx,
    })
    expect((c.data as { createShareLink: { token: string } }).createShareLink.token).toBe('raw-token')
    const r = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { resolveShareLink(token: "raw-token") { entity_id workspace_id } }',
      contextValue: ctx,
    })
    expect((r.data as { resolveShareLink: { entity_id: string } }).resolveShareLink.entity_id).toBe('n1')
    expect(mocks.resolveShareLink).toHaveBeenCalledWith({ db: ctx.db, userId: 'u' }, 'raw-token')
  })

  it('surfaces the custom collab ops but no generic CRUD for internal collab collections', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toMatch(/\baddComment\(/)
    expect(sdl).toMatch(/\binbox\(/)
    expect(sdl).toMatch(/\btoggleReaction\(/)
    expect(sdl).toMatch(/\bcreateShareLink\(/)
    expect(sdl).not.toMatch(/\bcreateComment\(/)
    expect(sdl).not.toMatch(/\bcreateReaction\(/)
    expect(sdl).not.toMatch(/\bcreateMention\(/)
    expect(sdl).not.toMatch(/type Reaction\b/)
    expect(sdl).not.toMatch(/type Mention\b/)
    expect(sdl).not.toMatch(/\breactions\(/)
    expect(sdl).toContain('createNote(')
  })
})
