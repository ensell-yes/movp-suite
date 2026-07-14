import {
  defineSchema,
  schema as platformSchema,
  type CollectionDef,
  type EventDef,
  type MovpSchema,
} from '@movp/core-schema'

export function projectSchema(
  collections: CollectionDef[],
  events: EventDef[] = [],
): MovpSchema {
  return defineSchema({ extends: platformSchema, collections, events })
}

export function projectCollection(name: string): CollectionDef {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    workspaceScoped: true,
    fields: { title: { type: 'text', label: 'Title' } },
  }
}

export function projectEvent(key: string): EventDef {
  return {
    key,
    domain: 'lifecycle',
    payloadSchema: {},
    version: 1,
    label: key,
  }
}
