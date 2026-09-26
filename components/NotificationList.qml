import QtQuick
import QtQuick.Controls

ListView {
  id: root
  property real wheelStep: 96
  property real scrollbarWidth: 6
  property real scrollbarInset: 2

  clip: true
  boundsBehavior: Flickable.StopAtBounds
  flickableDirection: Flickable.VerticalFlick
  interactive: contentHeight > height

  function scrollBy(delta, smooth) {
    if (!delta || !interactive) return
    // Accumulate fast wheel ticks against their destination, not an unfinished frame.
    var start = wheelMotion.running ? wheelMotion.to : contentY
    wheelMotion.stop()
    var end = Math.max(originY, Math.min(originY + Math.max(0, contentHeight - height), start + delta))
    if (smooth) {
      wheelMotion.from = contentY
      wheelMotion.to = end
      wheelMotion.start()
    } else contentY = end
  }

  onDraggingChanged: if (dragging) wheelMotion.stop()

  NumberAnimation {
    id: wheelMotion
    target: root
    property: "contentY"
    duration: 120
    easing.type: Easing.OutCubic
  }

  WheelHandler {
    target: null
    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
    onWheel: function(event) {
      var pixels = event.pixelDelta.y
      var angle = event.angleDelta.y
      if (!pixels && !angle) return
      root.scrollBy(pixels ? -pixels : -angle / 120 * root.wheelStep, !pixels)
      event.accepted = true
    }
  }

  ScrollBar.vertical: ScrollBar {
    width: root.scrollbarWidth
    padding: 0
    active: root.interactive
    anchors.right: parent.right
    anchors.rightMargin: root.scrollbarInset
    policy: ScrollBar.AsNeeded
    onPressedChanged: if (pressed) wheelMotion.stop()
  }
}
