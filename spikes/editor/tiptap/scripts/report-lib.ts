export function physicalLineCount(text: string): number {
  const content = text.trimEnd()
  return content === '' ? 0 : content.split('\n').length
}
