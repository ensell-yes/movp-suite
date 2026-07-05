import type { CollectionDef, EventDef, MovpSchema } from './types.ts'

const IDENT = /^[a-z][a-z0-9_]*$/
const EVENT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

export function defineCollection(def: CollectionDef): CollectionDef {
  if (!IDENT.test(def.name)) {
    throw new Error(`collection name must be snake_case matching ${IDENT} (got "${def.name}")`)
  }
  if (!def.label || !def.labelPlural) {
    throw new Error(`collection "${def.name}" requires both label and labelPlural`)
  }

  for (const [fname, field] of Object.entries(def.fields)) {
    if (!IDENT.test(fname)) {
      throw new Error(`field name must be snake_case matching ${IDENT} (got "${fname}" in "${def.name}")`)
    }
    if (!field.label) {
      throw new Error(`field "${def.name}.${fname}" requires a label`)
    }
    if (field.type === 'enum' && (!field.values || field.values.length === 0)) {
      throw new Error(`enum field "${def.name}.${fname}" requires non-empty values`)
    }
    if (field.type === 'relation') {
      if (!field.target) {
        throw new Error(`relation field "${def.name}.${fname}" requires a target`)
      }
      if (!field.cardinality) {
        throw new Error(`relation field "${def.name}.${fname}" requires a cardinality`)
      }
    }
  }

  return def
}

export function defineEvent(def: EventDef): EventDef {
  if (!EVENT_KEY.test(def.key)) {
    throw new Error(`event key must be dotted lower-case matching ${EVENT_KEY} (got "${def.key}")`)
  }
  if (def.version < 1) {
    throw new Error(`event "${def.key}" requires version >= 1`)
  }
  return def
}

export function defineSchema(collections: CollectionDef[], events: EventDef[] = []): MovpSchema {
  const names = new Set<string>()
  for (const c of collections) {
    if (names.has(c.name)) throw new Error(`duplicate collection name "${c.name}"`)
    names.add(c.name)
  }

  const eventKeys = new Set<string>()
  for (const event of events) {
    if (eventKeys.has(event.key)) throw new Error(`duplicate event key "${event.key}"`)
    eventKeys.add(event.key)
  }

  for (const c of collections) {
    for (const [fname, field] of Object.entries(c.fields)) {
      if (field.type === 'relation' && field.target && !names.has(field.target)) {
        throw new Error(`relation "${c.name}.${fname}" targets unknown collection "${field.target}"`)
      }
    }
  }

  return { collections, events }
}
