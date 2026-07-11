import type {
  DomainCtx,
  ReportingJobDayCount,
  ReportingMetricTotal,
  ReportingOutcomeDayCount,
  ReportingSegmentGrowth,
  ReportingService,
  ReportingSourceDayCount,
  ReportingStatusCount,
  ReportingTaskThroughput,
  ReportingTypeDayCount,
} from './types.ts'

function fail(operation: string, code: string | undefined): never {
  throw new Error(`domain.reporting.${operation} failed [${code ?? 'unknown'}]`)
}

export function makeReportingService(ctx: DomainCtx): ReportingService {
  const rpc = async <T>(operation: string, name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await ctx.db.rpc(name, args)
    if (error) fail(operation, error.code)
    return data as T
  }

  return {
    taskThroughput: (input) =>
      rpc<ReportingTaskThroughput>('taskThroughput', 'reporting_task_throughput', {
        ws: input.workspaceId,
        days: input.days ?? 30,
      }),
    contentFunnel: (input) =>
      rpc<ReportingStatusCount[]>('contentFunnel', 'reporting_content_funnel', { ws: input.workspaceId }),
    campaignMetrics: (input) =>
      rpc<ReportingMetricTotal[]>('campaignMetrics', 'reporting_campaign_metrics', {
        ws: input.workspaceId,
        days: input.days ?? 30,
      }),
    segmentGrowth: (input) =>
      rpc<ReportingSegmentGrowth[]>('segmentGrowth', 'reporting_segment_growth', {
        ws: input.workspaceId,
        days: input.days ?? 90,
      }),
    workflowHealth: (input) =>
      rpc<ReportingOutcomeDayCount[]>('workflowHealth', 'reporting_workflow_health', {
        ws: input.workspaceId,
        days: input.days ?? 30,
      }),
    ingestVolume: (input) =>
      rpc<ReportingSourceDayCount[]>('ingestVolume', 'reporting_ingest_volume', {
        ws: input.workspaceId,
        days: input.days ?? 30,
      }),
    eventDailyCounts: (input) =>
      rpc<ReportingTypeDayCount[]>('eventDailyCounts', 'reporting_event_daily_counts', {
        ws: input.workspaceId,
        days: input.days ?? 30,
      }),
    jobDailyCounts: (input) =>
      rpc<ReportingJobDayCount[]>('jobDailyCounts', 'reporting_job_daily_counts', {
        ws: input.workspaceId,
        days: input.days ?? 30,
      }),
  }
}
