// Custom list read (Task 1): per-segment member counts + last recompute (generic list can't filter/aggregate).
export const SEGMENT_SUMMARIES_QUERY = /* GraphQL */ `
  query SegmentSummaries($workspaceId: ID!) {
    segmentSummaries(workspaceId: $workspaceId) {
      id name active mode ownerRef memberCount lastRecomputedAt
    }
  }`
// Generic get (codegen surface): scalar fields exposed as String — for the rule-builder header.
export const SEGMENT_GET_QUERY = /* GraphQL */ `
  query Segment($id: ID!) { segment(id: $id) { id name active mode } }`
// Bounded, injection-safe preview (Task 1): audience size for a DRAFT predicate before saving.
export const PREVIEW_MATCHING_COUNT_QUERY = /* GraphQL */ `
  query PreviewMatchingCount($segmentId: ID!, $predicate: String!) {
    previewMatchingCount(segmentId: $segmentId, predicate: $predicate) { count }
  }`
// Saving a new rule version: the segment relation (segment_id) is a RELATION the generic
// createSegmentRule input SKIPS, so Part D authors the custom createSegmentRuleVersion mutation
// (Task 1). The rule builder's Save posts THIS via /api/segments/save-rule (server-side gqlRequest).
export const CREATE_SEGMENT_RULE_VERSION_MUTATION = /* GraphQL */ `
  mutation CreateSegmentRuleVersion($segmentId: ID!, $predicate: String!) {
    createSegmentRuleVersion(segmentId: $segmentId, predicate: $predicate) { id version }
  }`
// Paginated members for ONE segment (bridge — generic list has no segment filter).
export const SEGMENT_MEMBERS_QUERY = /* GraphQL */ `
  query SegmentMembers($segmentId: ID!, $first: Int, $after: String) {
    segmentMembers(segmentId: $segmentId, first: $first, after: $after) {
      items { subjectRef subjectType matchedRuleId evaluatedAt }
      nextCursor
    }
  }`
// Per-member explanation: matched rule version + evidence event trail (ids + typed dimensions ONLY).
export const MEMBERSHIP_EXPLANATION_QUERY = /* GraphQL */ `
  query MembershipExplanation($segmentId: ID!, $subjectRef: String!) {
    segmentMembershipExplained(segmentId: $segmentId, subjectRef: $subjectRef) {
      subjectRef matchedRuleId matchedRuleVersion firstMatchedAt evaluatedAt
      evidence { eventId eventType occurredAt }
    }
  }`
// Snapshots over time (member-count trend) for the history view.
export const SEGMENT_SNAPSHOTS_QUERY = /* GraphQL */ `
  query SegmentSnapshots($segmentId: ID!) {
    segmentSnapshots(segmentId: $segmentId) { id takenAt reason memberCount }
  }`
// Diff between two snapshots (added / removed subject refs + counts).
export const SNAPSHOT_DIFF_QUERY = /* GraphQL */ `
  query SnapshotDiff($snapshotAId: ID!, $snapshotBId: ID!) {
    snapshotDiff(snapshotAId: $snapshotAId, snapshotBId: $snapshotBId) {
      added removed addedCount removedCount
    }
  }`

// Shared row/response types (islands + pages import types only — never @movp/*).
export type SegmentSummary = { id: string; name: string | null; active: boolean | null; mode: string | null
  ownerRef: string | null; memberCount: number; lastRecomputedAt: string | null }
export type SegmentHeader = { id: string; name: string | null; active: boolean | null; mode: string | null }
export type SegmentMemberEntry = { subjectRef: string; subjectType: string | null; matchedRuleId: string | null; evaluatedAt: string | null }
export type SegmentMemberPage = { items: SegmentMemberEntry[]; nextCursor: string | null }
export type EvidenceEvent = { eventId: string; eventType: string | null; occurredAt: string | null }
export type MembershipExplanation = { subjectRef: string; matchedRuleId: string | null; matchedRuleVersion: number | null
  firstMatchedAt: string | null; evaluatedAt: string | null; evidence: EvidenceEvent[] }
export type SnapshotEntry = { id: string; takenAt: string | null; reason: string | null; memberCount: number | null }
export type SnapshotDiff = { added: string[]; removed: string[]; addedCount: number; removedCount: number }
