import type { SupabaseClient } from '@supabase/supabase-js'
import type { Domain, EmbeddingProvider } from '@movp/domain'

export type ReportingOperation =
  | 'reportingTaskThroughput'
  | 'reportingContentFunnel'
  | 'reportingCampaignMetrics'
  | 'reportingSegmentGrowth'
  | 'reportingWorkflowHealth'
  | 'reportingIngestVolume'
  | 'reportingEventDailyCounts'
  | 'reportingJobDailyCounts'

export interface ReportingFailureEvent {
  operation: ReportingOperation
  errorCode: 'reporting_denied' | 'reporting_failed'
  workspaceId: string
}

export interface GraphQLContext {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
  accessToken?: string
  assetsFnUrl?: string
  domain?: Domain
  reportReportingFailure?: (event: ReportingFailureEvent) => void | Promise<void>
}

export type Row = { id: string; workspace_id: string; created_at: string; updated_at: string } & Record<
  string,
  unknown
>
