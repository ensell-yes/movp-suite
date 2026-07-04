export type CampaignRow = {
  id: string
  name: string | null
  status: string | null
  priority: string | null
  rank: string | null
  start_date: string | null
  end_date: string | null
}

export type CampaignPage = { items: CampaignRow[]; nextCursor: string | null }

export type CampaignMetricTarget = {
  metricKey: string
  targetValue: string | null
  unit: string | null
}

export type CampaignMetricActual = {
  metricKey: string
  total: number
}

export type CampaignDeliverableBrief = {
  id: string
  name: string | null
  taskId: string | null
}

export type CampaignChannelBrief = {
  id: string
  channelType: string | null
  name: string | null
}

export type CampaignStakeholders = {
  ownerId: string | null
  observerIds: string[]
}

export type CampaignDetail = {
  id: string
  name: string | null
  brief: string | null
  status: string | null
  priority: string | null
  rank: string | null
  startDate: string | null
  endDate: string | null
  ownerId: string | null
  marketingPlanId: string | null
  goalMetrics: CampaignMetricTarget[]
  actuals: CampaignMetricActual[]
  deliverables: CampaignDeliverableBrief[]
  channels: CampaignChannelBrief[]
  stakeholders: CampaignStakeholders
}

export type CampaignCommentRow = {
  id: string
  body: string | null
  author_id: string | null
  created_at: string
}

export type CampaignDeliverableRow = {
  id: string
  name: string | null
}

export type CampaignDeliverablePage = { items: CampaignDeliverableRow[]; nextCursor: string | null }

export type CampaignDeliverableSchedule = {
  deliverableId: string
  taskId: string | null
  startDate: string | null
  dueDate: string | null
}

export type CampaignCalendarEventRow = {
  id: string
  title: string | null
  event_date: string | null
  event_type: string | null
}

export type CampaignCalendarEventPage = { items: CampaignCalendarEventRow[]; nextCursor: string | null }

export { TASK_BOARD_QUERY } from './task-queries.ts'
export type { TaskBoardColumn } from './task-queries.ts'

// Generic list (codegen surface): scalar fields exposed as String, sorted client-side.
export const CAMPAIGNS_QUERY = /* GraphQL */ `
  query Campaigns($workspaceId: ID!, $first: Int) {
    campaigns(workspaceId: $workspaceId, first: $first) {
      items { id name status priority rank start_date end_date }
      nextCursor
    }
  }`

// Custom per-campaign read (Task 1): target-vs-actual + stakeholders + deliverables/channels.
export const CAMPAIGN_DETAIL_QUERY = /* GraphQL */ `
  query CampaignDetail($campaignId: ID!) {
    campaignDetail(campaignId: $campaignId) {
      id name brief status priority rank startDate endDate ownerId marketingPlanId
      goalMetrics { metricKey targetValue unit }
      actuals { metricKey total }
      deliverables { id name taskId }
      channels { id channelType name }
      stakeholders { ownerId observerIds }
    }
  }`

// Discussion reuses the Task phase's comments read query with entity_type='campaign'.
export const CAMPAIGN_COMMENTS_QUERY = /* GraphQL */ `
  query CampaignComments($workspaceId: ID!, $entityId: ID!) {
    comments(workspaceId: $workspaceId, entityType: "campaign", entityId: $entityId) {
      id body author_id created_at
    }
  }`

// Enumerate deliverables (generic list): id + name scalars are exposed.
export const DELIVERABLES_QUERY = /* GraphQL */ `
  query Deliverables($workspaceId: ID!, $first: Int) {
    campaign_deliverables(workspaceId: $workspaceId, first: $first) {
      items { id name }
      nextCursor
    }
  }`

// Backing-task schedules for all deliverables in one batched custom read.
export const DELIVERABLE_SCHEDULES_QUERY = /* GraphQL */ `
  query DeliverableSchedules($deliverableIds: [ID!]!) {
    deliverableSchedules(deliverableIds: $deliverableIds) {
      deliverableId taskId startDate dueDate
    }
  }`

// Calendar-event milestones (generic list): title/event_date/event_type scalars are exposed.
export const CALENDAR_EVENTS_QUERY = /* GraphQL */ `
  query CalendarEvents($workspaceId: ID!, $first: Int) {
    campaign_calendar_events(workspaceId: $workspaceId, first: $first) {
      items { id title event_date event_type }
      nextCursor
    }
  }`
