export type EventTypeRow = {
  id: string
  key: string
  domain: string | null
  label: string | null
  active: boolean | null
}

export type AutomationRuleRow = {
  id: string
  trigger_event_type_id: string
  condition: string | null
  action_type: string | null
  action_config: string | null
  enabled: boolean | null
  priority: number | null
  updated_at: string
}

export type AutomationRulePage = { items: AutomationRuleRow[]; nextCursor: string | null }

export type WebhookSubscriptionRow = {
  id: string
  event_type_id: string
  url: string | null
  filter: string | null
  active: boolean | null
  secret_set: boolean | null
  secret_last_rotated_at: string | null
  internal_webhook_id: string | null
  updated_at: string
}

export type WebhookSubscriptionPage = { items: WebhookSubscriptionRow[]; nextCursor: string | null }

export type WorkflowRunRow = {
  id: string
  source_event_id: string
  event_type: string | null
  matched: boolean | null
  action_type: string | null
  outcome: string | null
  job_id: string | null
  error_code: string | null
  trace_id: string | null
  automation_rule_id: string
  updated_at: string
}

export type WorkflowRunPage = { items: WorkflowRunRow[]; nextCursor: string | null }

export type WebhookSecret = { subscriptionId: string; secret: string }
export type WorkflowReplayResult = { replayed: number }

export const WORKFLOW_RULES_QUERY = /* GraphQL */ `
  query WorkflowRules($workspaceId: ID!, $first: Int) {
    eventTypes(first: 100) { items { id key domain label active } nextCursor }
    automationRules(workspaceId: $workspaceId, first: $first) {
      items { id trigger_event_type_id condition action_type action_config enabled priority updated_at }
      nextCursor
    }
  }`

export const WORKFLOW_WEBHOOKS_QUERY = /* GraphQL */ `
  query WorkflowWebhooks($workspaceId: ID!, $first: Int) {
    eventTypes(first: 100) { items { id key domain label active } nextCursor }
    webhook_subscriptions(workspaceId: $workspaceId, first: $first) {
      items { id event_type_id url filter active secret_set secret_last_rotated_at internal_webhook_id updated_at }
      nextCursor
    }
  }`

export const WORKFLOW_RUNS_QUERY = /* GraphQL */ `
  query WorkflowRuns($workspaceId: ID!, $first: Int) {
    workflow_runs(workspaceId: $workspaceId, first: $first) {
      items { id source_event_id event_type matched action_type outcome job_id error_code trace_id automation_rule_id updated_at }
      nextCursor
    }
  }`

export const WORKFLOW_EVENT_QUERY = /* GraphQL */ `
  query WorkflowEvent($workspaceId: ID!, $eventId: ID!) {
    workflowEvent(workspaceId: $workspaceId, eventId: $eventId)
  }`

export const UPSERT_AUTOMATION_RULE_MUTATION = /* GraphQL */ `
  mutation UpsertAutomationRule(
    $workspaceId: ID!
    $id: ID
    $triggerEventTypeId: ID!
    $condition: String
    $actionType: String!
    $actionConfig: String!
    $enabled: Boolean!
    $priority: Int!
  ) {
    upsertAutomationRule(
      workspaceId: $workspaceId
      id: $id
      triggerEventTypeId: $triggerEventTypeId
      condition: $condition
      actionType: $actionType
      actionConfig: $actionConfig
      enabled: $enabled
      priority: $priority
    ) { id action_type enabled priority updated_at }
  }`

export const REGISTER_WEBHOOK_MUTATION = /* GraphQL */ `
  mutation RegisterWebhookSubscription($workspaceId: ID!, $eventKey: String!, $url: String!, $filter: String) {
    registerWebhookSubscription(workspaceId: $workspaceId, eventKey: $eventKey, url: $url, filter: $filter) {
      subscriptionId secret
    }
  }`

export const ROTATE_WEBHOOK_MUTATION = /* GraphQL */ `
  mutation RotateWebhookSecret($workspaceId: ID!, $subscriptionId: ID!) {
    rotateWebhookSecret(workspaceId: $workspaceId, subscriptionId: $subscriptionId) { subscriptionId secret }
  }`

export const SET_WEBHOOK_ACTIVE_MUTATION = /* GraphQL */ `
  mutation SetWebhookActive($workspaceId: ID!, $subscriptionId: ID!, $active: Boolean!) {
    setWebhookActive(workspaceId: $workspaceId, subscriptionId: $subscriptionId, active: $active) {
      id active updated_at
    }
  }`

export const SET_WEBHOOK_FILTER_MUTATION = /* GraphQL */ `
  mutation SetWebhookFilter($workspaceId: ID!, $subscriptionId: ID!, $filter: String!) {
    setWebhookFilter(workspaceId: $workspaceId, subscriptionId: $subscriptionId, filter: $filter) {
      id filter updated_at
    }
  }`

export const REPLAY_DEAD_WORKFLOW_JOBS_MUTATION = /* GraphQL */ `
  mutation ReplayDeadWorkflowJobs { replayDeadWorkflowJobs { replayed } }`

