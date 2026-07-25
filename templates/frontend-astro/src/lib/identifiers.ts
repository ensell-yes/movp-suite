export const UUID_PATTERN_SOURCE =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

export const UUID_PATTERN = new RegExp(UUID_PATTERN_SOURCE, 'i')
