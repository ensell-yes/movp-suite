import type { MovpSchema } from '@movp/core-schema'
import type { CampaignCreate, CampaignRow, CampaignUpdate } from './generated/types.ts'
import { makeAdminService } from './admin.ts'
import { makeCampaignService } from './campaign.ts'
import { makeCollabService } from './collab.ts'
import { makeCollectionService } from './collection.ts'
import { makeContentService } from './content.ts'
import { makeGraphService } from './graph.ts'
import { makePatService } from './pat.ts'
import { makeReportingService } from './reporting.ts'
import { runSearch } from './search.ts'
import { makeTaskService } from './task.ts'
import type { CollectionService, Domain, DomainCtx, EmbeddingProvider } from './types.ts'
import { makeWorkflowService } from './workflows.ts'

type GenericRow = { id: string } & Record<string, unknown>
type GenericService = CollectionService<GenericRow, Record<string, unknown>, Record<string, unknown>>

export function createDomain(ctx: DomainCtx, opts: { schema: MovpSchema; embedder?: EmbeddingProvider }): Domain {
  const campaign = Object.assign(
    makeCollectionService<CampaignRow, CampaignCreate, CampaignUpdate>(ctx, { table: 'campaign' }),
    makeCampaignService(ctx),
  )
  const generic = new Map<string, GenericService>()

  for (const collection of opts.schema.collections) {
    if (collection.internal === true || collection.name === 'campaign') continue
    generic.set(
      collection.name,
      makeCollectionService<GenericRow, Record<string, unknown>, Record<string, unknown>>(ctx, {
        table: collection.name,
        workspaceScoped: collection.workspaceScoped,
      }),
    )
  }

  return {
    collection(name: string): GenericService {
      if (name === 'campaign') return campaign as unknown as GenericService
      const service = generic.get(name)
      if (!service) throw new Error(`no domain service for collection: ${name}`)
      return service
    },
    task: makeTaskService(ctx),
    content: makeContentService(ctx),
    search: (args) => runSearch(ctx, opts.embedder, args),
    graph: makeGraphService(ctx),
    collab: makeCollabService(ctx),
    campaign,
    workflows: makeWorkflowService(ctx),
    admin: makeAdminService(ctx),
    pat: makePatService(ctx),
    reporting: makeReportingService(ctx),
  }
}
