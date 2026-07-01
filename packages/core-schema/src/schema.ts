import { comment } from './collections/comment.ts'
import { mention } from './collections/mention.ts'
import { note } from './collections/note.ts'
import { reaction } from './collections/reaction.ts'
import { savedItem } from './collections/saved_item.ts'
import { shareLink } from './collections/share_link.ts'
import { tag } from './collections/tag.ts'
import { defineSchema } from './define.ts'

export const schema = defineSchema([note, tag, comment, reaction, savedItem, mention, shareLink])
