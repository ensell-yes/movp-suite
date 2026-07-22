import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AssetRow,
  AutomationRuleRow,
  CommentRow,
  ContentApprovalRow,
  ContentCollectionRow,
  ContentItemRow,
  ContentRevisionRow,
  ContentScheduleRow,
  ContentSeoRow,
  ContentTypeRow,
  CampaignCreate,
  CampaignRow,
  EventTypeRow,
  CampaignUpdate,
  MarketingPlanCreate,
  MarketingPlanRow,
  MarketingPlanUpdate,
  NoteCreate,
  NoteRow,
  NoteUpdate,
  TagCreate,
  TagRow,
  TagUpdate,
  TaskPriorityOptionCreate,
  TaskPriorityOptionRow,
  TaskPriorityOptionUpdate,
  TaskAssignmentRow,
  TaskAttachmentRow,
  TaskDependencyRow,
  TaskObserverRow,
  TaskRow,
  TaskStatusOptionRow,
  WebhookSubscriptionRow,
} from './generated/types.ts'

export interface DomainCtx {
  db: SupabaseClient
  userId: string
  accessToken?: string
  assetsFnUrl?: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ListArgs {
  workspaceId: string
  first?: number
  after?: string | null
}

export interface SearchArgs {
  workspaceId: string
  query: string
  mode?: 'fts' | 'semantic' | 'hybrid'
  collection?: string
  limit?: number
}

export interface SearchHit {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

export interface CollectionService<Row, Create, Update> {
  create(input: Create): Promise<Row>
  get(id: string): Promise<Row | null>
  list(args: ListArgs): Promise<Page<Row>>
  update(id: string, patch: Update): Promise<Row>
  delete(id: string): Promise<void>
}

export interface GraphService {
  link(a: {
    workspaceId: string
    srcType: string
    srcId: string
    rel: string
    dstType: string
    dstId: string
  }): Promise<void>
  traverse(a: {
    workspaceId: string
    srcType: string
    srcId: string
    rel?: string
    depth?: number
  }): Promise<Array<{ type: string; id: string; depth: number }>>
}

export interface InboxItem {
  kind: string
  entity_type: string
  entity_id: string
  ref_id: string
  created_at: string
  payload: Record<string, unknown>
}

export interface CollabService {
  comment: {
    create(input: {
      entityType: string
      entityId: string
      body: string
      parentId?: string
      mentions?: string[]
    }): Promise<CommentRow>
    listByEntity(a: {
      workspaceId: string
      entityType: string
      entityId: string
      first?: number
      after?: string | null
    }): Promise<Page<CommentRow>>
  }
  react(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  unreact(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  save(i: { entityType: string; entityId: string }): Promise<void>
  unsave(i: { entityType: string; entityId: string }): Promise<void>
  createShareLink(i: { entityType: string; entityId: string; expiresInHours?: number }): Promise<{ token: string }>
  inbox(a: { workspaceId: string; tab: 'all' | 'mentions' | 'saved' | 'assigned'; first?: number }): Promise<InboxItem[]>
}

export interface TaskBoardColumn {
  status: TaskStatusOptionRow
  tasks: TaskRow[]
}

export interface TaskDetail {
  task: TaskRow
  description: string | null
  assignments: TaskAssignmentRow[]
  observers: TaskObserverRow[]
  dependencies: TaskDependencyRow[]
  attachments: TaskAttachmentRow[]
}

export interface TaskService {
  create(i: { workspaceId: string; title: string; description?: string; statusId?: string; priorityId?: string; parentId?: string; startDate?: string; dueDate?: string; idempotencyKey?: string; actorId?: string }): Promise<TaskRow>
  get(id: string): Promise<TaskRow | null>
  getDetail(id: string): Promise<TaskDetail | null>
  list(a: { workspaceId: string; statusId?: string; assigneeId?: string; parentId?: string | null; first?: number; after?: string | null }): Promise<Page<TaskRow>>
  board(a: { workspaceId: string }): Promise<TaskBoardColumn[]>
  updateDescription(id: string, body: string): Promise<TaskRow>
  assign(i: { taskId: string; userId: string }): Promise<void>
  unassign(i: { taskId: string; userId: string }): Promise<void>
  addObserver(i: { taskId: string; userId: string }): Promise<void>
  removeObserver(i: { taskId: string; userId: string }): Promise<void>
  transition(i: { taskId: string; statusId: string }): Promise<TaskRow>
  addDependency(i: { taskId: string; blockerId: string }): Promise<void>
  removeDependency(i: { taskId: string; blockerId: string }): Promise<void>
  attach(i: { taskId: string; r2Key: string; filename: string; contentType?: string; bytes?: number }): Promise<void>
}

export interface ContentDetail {
  item: ContentItemRow
  type: ContentTypeRow | null
  currentRevision: ContentRevisionRow | null
}

export interface ContentService {
  createType(i: { workspaceId: string; key: string; label: string; fieldSchema: unknown; moderationPolicy?: string; approvalPolicy?: string }): Promise<ContentTypeRow>
  listTypes(a: { workspaceId: string; first?: number; after?: string | null }): Promise<Page<ContentTypeRow>>
  create(i: { workspaceId: string; contentTypeId: string; slug: string; data: Record<string, unknown> }): Promise<ContentItemRow>
  update(i: { itemId: string; data: Record<string, unknown>; expectedRevisionId?: string | null }): Promise<ContentItemRow>
  get(id: string): Promise<ContentItemRow | null>
  getDetail(id: string): Promise<ContentDetail | null>
  list(a: { workspaceId: string; contentTypeId?: string; status?: string; first?: number; after?: string | null }): Promise<Page<ContentItemRow>>
  listRevisions(a: { itemId: string; first?: number; after?: string | null }): Promise<Page<ContentRevisionRow>>
  submitForApproval(i: { itemId: string; policy?: 'single' | 'multi' | 'moderation'; approvalsRequired?: number }): Promise<ContentItemRow>
  decideApproval(i: { approvalId: string; vote: 'approve' | 'reject' }): Promise<ContentApprovalRow>
  publish(i: { itemId: string }): Promise<ContentItemRow>
  unpublish(i: { itemId: string }): Promise<ContentItemRow>
  getPublished(id: string): Promise<{ item: ContentItemRow; revision: ContentRevisionRow } | null>
  listApprovals(a: { workspaceId: string; itemId?: string; state?: 'pending' | 'approved' | 'rejected' | 'superseded'; first?: number; after?: string | null }): Promise<Page<ContentApprovalRow>>
  schedule(i: { itemId: string; action: 'publish' | 'unpublish'; revisionId: string; runAt: string }): Promise<ContentScheduleRow>
  issueAssetUpload(i: { workspaceId: string; filename: string; mime: string; sizeBytes: number }): Promise<{ uploadUrl: string; r2Key: string; assetId: string }>
  finalizeAsset(i: { assetId: string; checksum: string; sizeBytes: number; width?: number; height?: number }): Promise<AssetRow>
  createCollection(i: { workspaceId: string; key: string; label: string; description?: string }): Promise<ContentCollectionRow>
  addToCollection(i: { collectionId: string; itemId: string; position?: number }): Promise<void>
  reorderCollection(i: { collectionId: string; orderedItemIds: string[] }): Promise<void>
  runSeoAudit(i: { itemId: string }): Promise<ContentSeoRow>
  linkAsset(i: { itemId: string; assetId: string }): Promise<void>
  linkItem(i: { itemId: string; targetItemId: string }): Promise<void>
  linkEditorialTask(i: { itemId: string; taskId: string }): Promise<void>
}

export interface CampaignService extends CollectionService<CampaignRow, CampaignCreate, CampaignUpdate> {
  linkTask(i: { deliverableId: string; taskId: string }): Promise<void>                 // edge deliverable -> task (implemented_by); rejects [task_not_found] if the task is missing or cross-workspace
  linkContent(i: { deliverableId: string; contentItemId: string }): Promise<void>       // edge deliverable -> content_item (produces)
  linkSegment(i: { campaignId: string; segmentId: string }): Promise<void>              // edge campaign -> segment (targets; inert until Phase 6)
  addObserver(i: { campaignId: string; userId: string }): Promise<void>                 // edge campaign -> user (observer); rejects [user_not_member] — target MUST be a workspace member (feeds notification fan-out); NOT owner-gated by design (see impl note)
  deliverableSchedule(deliverableId: string): Promise<{ taskId: string; startDate: string | null; dueDate: string | null } | null> // reverse edge -> backing task's dates
  deliverableSchedules(deliverableIds: string[]): Promise<Array<{ deliverableId: string; taskId: string; startDate: string | null; dueDate: string | null }>> // BATCHED: all backing-task dates in TWO queries (edges .in + task .in) — avoids Part C timeline N+1
}

export interface WorkflowService {
  listEventTypes(a: { first?: number; after?: string | null }): Promise<Page<EventTypeRow>>
  listRules(a: { workspaceId: string; first?: number; after?: string | null }): Promise<Page<AutomationRuleRow>>
  upsertRule(i: {
    workspaceId: string
    id?: string
    triggerEventTypeId: string
    condition?: Record<string, unknown>
    actionType: AutomationRuleRow['action_type']
    actionConfig: Record<string, unknown>
    enabled: boolean
    priority: number
  }): Promise<AutomationRuleRow>
  getEvent(a: { workspaceId: string; eventId: string }): Promise<Record<string, unknown> | null>
  registerWebhook(i: { workspaceId: string; eventKey: string; url: string; filter?: unknown }): Promise<{ subscriptionId: string; secret: string }>
  rotateWebhook(i: { workspaceId: string; subscriptionId: string }): Promise<{ subscriptionId: string; secret: string }>
  setWebhookActive(i: { workspaceId: string; subscriptionId: string; active: boolean }): Promise<WebhookSubscriptionRow>
  setWebhookFilter(i: { workspaceId: string; subscriptionId: string; filter: unknown }): Promise<WebhookSubscriptionRow>
}

export interface WorkspaceRow {
  id: string
  name: string
  created_at: string
}

export interface WorkspaceMemberRow {
  workspace_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  created_at: string
}

export interface AdminInviteResult {
  inviteId: string
  token: string
}

export interface IngestKeyRow {
  id: string
  label: string | null
  active: boolean
  created_at: string
}

export interface IngestKeySecret {
  keyId: string
  rawKey: string
}

export interface PatTokenRow {
  id: string
  name: string
  default_workspace_id: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export interface CreatedPat {
  tokenId: string
  token: string
}

export interface PatService {
  createToken(i: { defaultWorkspaceId: string; name: string; ttlDays?: number | null }): Promise<CreatedPat>
  listTokens(): Promise<PatTokenRow[]>
  revokeToken(i: { tokenId: string }): Promise<void>
}

export interface AgentAccessPreferences {
  mcpEnabled: boolean
  cliEnabled: boolean
}

export interface AgentAccessService {
  get(): Promise<AgentAccessPreferences>
  update(mcpEnabled: boolean, cliEnabled: boolean): Promise<AgentAccessPreferences>
}

export interface DeadJobRow {
  id: string
  kind: string
  attempts: number
  last_error_code: string | null
  updated_at: string
  payload_keys: string[]
}

export interface WorkspaceSettings {
  workspace_id: string
  name: string | null
  member_count: number
}

export interface AdminService {
  createWorkspace(i: { name: string }): Promise<WorkspaceRow>
  inviteMember(i: { workspaceId: string; email: string; role: 'admin' | 'member' }): Promise<AdminInviteResult>
  acceptInvite(i: { token: string }): Promise<WorkspaceMemberRow>
  listMembers(i: { workspaceId: string }): Promise<WorkspaceMemberRow[]>
  setMemberRole(i: { workspaceId: string; userId: string; role: 'owner' | 'admin' | 'member' }): Promise<WorkspaceMemberRow>
  removeMember(i: { workspaceId: string; userId: string }): Promise<void>
  createIngestKey(i: { workspaceId: string; label: string }): Promise<IngestKeySecret>
  rotateIngestKey(i: { workspaceId: string; keyId: string }): Promise<IngestKeySecret>
  revokeIngestKey(i: { workspaceId: string; keyId: string }): Promise<void>
  listIngestKeys(i: { workspaceId: string }): Promise<IngestKeyRow[]>
  jobCounts(i: { workspaceId: string }): Promise<Record<string, number>>
  deadJobs(i: { workspaceId: string; first?: number }): Promise<DeadJobRow[]>
  replayDeadJobs(i: { workspaceId: string; kind?: string | null }): Promise<number>
  settings(i: { workspaceId: string }): Promise<WorkspaceSettings>
}

export interface ReportingDayCount {
  day: string
  count: number
}

export interface ReportingTaskThroughput {
  avg_cycle_hours: number | null
  open_count: number
  series: ReportingDayCount[]
}

export interface ReportingStatusCount {
  status: string
  count: number
}

export interface ReportingMetricTotal {
  metric_key: string
  total: number
}

export interface ReportingSnapshotPoint {
  taken_at: string
  member_count: number
}

export interface ReportingSegmentGrowth {
  segment_id: string
  name: string
  points: ReportingSnapshotPoint[]
}

export interface ReportingOutcomeDayCount extends ReportingDayCount {
  outcome: string
}

export interface ReportingSourceDayCount extends ReportingDayCount {
  source: string
}

export interface ReportingTypeDayCount extends ReportingDayCount {
  type: string
}

export interface ReportingJobDayCount extends ReportingDayCount {
  kind: string
  status: string
}

export interface ReportingService {
  taskThroughput(input: { workspaceId: string; days?: number }): Promise<ReportingTaskThroughput>
  contentFunnel(input: { workspaceId: string }): Promise<ReportingStatusCount[]>
  campaignMetrics(input: { workspaceId: string; days?: number }): Promise<ReportingMetricTotal[]>
  segmentGrowth(input: { workspaceId: string; days?: number }): Promise<ReportingSegmentGrowth[]>
  workflowHealth(input: { workspaceId: string; days?: number }): Promise<ReportingOutcomeDayCount[]>
  ingestVolume(input: { workspaceId: string; days?: number }): Promise<ReportingSourceDayCount[]>
  eventDailyCounts(input: { workspaceId: string; days?: number }): Promise<ReportingTypeDayCount[]>
  jobDailyCounts(input: { workspaceId: string; days?: number }): Promise<ReportingJobDayCount[]>
}

export interface Domain {
  collection(name: string): CollectionService<{ id: string } & Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  task: TaskService
  content: ContentService
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
  collab: CollabService
  campaign: CampaignService
  workflows: WorkflowService
  admin: AdminService
  pat: PatService
  agentAccess: AgentAccessService
  reporting: ReportingService
}
