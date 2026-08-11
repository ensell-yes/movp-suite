import {
  canonicalUrl,
  generateJsonLd,
  renderDocToHtml,
  type DeliveryRoute,
} from '@movp/delivery'
import {
  createDeliveryAssignmentKey,
  getPublishedBySlug,
  isDeliveryAssignmentKey,
  parseDeclaredPublishedRichText,
  type DeliveryExperimentAssignmentErrorCode,
  type DeliveryPublicEnv,
} from './delivery.ts'
import {
  deliveryFailureStatus,
  type DeliveryObservation,
} from './delivery-observability.ts'

export const DELIVERY_PAGE_CACHE_SUCCESS = 'public, s-maxage=60'
export const DELIVERY_PAGE_CACHE_FAILURE = 'no-store'

export type DeliveryPageServerEnv = DeliveryPublicEnv & Readonly<{
  publicSiteUrl: string
}>

export type DeliveryPageResult = Readonly<{
  title: string
  description: string | null
  canonical: string | null
  safeGeneratedHtml: string
  plainFields: ReadonlyArray<readonly [string, string | number | boolean]>
  state: 'found' | 'not_found' | 'error'
  errorStatus: number
  assignmentCookieValue: string | null
  cacheControl: string
  observation: DeliveryObservation
}>

export type DeliveryPageInput = Readonly<{
  contentType: string
  slug: string
  storedAssignmentKey: string | undefined
  signingKey: string | null
  serverEnv: DeliveryPageServerEnv
  requestId: string
  startedAt: number
}>

export async function resolveDeliveryPage(input: DeliveryPageInput): Promise<DeliveryPageResult> {
  const cookieAssignmentKey = isDeliveryAssignmentKey(input.storedAssignmentKey)
    ? input.storedAssignmentKey
    : null
  let assignmentKey: string | null = cookieAssignmentKey
  const persistAssignment = cookieAssignmentKey !== null
  const shouldStoreAssignmentCookie = !persistAssignment

  if (assignmentKey === null && input.signingKey !== null) {
    assignmentKey = await createDeliveryAssignmentKey(input.serverEnv.workspaceId, input.signingKey)
  }

  const result = await getPublishedBySlug(
    {
      workspaceId: input.serverEnv.workspaceId,
      supabaseUrl: input.serverEnv.supabaseUrl,
      supabaseAnonKey: input.serverEnv.supabaseAnonKey,
    },
    input.contentType,
    input.slug,
    { assignmentKey, persistAssignment },
  )

  if (result.status === 'not_found') {
    return {
      title: 'Not found',
      description: null,
      canonical: null,
      safeGeneratedHtml: '',
      plainFields: [],
      state: 'not_found',
      errorStatus: 404,
      assignmentCookieValue: null,
      cacheControl: DELIVERY_PAGE_CACHE_FAILURE,
      observation: {
        event: 'delivery.public_read',
        routeKind: 'page',
        outcome: 'not_found',
        workspaceId: input.serverEnv.workspaceId,
        requestId: input.requestId,
        startedAt: input.startedAt,
        experimentActive: false,
        experimentVariantServed: false,
      },
    }
  }

  if (result.status === 'error') {
    return {
      title: 'Not found',
      description: null,
      canonical: null,
      safeGeneratedHtml: '',
      plainFields: [],
      state: 'error',
      errorStatus: deliveryFailureStatus(result.code),
      assignmentCookieValue: null,
      cacheControl: DELIVERY_PAGE_CACHE_FAILURE,
      observation: {
        event: 'delivery.public_read',
        routeKind: 'page',
        outcome: 'error',
        errorCode: result.code,
        workspaceId: input.serverEnv.workspaceId,
        requestId: input.requestId,
        startedAt: input.startedAt,
        experimentActive: false,
        experimentVariantServed: false,
      },
    }
  }

  const item = result.value
  const experimentActive = item.experimentActive
  const experimentVariantServed = item.experiment !== null
  let experimentAssignmentErrorCode: DeliveryExperimentAssignmentErrorCode | undefined =
    item.experimentAssignmentErrorCode ?? undefined
  if (experimentActive && shouldStoreAssignmentCookie && input.signingKey === null) {
    experimentAssignmentErrorCode = 'delivery_experiment_assignment_unsigned'
  }

  const route: DeliveryRoute = {
    contentType: item.contentType,
    slug: item.slug,
    publishedAt: item.publishedAt,
  }
  const canonical = canonicalUrl(input.serverEnv.publicSiteUrl, route)
  const meta = typeof item.meta === 'object' && item.meta !== null && !Array.isArray(item.meta)
    ? item.meta as Record<string, unknown>
    : {}
  const storedTitle = item.data.title
  const title = typeof meta.title === 'string' && meta.title.length <= 512
    ? meta.title
    : typeof storedTitle === 'string' && storedTitle.length <= 512
      ? storedTitle
      : item.slug
  const description = typeof meta.description === 'string' && meta.description.length <= 2_048
    ? meta.description
    : null

  const renderedFields: string[] = []
  const visiblePlainFields: Array<readonly [string, string | number | boolean]> = []
  for (const [fieldKey, value] of Object.entries(item.data)) {
    const doc = parseDeclaredPublishedRichText(value, fieldKey, item.richTextFieldKeys)
    if (doc !== null) {
      renderedFields.push(renderDocToHtml(doc, {
        bind: { itemId: item.itemId, fieldKey },
      }))
    } else if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      visiblePlainFields.push([fieldKey, value])
    }
  }
  if (item.jsonld !== null) {
    renderedFields.push(`<script type="application/ld+json">${generateJsonLd(item.jsonld)}</script>`)
  }

  return {
    title,
    description,
    canonical,
    safeGeneratedHtml: renderedFields.join(''),
    plainFields: visiblePlainFields,
    state: 'found',
    errorStatus: 500,
    assignmentCookieValue:
      experimentActive && shouldStoreAssignmentCookie && assignmentKey !== null ? assignmentKey : null,
    cacheControl: experimentActive ? DELIVERY_PAGE_CACHE_FAILURE : DELIVERY_PAGE_CACHE_SUCCESS,
    observation: {
      event: 'delivery.public_read',
      routeKind: 'page',
      outcome: 'found',
      workspaceId: input.serverEnv.workspaceId,
      requestId: input.requestId,
      startedAt: input.startedAt,
      experimentActive,
      experimentVariantServed,
      ...(experimentAssignmentErrorCode === undefined
        ? {}
        : { experimentAssignmentErrorCode }),
    },
  }
}
