import { GraphQLError } from 'graphql'
import { createYoga as createYogaServer, maskError } from 'graphql-yoga'
import type { MovpSchema } from '@movp/core-schema'
import { buildSchema } from './schema.ts'
import type { GraphQLContext } from './types.ts'

export interface CreateYogaOpts {
  schema: MovpSchema
}

function maskMovpError(error: unknown, message: string, isDev?: boolean): Error {
  const candidate = typeof error === 'object' && error !== null
    ? error as { extensions?: Record<string, unknown>; path?: unknown }
    : null
  const code = candidate?.extensions?.code
  if (candidate?.extensions?.safeContentConflict === true && code === 'CONFLICT') {
    return new GraphQLError('This content was updated by someone else.', {
      path: Array.isArray(candidate.path) ? candidate.path as Array<string | number> : undefined,
      extensions: { code },
    })
  }
  if (
    candidate?.extensions?.safeReportingError === true &&
    (code === 'FORBIDDEN' || code === 'INTERNAL_SERVER_ERROR')
  ) {
    return new GraphQLError(
      code === 'FORBIDDEN'
        ? 'You do not have access to these reports.'
        : 'Could not load this report.',
      {
        path: Array.isArray(candidate.path) ? candidate.path as Array<string | number> : undefined,
        extensions: { code },
      },
    )
  }
  return maskError(error, message, isDev)
}

export function createYoga(opts: CreateYogaOpts) {
  return createYogaServer<GraphQLContext>({
    schema: buildSchema(opts.schema),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    maskedErrors: { maskError: maskMovpError },
  })
}
