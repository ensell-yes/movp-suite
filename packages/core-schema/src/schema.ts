import { note } from './collections/note.ts'
import { tag } from './collections/tag.ts'
import { defineSchema } from './define.ts'

export const schema = defineSchema([note, tag])
