import { comment } from './collections/comment.ts'
import { asset } from './collections/asset.ts'
import { contentApproval } from './collections/content_approval.ts'
import { contentApprovalVote } from './collections/content_approval_vote.ts'
import { contentCollection } from './collections/content_collection.ts'
import { contentCollectionEntry } from './collections/content_collection_entry.ts'
import { contentItem } from './collections/content_item.ts'
import { contentPublishEvent } from './collections/content_publish_event.ts'
import { contentRevision } from './collections/content_revision.ts'
import { contentSchedule } from './collections/content_schedule.ts'
import { contentSeo } from './collections/content_seo.ts'
import { contentType } from './collections/content_type.ts'
import { mention } from './collections/mention.ts'
import { note } from './collections/note.ts'
import { reaction } from './collections/reaction.ts'
import { savedItem } from './collections/saved_item.ts'
import { shareLink } from './collections/share_link.ts'
import { tag } from './collections/tag.ts'
import { task } from './collections/task.ts'
import { taskAssignment } from './collections/task_assignment.ts'
import { taskAttachment } from './collections/task_attachment.ts'
import { taskDependency } from './collections/task_dependency.ts'
import { taskObserver } from './collections/task_observer.ts'
import { taskPriorityOption } from './collections/task_priority_option.ts'
import { taskRevision } from './collections/task_revision.ts'
import { taskStatusHistory } from './collections/task_status_history.ts'
import { taskStatusOption } from './collections/task_status_option.ts'
import { campaign } from './collections/campaign.ts'
import { campaignCalendarEvent } from './collections/campaign_calendar_event.ts'
import { campaignChannel } from './collections/campaign_channel.ts'
import { campaignDeliverable } from './collections/campaign_deliverable.ts'
import { campaignMetric } from './collections/campaign_metric.ts'
import { campaignSegment } from './collections/campaign_segment.ts'
import { marketingPlan } from './collections/marketing_plan.ts'
import { platformEvent } from './collections/platform_event.ts'
import { segment } from './collections/segment.ts'
import { segmentMembership } from './collections/segment_membership.ts'
import { segmentRecomputeRun } from './collections/segment_recompute_run.ts'
import { segmentRule } from './collections/segment_rule.ts'
import { segmentSnapshot } from './collections/segment_snapshot.ts'
import { segmentSnapshotMember } from './collections/segment_snapshot_member.ts'
import { defineSchema } from './define.ts'

export const schema = defineSchema([
  note,
  tag,
  comment,
  reaction,
  savedItem,
  mention,
  shareLink,
  taskStatusOption,
  taskPriorityOption,
  task,
  taskRevision,
  taskAssignment,
  taskObserver,
  taskDependency,
  taskStatusHistory,
  taskAttachment,
  contentType,
  contentItem,
  contentRevision,
  contentApproval,
  contentApprovalVote,
  contentPublishEvent,
  contentSchedule,
  asset,
  contentCollection,
  contentCollectionEntry,
  contentSeo,
  // Campaigns (Phase 5, Part A). Order encodes inline-FK deps:
  //  - marketing_plan precedes campaign (campaign.marketing_plan_id -> it).
  //  - campaign precedes every campaign_* child (child.campaign_id -> campaign).
  //  - campaign + campaign_channel precede deliverable/metric (channel_id/deliverable_id).
  marketingPlan,
  campaign,
  campaignChannel,
  campaignDeliverable,
  campaignCalendarEvent,
  campaignMetric,
  campaignSegment,
  // Segmentation (Phase 6, Part A). Order encodes inline-FK deps:
  //  - platform_event has no relation (placed first among segmentation collections).
  //  - segment precedes every child (segment_rule/membership/snapshot/recompute_run -> segment_id).
  //  - segment_rule precedes segment_membership + segment_snapshot_member (matched_rule_id -> it).
  //  - segment_snapshot precedes segment_snapshot_member (snapshot_id -> it).
  platformEvent,
  segment,
  segmentRule,
  segmentMembership,
  segmentSnapshot,
  segmentSnapshotMember,
  segmentRecomputeRun,
])
