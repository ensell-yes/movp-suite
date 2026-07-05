import type { EventDef } from '@movp/core-schema'

export interface EventCatalogCheck {
  missingFromCatalog: string[]
  unusedCatalogKeys: string[]
}

function eventKey(value: EventDef | string): string {
  return typeof value === 'string' ? value : value.key
}

export function checkEventCatalog(events: Array<EventDef | string>, knownCallsites: string[]): EventCatalogCheck {
  const catalog = new Set(events.map(eventKey))
  const callsites = new Set(knownCallsites)

  return {
    missingFromCatalog: [...callsites].filter((key) => !catalog.has(key)).sort(),
    unusedCatalogKeys: [...catalog].filter((key) => !callsites.has(key)).sort(),
  }
}
