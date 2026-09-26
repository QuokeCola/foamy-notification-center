import QtQuick
import qs.Commons

// Separate list rows share one card outline while remaining independently virtualized.
Canvas {
  id: root
  property bool first: false
  property bool last: false
  property bool critical: false
  property color fill: Color.popups.background
  property color foreground: Color.foreground
  readonly property color outline: Util.alpha(foreground, 0.18)
  readonly property color urgent: Color.urgent
  readonly property real corner: Style.space(10)
  readonly property real leading: critical ? Style.space(3) : 1

  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()
  onFirstChanged: requestPaint()
  onLastChanged: requestPaint()
  onCriticalChanged: requestPaint()
  onFillChanged: requestPaint()
  onOutlineChanged: requestPaint()
  onUrgentChanged: requestPaint()
  onCornerChanged: requestPaint()

  onPaint: {
    var c = getContext("2d")
    c.reset()
    function shape(x, y, w, h, tl, tr, br, bl) {
      c.beginPath()
      c.moveTo(x + tl, y)
      c.lineTo(x + w - tr, y)
      c.quadraticCurveTo(x + w, y, x + w, y + tr)
      c.lineTo(x + w, y + h - br)
      c.quadraticCurveTo(x + w, y + h, x + w - br, y + h)
      c.lineTo(x + bl, y + h)
      c.quadraticCurveTo(x, y + h, x, y + h - bl)
      c.lineTo(x, y + tl)
      c.quadraticCurveTo(x, y, x + tl, y)
      c.closePath()
    }
    var top = root.first ? root.corner : 0
    var bottom = root.last ? root.corner : 0
    shape(0, 0, width, height, top, top, bottom, bottom)
    c.fillStyle = root.outline
    c.fill()
    if (root.critical) {
      c.save()
      c.clip()
      c.fillStyle = root.urgent
      c.fillRect(0, 0, root.leading, height)
      c.restore()
    }
    var y = root.first ? 1 : 0
    var h = height - y - (root.last ? 1 : 0)
    shape(root.leading, y, width - root.leading - 1, h,
          Math.max(0, top - root.leading), Math.max(0, top - 1),
          Math.max(0, bottom - 1), Math.max(0, bottom - root.leading))
    c.fillStyle = root.fill
    c.fill()
  }
}
