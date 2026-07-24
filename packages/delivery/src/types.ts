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
