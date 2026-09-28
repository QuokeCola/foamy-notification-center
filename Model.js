var CRITICAL_URGENCY = 2

// Match the stock toast's execArgv validation. Arguments stay data; legacy
// shell-command strings are not converted into executable actions.
function parseExecArgv(value) {
  if (typeof value !== "string" || !value) return null
  var argv
  try {
    argv = JSON.parse(value)
  } catch (e) {
    return null
  }
  if (!Array.isArray(argv) || argv.length === 0) return null
  for (var i = 0; i < argv.length; i++) {
    if (typeof argv[i] !== "string") return null
  }
  if (!argv[0] || argv[0].charAt(0) === "-") return null
  return argv
}

function unreadState(entries, lastSeen) {
  var rows = Array.isArray(entries) ? entries : []
  var boundary = Number(lastSeen)
  if (!isFinite(boundary)) boundary = 0

  var unread = 0
  var hasCriticalUnread = false

  // Entries are newest first. Stop at the read boundary so an older critical
  // notification cannot keep the current badge red.
  for (var i = 0; i < rows.length; i++) {
    var entry = rows[i] || {}
    var timestamp = Number(entry.timestamp)
    if (!isFinite(timestamp)) continue
    if (timestamp <= boundary) break

    unread++
    if (Number(entry.urgency) === CRITICAL_URGENCY)
      hasCriticalUnread = true
  }

  return {
    unread: unread,
    hasCriticalUnread: hasCriticalUnread
  }
}

function relativeTime(timestamp, now) {
  var minutes = Math.floor(Math.max(0, now - timestamp) / 60000)
  if (minutes < 1) return "now"
  if (minutes < 60) return minutes + "m ago"
  if (minutes < 1440) return Math.floor(minutes / 60) + "h ago"
  return Math.floor(minutes / 1440) + "d ago"
}

function groupsFor(entries, filter) {
  var needle = String(filter || "").toLowerCase()
  var byApp = Object.create(null)
  var seen = Object.create(null)
  var groups = []
  var sorted = (Array.isArray(entries) ? entries : []).filter(function(entry) {
    return entry && entry.key
  }).sort(function(a, b) {
    return Number(b.timestamp || 0) - Number(a.timestamp || 0)
  })
  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i]
    if (!entry || !entry.key || seen[entry.key]) continue
    seen[entry.key] = true
    var app = String(entry.app || "Unknown app")
    if (needle && [app, entry.summary || "", entry.body || ""].join(" ").toLowerCase().indexOf(needle) < 0) continue
    var group = byApp[app]
    if (!group) {
      group = { key: app, app: app, appIcon: "", glyph: "", timestamp: Number(entry.timestamp || 0), critical: false, entries: [] }
      byApp[app] = group
      groups.push(group)
    }
    // Archived image fields can be avatars; only appIcon identifies the app.
    if (!group.appIcon && entry.appIcon) group.appIcon = String(entry.appIcon)
    if (!group.glyph && entry.glyph) group.glyph = String(entry.glyph)
    group.critical = group.critical || Number(entry.urgency) === CRITICAL_URGENCY
    group.entries.push(entry)
  }
  return groups
}

function stackRows(entries, expanded, filter) {
  var groups = groupsFor(entries, filter)
  var rows = []
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i]
    var multiple = group.entries.length > 1
    var open = multiple && (Boolean(filter) || expanded[group.key] === true)
    rows.push({ id: "group:" + group.key, kind: "header", group: group, expanded: open })
    var visible = open ? group.entries : group.entries.slice(0, 1)
    // Flatten stacks so ListView virtualizes individual messages even in large groups.
    for (var j = 0; j < visible.length; j++) {
      rows.push({ id: "entry:" + visible[j].key, kind: "message", group: group,
        entry: visible[j], expanded: open, first: j === 0, last: j === visible.length - 1,
        layered: multiple && !open })
    }
  }
  return rows
}

if (typeof module !== "undefined") {
  module.exports = {
    parseExecArgv: parseExecArgv,
    CRITICAL_URGENCY: CRITICAL_URGENCY,
    unreadState: unreadState,
    relativeTime: relativeTime,
    groupsFor: groupsFor,
    stackRows: stackRows
  }
}
