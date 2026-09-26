const assert = require("node:assert/strict")
const Model = require("../Model.js")

assert.deepEqual(Model.unreadState([
  { timestamp: 300, urgency: 1 },
  { timestamp: 200, urgency: 0 },
  { timestamp: 100, urgency: 2 }
], 150), {
  unread: 2,
  hasCriticalUnread: false
})

assert.deepEqual(Model.unreadState([
  { timestamp: 300, urgency: 1 },
  { timestamp: 200, urgency: 2 },
  { timestamp: 100, urgency: 1 }
], 150), {
  unread: 2,
  hasCriticalUnread: true
})

assert.deepEqual(Model.unreadState([], 0), {
  unread: 0,
  hasCriticalUnread: false
})

assert.deepEqual(Model.unreadState(null, "invalid"), {
  unread: 0,
  hasCriticalUnread: false
})

console.log("Notification center model tests passed.")
