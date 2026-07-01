import { createYoga as createYogaServer } from 'graphql-yoga'
import type { MovpSchema } from '@movp/core-schema'
import { buildSchema } from './schema.ts'
import type { GraphQLContext } from './types.ts'

export interface CreateYogaOpts {
  schema: MovpSchema
}

export function createYoga(opts: CreateYogaOpts) {
  return createYogaServer<GraphQLContext>({
    schema: buildSchema(opts.schema),
    graphqlEndpoint: '/graphql',
    landingPage: false,
  })
}
