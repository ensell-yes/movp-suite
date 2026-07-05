import { defineEvent } from './define.ts'
import type { EventDef } from './types.ts'

const objectPayload = { type: 'object' }

function event(key: string, domain: EventDef['domain'], label: string, description?: string): EventDef {
  return defineEvent({ key, domain, label, description, payloadSchema: objectPayload, version: 1 })
}

export const events = [
  event('note.created', 'lifecycle', 'Note created'),

  event('comment.added', 'collaboration', 'Comment added'),
  event('comment.replied', 'collaboration', 'Comment replied'),
  event('user.mentioned', 'collaboration', 'User mentioned'),
  event('item.liked', 'collaboration', 'Item liked'),
  event('item.disliked', 'collaboration', 'Item disliked'),
  event('item.saved', 'collaboration', 'Item saved'),
  event('item.shared', 'collaboration', 'Item shared'),

  event('task.created', 'task', 'Task created'),
  event('task.assigned', 'task', 'Task assigned'),
  event('task.observer_added', 'task', 'Task observer added'),
  event('task.status_changed', 'task', 'Task status changed'),
  event('task.completed', 'task', 'Task completed'),
  event('task.reopened', 'task', 'Task reopened'),
  event('task.dependency_blocked', 'task', 'Task dependency blocked'),
  event('task.due_soon', 'task', 'Task due soon'),

  event('content.created', 'cms', 'Content created'),
  event('content.revision_created', 'cms', 'Content revision created'),
  event('content.submitted_for_approval', 'cms', 'Content submitted for approval'),
  event('content.approved', 'cms', 'Content approved'),
  event('content.rejected', 'cms', 'Content rejected'),
  event('content.published', 'cms', 'Content published'),
  // CMS executed code emits content.unpublished through content_publish_event, even though
  // scheduled unpublish internally transitions the item to archived.
  event('content.unpublished', 'cms', 'Content unpublished'),
  event('content.scheduled', 'cms', 'Content scheduled'),

  event('campaign.created', 'campaign', 'Campaign created'),
  event('campaign.started', 'campaign', 'Campaign started'),
  event('campaign.ended', 'campaign', 'Campaign ended'),
  event('deliverable.created', 'campaign', 'Deliverable created'),
  event('deliverable.assigned', 'campaign', 'Deliverable assigned'),
  event('deliverable.completed', 'campaign', 'Deliverable completed'),
  event('deliverable.due_soon', 'campaign', 'Deliverable due soon'),

  // Segmentation and Campaigns are merged before app-06; these keys are authoritative
  // from the executed app-03/app-04 migrations, not roadmap prose.
  event('segment.membership_changed', 'segmentation', 'Segment membership changed'),
  event('segment.recomputed', 'segmentation', 'Segment recomputed'),
] as const satisfies EventDef[]
