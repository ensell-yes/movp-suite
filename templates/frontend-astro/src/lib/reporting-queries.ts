export type ReportingDayCount = { day: string; count: number }
export type ReportingTaskThroughput = {
  avgCycleHours: number | null
  openCount: number
  series: ReportingDayCount[]
}
export type ReportingStatusCount = { status: string; count: number }
export type ReportingMetricTotal = { metricKey: string; total: number }
export type ReportingSegmentGrowth = {
  segmentId: string
  name: string
  points: Array<{ takenAt: string; memberCount: number }>
}
export type ReportingOutcomeDayCount = ReportingDayCount & { outcome: string }
export type ReportingSourceDayCount = ReportingDayCount & { source: string }
export type ReportingTypeDayCount = ReportingDayCount & { type: string }
export type ReportingJobDayCount = ReportingDayCount & { kind: string; status: string }

export type ReportingDashboardsData = {
  reportingTaskThroughput: ReportingTaskThroughput
  reportingContentFunnel: ReportingStatusCount[]
  reportingCampaignMetrics: ReportingMetricTotal[]
  reportingSegmentGrowth: ReportingSegmentGrowth[]
  reportingWorkflowHealth: ReportingOutcomeDayCount[]
  reportingIngestVolume: ReportingSourceDayCount[]
  reportingEventDailyCounts: ReportingTypeDayCount[]
  reportingJobDailyCounts: ReportingJobDayCount[]
}

export const REPORTING_DASHBOARDS_QUERY = /* GraphQL */ `
  query ReportingDashboards($workspaceId: ID!, $days: Int!) {
    reportingTaskThroughput(workspaceId: $workspaceId, days: $days) {
      avgCycleHours
      openCount
      series { day count }
    }
    reportingContentFunnel(workspaceId: $workspaceId) { status count }
    reportingCampaignMetrics(workspaceId: $workspaceId, days: $days) { metricKey total }
    reportingSegmentGrowth(workspaceId: $workspaceId) { segmentId name points { takenAt memberCount } }
    reportingWorkflowHealth(workspaceId: $workspaceId, days: $days) { day outcome count }
    reportingIngestVolume(workspaceId: $workspaceId, days: $days) { day source count }
    reportingEventDailyCounts(workspaceId: $workspaceId, days: $days) { day type count }
    reportingJobDailyCounts(workspaceId: $workspaceId, days: $days) { day kind status count }
  }
`
