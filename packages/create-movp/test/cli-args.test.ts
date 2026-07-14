import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_ID,
  MAX_CREATE_INPUT_BYTES,
  parseCreateCliArgs,
  parseCreateInput,
} from '../src/cli-args.ts'

describe('parseCreateCliArgs', () => {
  it('keeps interactive defaults when no flags are supplied', () => {
    expect(parseCreateCliArgs([])).toEqual({
      template: 'crm-lite',
      projectName: undefined,
      workspaceId: DEFAULT_WORKSPACE_ID,
    })
  })

  it('accepts a complete non-interactive scaffold request', () => {
    expect(parseCreateCliArgs([
      '--template', 'crm-lite',
      '--project-name', 'acme-crm',
      '--workspace-id', '33333333-3333-3333-3333-333333333333',
    ])).toEqual({
      template: 'crm-lite',
      projectName: 'acme-crm',
      workspaceId: '33333333-3333-3333-3333-333333333333',
    })
  })

  it('accepts the npm-create positional project-name convention', () => {
    expect(parseCreateCliArgs([
      'acme-crm',
      '--template', 'crm-lite',
      '--workspace-id', '33333333-3333-3333-3333-333333333333',
    ])).toMatchObject({ projectName: 'acme-crm', template: 'crm-lite' })
  })

  it('rejects an unknown template', () => {
    expect(() => parseCreateCliArgs(['--template', 'unknown'])).toThrow(/unknown_template/)
  })

  it('rejects a missing option value', () => {
    expect(() => parseCreateCliArgs(['--project-name'])).toThrow(/missing_option_value/)
  })

  it('rejects unknown options instead of silently ignoring them', () => {
    expect(() => parseCreateCliArgs(['--name', 'acme'])).toThrow(/unknown_option/)
  })

  it('rejects more than one positional project name', () => {
    expect(() => parseCreateCliArgs(['acme', 'other'])).toThrow(/unexpected_argument/)
  })
})

describe('parseCreateInput', () => {
  it('parses all piped answers without sequential readline buffering', () => {
    expect(parseCreateInput(
      'crm-lite\nacme-crm\n33333333-3333-3333-3333-333333333333\n',
    )).toEqual({
      template: 'crm-lite',
      projectName: 'acme-crm',
      workspaceId: '33333333-3333-3333-3333-333333333333',
    })
  })

  it('applies defaults to blank optional answers', () => {
    expect(parseCreateInput('\nacme-crm\n\n')).toEqual({
      template: 'crm-lite',
      projectName: 'acme-crm',
      workspaceId: DEFAULT_WORKSPACE_ID,
    })
  })

  it('rejects missing, extra, and oversized input', () => {
    expect(() => parseCreateInput('crm-lite\n\n')).toThrow(/missing_project_name/)
    expect(() => parseCreateInput('crm-lite\nacme\n\nextra')).toThrow(/unexpected_create_input/)
    expect(() => parseCreateInput('x'.repeat(MAX_CREATE_INPUT_BYTES + 1))).toThrow(
      /create_input_too_large/,
    )
  })
})
