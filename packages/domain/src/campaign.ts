import { makeGraphService } from './graph.ts'
import type { DomainCtx, CampaignService } from './types.ts' // match content.ts's import style/paths

export function makeCampaignService(ctx: DomainCtx): CampaignService {
  const graph = makeGraphService(ctx) // sibling — NOT this.graph

  const fail = (op: string, code: string): never => {
    throw new Error(`domain.campaign.${op} failed [${code}]`)
  }

  // probe a deliverable's workspace (+ its campaign) under caller RLS
  async function deliverableWorkspace(op: string, deliverableId: string): Promise<{ workspaceId: string; campaignId: string }> {
    const { data, error } = await ctx.db
      .from('campaign_deliverable')
      .select('workspace_id, campaign_id')
      .eq('id', deliverableId)
      .maybeSingle()
    if (error) return fail(op, 'probe_failed')
    if (!data) return fail(op, 'deliverable_not_found') // includes cross-workspace (RLS hides the row)
    return { workspaceId: data.workspace_id, campaignId: data.campaign_id }
  }

  // probe a campaign's workspace under caller RLS
  async function campaignWorkspace(op: string, campaignId: string): Promise<string> {
    const { data, error } = await ctx.db
      .from('campaign')
      .select('workspace_id')
      .eq('id', campaignId)
      .maybeSingle()
    if (error) return fail(op, 'probe_failed')
    if (!data) return fail(op, 'campaign_not_found')
    return data.workspace_id
  }

  // GRAPH-WRITE BOUNDARY (load-bearing): `public.edges` has NO FK to its polymorphic (dst_type,dst_id),
  // so graph.link will happily persist a DANGLING or CROSS-WORKSPACE edge. The two ops whose bad edge causes
  // real harm validate their destination under caller RLS BEFORE writing: linkTask (a bad task edge silently
  // never bridges/schedules → validate same-workspace task) and addObserver (an observer edge feeds the email
  // fan-out → validate the target is a member). linkContent + linkSegment document why they intentionally don't.
  async function requireSameWorkspace(op: string, table: string, id: string, workspaceId: string, code: string): Promise<void> {
    const { data, error } = await ctx.db.from(table).select('workspace_id').eq('id', id).maybeSingle()
    if (error) return fail(op, 'probe_failed') // fail(): never — matches the deliverableWorkspace idiom above
    // null → missing OR RLS-hidden (caller not a member of its workspace); mismatch → cross-workspace.
    if (!data || data.workspace_id !== workspaceId) return fail(op, code)
  }
  // member_read RLS (`using is_workspace_member(workspace_id)`, migration 000001) lets a member SELECT
  // co-member rows, so the caller can confirm the target is a member of the campaign's workspace.
  async function requireMember(op: string, workspaceId: string, userId: string): Promise<void> {
    const { data, error } = await ctx.db.from('workspace_membership').select('user_id')
      .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
    if (error) return fail(op, 'probe_failed')
    if (!data) return fail(op, 'user_not_member')
  }

  return {
    async linkTask({ deliverableId, taskId }) {
      const { workspaceId } = await deliverableWorkspace('linkTask', deliverableId)
      await requireSameWorkspace('linkTask', 'task', taskId, workspaceId, 'task_not_found')
      await graph.link({ workspaceId, srcType: 'campaign_deliverable', srcId: deliverableId, rel: 'implemented_by', dstType: 'task', dstId: taskId })
    },
    async linkContent({ deliverableId, contentItemId }) {
      const { workspaceId } = await deliverableWorkspace('linkContent', deliverableId)
      // NOTE: contentItemId is NOT strictly validated — a dangling produces-edge is a MINOR gap (it yields no
      // readiness signal, but no email fan-out and no silent bridge failure, unlike a bad linkTask). Validating
      // it would couple this phase's test to CMS's content_item insert shape; deferred by choice. (linkTask and
      // addObserver, whose bad edges DO cause harm, are validated.)
      await graph.link({ workspaceId, srcType: 'campaign_deliverable', srcId: deliverableId, rel: 'produces', dstType: 'content_item', dstId: contentItemId })
    },
    async linkSegment({ campaignId, segmentId }) {
      const workspaceId = await campaignWorkspace('linkSegment', campaignId)
      // FORWARD SEAM: segmentId is intentionally NOT validated — the `segment` table does not exist until
      // Phase 6. The edge is written now (targeting INTENT) and resolves to zero rows until Phase 6 lands
      // `segment` (roadmap forward-compat design). This is the only link op whose destination cannot be checked.
      await graph.link({ workspaceId, srcType: 'campaign', srcId: campaignId, rel: 'targets', dstType: 'campaign_segment', dstId: segmentId })
    },
    async addObserver({ campaignId, userId }) {
      // AUTHORIZATION: NOT owner-gated (any member may add an observer — additive, grants no row visibility),
      // BUT the target userId MUST be a workspace member. A campaign observer edge feeds the notification/
      // webhook fan-out (campaign recipients = owner_id + observer edges), so an edge to a NON-member would
      // route campaign emails to someone outside the tenant. requireMember enforces membership. (If a product
      // rule later requires owner-only observer management, add that gate too — this only bounds the target.)
      const workspaceId = await campaignWorkspace('addObserver', campaignId)
      await requireMember('addObserver', workspaceId, userId)
      await graph.link({ workspaceId, srcType: 'campaign', srcId: campaignId, rel: 'observer', dstType: 'user', dstId: userId })
    },
    async deliverableSchedule(deliverableId) {
      const { data: edge, error: edgeErr } = await ctx.db
        .from('edges')
        .select('dst_id')
        .eq('src_type', 'campaign_deliverable')
        .eq('src_id', deliverableId)
        .eq('rel', 'implemented_by')
        .eq('dst_type', 'task')
        .maybeSingle()
      if (edgeErr) return fail('deliverableSchedule', 'edge_probe_failed')
      if (!edge) return null
      const taskId = edge.dst_id as string
      const { data: task, error: taskErr } = await ctx.db
        .from('task')
        .select('id, start_date, due_date')
        .eq('id', taskId)
        .maybeSingle()
      if (taskErr) return fail('deliverableSchedule', 'task_probe_failed')
      if (!task) return null
      return { taskId: task.id, startDate: task.start_date, dueDate: task.due_date }
    },
    // BATCHED sibling of deliverableSchedule: resolve every deliverable's backing-task dates in
    // exactly TWO caller-RLS queries (edges .in + task .in), so a timeline over N deliverables is
    // O(1) round-trips, not O(N). Deliverables with no implemented_by edge are simply absent from
    // the result (no null placeholder). Order is not guaranteed — callers key by deliverableId.
    async deliverableSchedules(deliverableIds) {
      if (deliverableIds.length === 0) return []
      const { data: edges, error: edgeErr } = await ctx.db
        .from('edges')
        .select('src_id, dst_id')
        .in('src_id', deliverableIds)
        .eq('src_type', 'campaign_deliverable')
        .eq('rel', 'implemented_by')
        .eq('dst_type', 'task')
      if (edgeErr) return fail('deliverableSchedules', 'edge_probe_failed')
      const rows = edges ?? []
      const taskIds = rows.map((e) => e.dst_id as string)
      if (taskIds.length === 0) return []
      const { data: tasks, error: taskErr } = await ctx.db
        .from('task')
        .select('id, start_date, due_date')
        .in('id', taskIds)
      if (taskErr) return fail('deliverableSchedules', 'task_probe_failed')
      const byId = new Map((tasks ?? []).map((t) => [t.id as string, t]))
      return rows.flatMap((e) => {
        const t = byId.get(e.dst_id as string)
        return t
          ? [{ deliverableId: e.src_id as string, taskId: t.id as string,
               startDate: t.start_date as string | null, dueDate: t.due_date as string | null }]
          : []
      })
    },
  }
}
