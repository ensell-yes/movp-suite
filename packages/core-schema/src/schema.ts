import { comment } from './collections/comment.ts'
import { contentApproval } from './collections/content_approval.ts'
import { contentApprovalVote } from './collections/content_approval_vote.ts'
import { contentItem } from './collections/content_item.ts'
import { contentPublishEvent } from './collections/content_publish_event.ts'
import { contentRevision } from './collections/content_revision.ts'
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
])
