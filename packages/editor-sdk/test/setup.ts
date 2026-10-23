const emptyClientRects = () => [] as unknown as DOMRectList
const emptyBoundingClientRect = () => new DOMRect(0, 0, 0, 0)

if (typeof Element !== 'undefined' && !Element.prototype.getClientRects) {
  Element.prototype.getClientRects = emptyClientRects
}

if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = emptyClientRects
}

if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = emptyBoundingClientRect
}
