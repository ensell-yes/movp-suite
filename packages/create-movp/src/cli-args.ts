export const TEMPLATES = ['crm-lite', 'marketing-site', 'support-desk', 'knowledge-base'] as const
export type TemplateName = (typeof TEMPLATES)[number]

export const DEFAULT_WORKSPACE_ID = '33333333-3333-3333-3333-333333333333'
export const MAX_CREATE_INPUT_BYTES = 4 * 1024
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CreateCliArgs = {
  template: TemplateName
  projectName?: string
  workspaceId: string
}

export function validateWorkspaceId(value: string): string {
  const workspaceId = value.trim()
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new Error('invalid_workspace_id: expected UUID format')
  }
  return workspaceId
}

export function parseCreateCliArgs(args: string[]): CreateCliArgs {
  let template: TemplateName = 'crm-lite'
  let projectName: string | undefined
  let workspaceId = DEFAULT_WORKSPACE_ID

  const valueAfter = (index: number, flag: string): string => {
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing_option_value: ${flag}`)
    return value
  }

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag.startsWith('--')) {
      if (projectName !== undefined) throw new Error(`unexpected_argument: ${flag}`)
      projectName = flag
      continue
    }
    if (flag === '--template') {
      const value = valueAfter(index, flag)
      if (!TEMPLATES.includes(value as TemplateName)) throw new Error(`unknown_template: ${value}`)
      template = value as TemplateName
      index += 1
      continue
    }
    if (flag === '--project-name') {
      projectName = valueAfter(index, flag)
      index += 1
      continue
    }
    if (flag === '--workspace-id') {
      workspaceId = valueAfter(index, flag)
      index += 1
      continue
    }
    throw new Error(`unknown_option: ${flag}`)
  }
  return { template, projectName, workspaceId: validateWorkspaceId(workspaceId) }
}

export function parseCreateInput(input: string): CreateCliArgs {
  if (Buffer.byteLength(input, 'utf8') > MAX_CREATE_INPUT_BYTES) {
    throw new Error(`create_input_too_large: max ${MAX_CREATE_INPUT_BYTES} bytes`)
  }
  const [template = '', projectName = '', workspaceId = '', ...extra] = input.split(/\r?\n/)
  if (extra.some((line) => line.trim() !== '')) throw new Error('unexpected_create_input')
  if (projectName.trim() === '') throw new Error('missing_project_name')
  return parseCreateCliArgs([
    '--template', template.trim() || 'crm-lite',
    '--project-name', projectName.trim(),
    '--workspace-id', workspaceId.trim() || DEFAULT_WORKSPACE_ID,
  ])
}
