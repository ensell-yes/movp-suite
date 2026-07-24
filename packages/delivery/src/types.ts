export type DeliveryBinding = Readonly<{
  itemId: string
  fieldKey: string
}>

export type RenderOptions = Readonly<{
  bind?: DeliveryBinding
}>

export type DeliveryRenderErrorCode =
  | 'delivery_render_binding_invalid'
  | 'delivery_render_depth_exceeded'
  | 'delivery_render_invalid_document'
  | 'delivery_render_invalid_nesting'
  | 'delivery_render_node_limit_exceeded'
  | 'delivery_render_text_limit_exceeded'
  | 'delivery_render_unknown_attribute'
  | 'delivery_render_unknown_mark'
  | 'delivery_render_unknown_node'

export class DeliveryRenderError extends Error {
  readonly code: DeliveryRenderErrorCode

  constructor(code: DeliveryRenderErrorCode) {
    super(code)
    this.name = 'DeliveryRenderError'
    this.code = code
  }
}

export type DeliveryRoute = Readonly<{
  contentType: string
  slug: string
  title?: string
  publishedAt?: string
}>

export type DeliveryArtifactErrorCode =
  | 'delivery_jsonld_invalid'
  | 'delivery_jsonld_too_large'
  | 'delivery_llms_invalid'
  | 'delivery_origin_invalid'
  | 'delivery_route_invalid'
  | 'delivery_shard_invalid'
  | 'delivery_sitemap_byte_limit'
  | 'delivery_sitemap_duplicate'
  | 'delivery_sitemap_index_limit'
  | 'delivery_sitemap_url_invalid'
  | 'delivery_sitemap_url_limit'

export class DeliveryArtifactError extends Error {
  readonly code: DeliveryArtifactErrorCode

  constructor(code: DeliveryArtifactErrorCode) {
    super(code)
    this.name = 'DeliveryArtifactError'
    this.code = code
  }
}
