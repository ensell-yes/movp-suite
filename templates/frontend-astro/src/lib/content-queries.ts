export type ContentTypeRow = {
  id: string
  key: string | null
  label: string | null
  field_schema: string | null
}

export type ContentItemRow = {
  id: string
  slug: string | null
  status: string | null
  content_type_id: string | null
  data?: string | null
  current_revision_id?: string | null
  approved_revision_id?: string | null
  published_revision_id?: string | null
  updated_at?: string | null
  content_type?: ContentTypeRow | null
}

export type ContentRevisionRow = {
  id: string
  parent_id: string | null
  revision_number?: number | null
  data: string | null
  author_id: string | null
  created_at: string
}

export type ContentApprovalRow = {
  id: string
  content_item_id: string | null
  state: string | null
}

export type ContentPage = { items: ContentItemRow[]; nextCursor: string | null }
export type CommentRow = { id: string; body: string | null; author_id: string | null; created_at: string }
export type InboxItem = { kind: string; entity_type: string; entity_id: string; ref_id: string; created_at: string }
export type SearchHit = { collection: string; id: string; title: string; snippet: string; score: number }

export const CONTENT_LIST_QUERY = /* GraphQL */ `
  query Content($workspaceId: ID!, $contentTypeId: ID, $status: String, $first: Int) {
    content(workspaceId: $workspaceId, contentTypeId: $contentTypeId, status: $status, first: $first) {
      items { id slug status content_type_id updated_at }
      nextCursor
    }
  }`

export const CONTENT_TYPES_QUERY = /* GraphQL */ `
  query ContentTypes($workspaceId: ID!) {
    contentTypes(workspaceId: $workspaceId) { id key label field_schema }
  }`

export const CONTENT_SEARCH_QUERY = /* GraphQL */ `
  query Search($workspaceId: ID!, $query: String!) {
    search(workspaceId: $workspaceId, query: $query) { collection id title snippet score }
  }`

export const CONTENT_ITEM_QUERY = /* GraphQL */ `
  query ContentItem($id: ID!) {
    contentItem(id: $id) {
      id slug status data content_type_id current_revision_id approved_revision_id published_revision_id
      content_type { id key label field_schema }
    }
  }`

export const CONTENT_REVISIONS_QUERY = /* GraphQL */ `
  query ContentRevisions($itemId: ID!) {
    contentRevisions(itemId: $itemId) { id parent_id revision_number data author_id created_at }
  }`

export const CONTENT_COMMENTS_QUERY = /* GraphQL */ `
  query ContentComments($workspaceId: ID!, $entityId: ID!) {
    comments(workspaceId: $workspaceId, entityType: "content_item", entityId: $entityId) { id body author_id created_at }
  }`

export const APPROVALS_QUERY = /* GraphQL */ `
  query ContentApprovals($workspaceId: ID!) {
    contentApprovals(workspaceId: $workspaceId, state: "pending") { id content_item_id state }
  }`

export const APPROVALS_PAGE_QUERY = /* GraphQL */ `
  query ContentApprovalsPage($workspaceId: ID!) {
    contentApprovals(workspaceId: $workspaceId, state: "pending") { id content_item_id state }
    content(workspaceId: $workspaceId, first: 100) { items { id slug } nextCursor }
  }`

export const INBOX_QUERY = /* GraphQL */ `
  query Inbox($workspaceId: ID!, $tab: String!) {
    inbox(workspaceId: $workspaceId, tab: $tab) { kind entity_type entity_id ref_id created_at }
  }`

export const UPDATE_CONTENT_MUTATION = /* GraphQL */ `
  mutation UpdateContent($id: ID!, $data: String!, $expectedRevisionId: ID) {
    updateContent(id: $id, data: $data, expectedRevisionId: $expectedRevisionId) { id status current_revision_id }
  }`

export const RUN_SEO_AUDIT_MUTATION = /* GraphQL */ `
  mutation RunSeoAudit($itemId: ID!) { runSeoAudit(itemId: $itemId) { score checklist } }`

export const SUBMIT_MUTATION = /* GraphQL */ `
  mutation SubmitContent($itemId: ID!) { submitForApproval(itemId: $itemId) { id status } }`

export const DECIDE_MUTATION = /* GraphQL */ `
  mutation DecideApproval($approvalId: ID!, $vote: String!) { decideApproval(approvalId: $approvalId, vote: $vote) { id state } }`

export const PUBLISH_MUTATION = /* GraphQL */ `
  mutation PublishContent($itemId: ID!) { publishContent(itemId: $itemId) { id status published_revision_id } }`

export const UNPUBLISH_MUTATION = /* GraphQL */ `
  mutation UnpublishContent($itemId: ID!) { unpublishContent(itemId: $itemId) { id status } }`

export const SCHEDULE_MUTATION = /* GraphQL */ `
  mutation ScheduleContent($itemId: ID!, $action: String!, $revisionId: ID!, $runAt: String!) {
    scheduleContent(itemId: $itemId, action: $action, revisionId: $revisionId, runAt: $runAt) { id state }
  }`

export const ISSUE_ASSET_UPLOAD_MUTATION = /* GraphQL */ `
  mutation IssueAssetUpload($workspaceId: ID!, $filename: String!, $mime: String!, $sizeBytes: Int!) {
    issueAssetUpload(workspaceId: $workspaceId, filename: $filename, mime: $mime, sizeBytes: $sizeBytes) { uploadUrl assetId r2Key }
  }`

export const FINALIZE_ASSET_MUTATION = /* GraphQL */ `
  mutation FinalizeAsset($assetId: ID!, $checksum: String!, $sizeBytes: Int!, $width: Int, $height: Int) {
    finalizeAsset(assetId: $assetId, checksum: $checksum, sizeBytes: $sizeBytes, width: $width, height: $height) { id r2_key }
  }`
