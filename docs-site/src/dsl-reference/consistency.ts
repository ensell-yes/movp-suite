import type { MovpSchema } from '@movp/core-schema'
import { metadataProjection, schemaFingerprint } from '@movp/core-schema'
import {
  checkMetadataConsistency,
  MetadataConsistencyError,
  type MetadataConsistencyCode,
  type MetadataDbState,
  type SchemaManifest,
} from '@movp/codegen'

// C6f-local code union: C6c's three comparator codes PLUS the docs-only fingerprint
// code. Widening lives in the type — NOT an `as never` cast — so `.code` is exact and
// the fingerprint arm is a real, reachable throw (no unreachable plain-Error fallback).
export type DocsConsistencyCode = MetadataConsistencyCode | 'manifest_fingerprint_mismatch'

export class DocsConsistencyError extends Error {
  constructor(
    readonly code: DocsConsistencyCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'DocsConsistencyError'
  }
}

// Rebuild the DB-shaped projection rows from the manifest so we can reuse C6c's
// pure comparator. label_plural is NOT in the manifest — source it from the schema
// projection for the comparator input; the fingerprint check below is what pins
// label_plural (and every other projected column) end-to-end.
function manifestAsDbState(schema: MovpSchema, manifest: SchemaManifest): MetadataDbState {
  const labelPluralByName = new Map(metadataProjection(schema).collections.map((c) => [c.name, c.label_plural]))
  return {
    collections: manifest.collections.map((c) => ({
      name: c.name,
      label: c.label,
      label_plural: labelPluralByName.get(c.name) ?? '',
      workspace_scoped: c.workspaceScoped,
      layer: c.layer,
    })),
    fields: manifest.collections.flatMap((c) =>
      c.fields.map((field) => ({
        collection_name: c.name,
        name: field.name,
        type: field.type,
        label: field.label,
        cardinality: field.cardinality,
        reporting_role: field.reporting_role,
        searchable: field.searchable,
        embeddable: field.embeddable,
        layer: c.layer,
      })),
    ),
  }
}

export function assertManifestMatchesSchema(schema: MovpSchema, manifest: SchemaManifest): void {
  // Reuse C6c's comparator: throws missing_/altered_/stale_metadata_row on divergence.
  // Re-wrap its MetadataConsistencyError into DocsConsistencyError so EVERY docs
  // consistency failure surfaces as one error type whose `.code` is a DocsConsistencyCode.
  // `error.code` is a MetadataConsistencyCode — a subtype of DocsConsistencyCode — so it
  // flows through the union with NO cast.
  try {
    checkMetadataConsistency(schema, manifestAsDbState(schema, manifest))
  } catch (error: unknown) {
    if (error instanceof MetadataConsistencyError) {
      throw new DocsConsistencyError(error.code, error.detail)
    }
    throw error
  }
  if (manifest.schemaFingerprint !== schemaFingerprint(schema)) {
    // Reachable, real throw — `manifest_fingerprint_mismatch` is in DocsConsistencyCode.
    throw new DocsConsistencyError(
      'manifest_fingerprint_mismatch',
      'docs-site/movp.schema.json is stale — run `pnpm docs:manifest`',
    )
  }
}
