import type {
  CampaignCalendarEventCreate,
  CampaignCalendarEventRow,
  CampaignCalendarEventUpdate,
  CampaignChannelCreate,
  CampaignChannelRow,
  CampaignChannelUpdate,
  CampaignCreate,
  CampaignDeliverableCreate,
  CampaignDeliverableRow,
  CampaignDeliverableUpdate,
  CampaignMetricCreate,
  CampaignMetricRow,
  CampaignMetricUpdate,
  CampaignRow,
  CampaignSegmentCreate,
  CampaignSegmentRow,
  CampaignSegmentUpdate,
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
  TaskStatusOptionCreate,
  TaskStatusOptionRow,
  TaskStatusOptionUpdate,
} from './generated/types.ts'
import { makeCampaignService } from './campaign.ts'
import { makeCollabService } from './collab.ts'
import { makeCollectionService } from './collection.ts'
import { makeContentService } from './content.ts'
import { makeGraphService } from './graph.ts'
import { runSearch } from './search.ts'
import { makeTaskService } from './task.ts'
import type { Domain, DomainCtx, EmbeddingProvider } from './types.ts'

export function createDomain(ctx: DomainCtx, opts: { embedder?: EmbeddingProvider } = {}): Domain {
  return {
    note: makeCollectionService<NoteRow, NoteCreate, NoteUpdate>(ctx, { table: 'note' }),
    tag: makeCollectionService<TagRow, TagCreate, TagUpdate>(ctx, { table: 'tag' }),
    marketing_plan: makeCollectionService<MarketingPlanRow, MarketingPlanCreate, MarketingPlanUpdate>(ctx, { table: 'marketing_plan' }),
    task_status_option: makeCollectionService<TaskStatusOptionRow, TaskStatusOptionCreate, TaskStatusOptionUpdate>(ctx, { table: 'task_status_option' }),
    task_priority_option: makeCollectionService<TaskPriorityOptionRow, TaskPriorityOptionCreate, TaskPriorityOptionUpdate>(ctx, { table: 'task_priority_option' }),
    campaign_channel: makeCollectionService<CampaignChannelRow, CampaignChannelCreate, CampaignChannelUpdate>(ctx, { table: 'campaign_channel' }),
    campaign_deliverable: makeCollectionService<CampaignDeliverableRow, CampaignDeliverableCreate, CampaignDeliverableUpdate>(ctx, { table: 'campaign_deliverable' }),
    campaign_calendar_event: makeCollectionService<CampaignCalendarEventRow, CampaignCalendarEventCreate, CampaignCalendarEventUpdate>(ctx, { table: 'campaign_calendar_event' }),
    campaign_metric: makeCollectionService<CampaignMetricRow, CampaignMetricCreate, CampaignMetricUpdate>(ctx, { table: 'campaign_metric' }),
    campaign_segment: makeCollectionService<CampaignSegmentRow, CampaignSegmentCreate, CampaignSegmentUpdate>(ctx, { table: 'campaign_segment' }),
    task: makeTaskService(ctx),
    content: makeContentService(ctx),
    search: (args) => runSearch(ctx, opts.embedder, args),
    graph: makeGraphService(ctx),
    collab: makeCollabService(ctx),
    campaign: Object.assign(makeCollectionService<CampaignRow, CampaignCreate, CampaignUpdate>(ctx, { table: 'campaign' }), makeCampaignService(ctx)),
  }
}
