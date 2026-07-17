// The §5.2 canonical algorithm now lives in @movp/richtext so the editor (encode) and the domain
// (normalize-on-write) share one byte-stable implementation. Re-exported for back-compat.
export { canonicalizeInnerJson } from '@movp/richtext'
