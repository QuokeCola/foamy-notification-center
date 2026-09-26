import QtQuick
import Quickshell
import Quickshell.Io
import "." as Plugin
import "Model.js" as Model

// The archive, mounted once for the shell.
//
// Omarchy builds a bar per monitor. If the watcher and the in-memory list
// lived on the widget, each screen would have its own lastSeen and its own
// entries, and marking read or clearing on one would leave the other as it
// was. The on-disk store is already shared; this is the QML owner of the
// processes that talk to it.
Item {
  id: root
  width: 0
  height: 0
  visible: false

  property var shell: null
  property var manifest: null
  property var pluginRegistry: null
  property var barWidgetRegistry: null
  property string omarchyPath: ""

  property int keepDays: 30
  property int maxItems: 1000
  property bool showPreview: true
  property int pageSize: 500

  property var entries: []
  // Keep removals authoritative while watcher events and older reads drain.
  // The disk store retains the same tombstones across shell restarts.
  property var removedKeys: ({})
  property double lastSeen: 0
  property bool loaded: false
  property string removalError: ""
  property var pendingRemovalKeys: []
  property var activeRemovalKeys: []

  readonly property bool watching: watchProc.running

  readonly property var unreadState: Model.unreadState(entries, lastSeen)
  readonly property int unread: unreadState.unread
  readonly property bool hasCriticalUnread: unreadState.hasCriticalUnread

  readonly property string script:
    Qt.resolvedUrl("bin/notification-center").toString().replace(/^file:\/\//, "")

  readonly property var storeEnvironment: ({
    "NC_KEEP_DAYS": String(root.keepDays),
    "NC_MAX_ITEMS": String(root.maxItems),
    "NC_PREVIEWS": root.showPreview ? "1" : "0"
  })

  signal entryAdded(var entry)
  signal entriesReset()

  function storeCommand(args) {
    return [root.script].concat(args)
  }

  function differsFrom(data) {
    if (data.length !== entries.length) return true
    if (data.length === 0) return false
    return String(data[0].key) !== String(entries[0].key)
  }

  function load() {
    if (listProc.running) return
    listProc.command = root.storeCommand(["list", String(root.pageSize)])
    listProc.running = true
  }

  function readSeen() {
    if (seenProc.running) return
    seenProc.command = root.storeCommand(["seen"])
    seenProc.running = true
  }

  function markSeen() {
    var stamp = Date.now()
    root.lastSeen = stamp
    if (markProc.running) return
    markProc.command = root.storeCommand(["seen", String(stamp)])
    markProc.running = true
  }

  function remove(key) {
    removeMany([key])
  }

  function removeMany(keys) {
    var queued = pendingRemovalKeys.slice()
    for (var i = 0; i < keys.length; i++) {
      var key = String(keys[i] || "")
      if (!key || removedKeys[key]) continue
      removedKeys[key] = true
      queued.push(key)
    }
    if (queued.length === pendingRemovalKeys.length) return
    // Capture exact keys before watcher updates; later arrivals from the same app survive.
    pendingRemovalKeys = queued
    entries = visibleEntries(entries)
    entriesReset()
    startRemoval()
  }

  function startRemoval() {
    if (removeProc.running || pendingRemovalKeys.length === 0) return
    activeRemovalKeys = pendingRemovalKeys
    pendingRemovalKeys = []
    removalError = ""
    removeProc.command = storeCommand(["remove"].concat(activeRemovalKeys))
    removeProc.running = true
  }

  Process {
    id: removeProc
    stderr: StdioCollector { id: removeErrors }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0 || exitStatus !== 0) {
        // Release failed tombstones so a reload can restore entries for a retry.
        for (var i = 0; i < root.activeRemovalKeys.length; i++)
          delete root.removedKeys[root.activeRemovalKeys[i]]
        root.removalError = "Could not dismiss notifications. Try again."
        console.warn("Notification dismissal failed:", removeErrors.text)
        root.load()
      }
      root.activeRemovalKeys = []
      root.startRemoval()
    }
  }

  // Ordinary plugins use the public IPC commands, not the bar-only service proxy.
  property bool doNotDisturb: false
  property bool dndKnown: false
  property string dndError: ""
  readonly property bool dndBusy: dndProc.running

  function refreshDnd() {
    if (dndProc.running) { dndRefresh.restart(); return }
    dndProc.command = ["omarchy-shell", "notifications", "dndState"]
    dndProc.running = true
  }

  function toggleDnd() {
    if (dndProc.running) return
    // Toggle in the daemon so a concurrent external change cannot invert stale UI state.
    dndProc.command = ["omarchy-shell", "notifications", "toggleDnd"]
    dndProc.running = true
  }

  function applyDndResult(exitCode, exitStatus, output) {
    var state = String(output || "").trim()
    if (exitCode === 0 && exitStatus === 0 && (state === "on" || state === "off")) {
      doNotDisturb = state === "on"
      dndKnown = true
      dndError = ""
      return
    }
    dndError = "Could not update notification silencing. Try again."
    console.warn("Notification silencing command failed:", exitCode, exitStatus)
  }

  Process {
    id: dndProc
    stdout: StdioCollector { id: dndOutput }
    stderr: StdioCollector {}
    onExited: function(exitCode, exitStatus) { root.applyDndResult(exitCode, exitStatus, dndOutput.text) }
  }

  Timer { id: dndRefresh; interval: 200; onTriggered: root.refreshDnd() }
  FileView {
    // The stock daemon persists DND here; changes from shortcuts or IPC must update every panel.
    path: Quickshell.env("HOME") + "/.local/state/omarchy/notifications.json"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: dndRefresh.restart()
    onLoadFailed: dndRefresh.restart()
  }

  // Detached, like remove and seed above it: a clear that arrives while the
  // previous one is still running used to return early and never happen, so
  // the list came back on the next sync and the button looked broken.
  function clearAll() {
    entries = []
    entriesReset()
    Quickshell.execDetached(root.storeCommand(["clear"]))
  }

  function absorb(line) {
    var entry
    try {
      entry = JSON.parse(line)
    } catch (e) {
      return
    }
    if (!entry || !entry.key) return
    if (removedKeys[String(entry.key)]) return
    // close_write and moved_to both fire for one popup; the second is dropped
    // by key. One watcher for the shell, so this is no longer a per-screen race.
    for (var i = 0; i < entries.length; i++)
      if (entries[i].key === entry.key) return

    var next = [entry].concat(entries)
    if (next.length > pageSize) next = next.slice(0, pageSize)
    entries = next
    entryAdded(entry)
  }

  function visibleEntries(data) {
    return data.filter(function(entry) {
      return !root.removedKeys[String(entry.key)]
    })
  }

  Process {
    id: watchProc
    command: root.storeCommand(["watch"])
    environment: root.storeEnvironment
    running: true
    stdout: SplitParser {
      onRead: function(line) { root.absorb(line) }
    }
    onExited: restartWatch.restart()
  }

  Timer {
    id: restartWatch
    interval: 30000
    onTriggered: if (!watchProc.running) watchProc.running = true
  }

  Timer {
    interval: 10000
    running: true
    repeat: true
    onTriggered: root.load()
  }

  Process {
    id: listProc
    environment: root.storeEnvironment
    stdout: StdioCollector {
      onStreamFinished: {
        var data
        try {
          data = JSON.parse(text)
        } catch (e) {
          return
        }
        if (!Array.isArray(data)) return
        data = root.visibleEntries(data)
        var wasLoaded = root.loaded
        root.loaded = true
        if (wasLoaded && !root.differsFrom(data)) return
        root.entries = data
        root.entriesReset()
      }
    }
  }

  Process {
    id: seenProc
    environment: root.storeEnvironment
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          var data = JSON.parse(text)
          if (data.ok === true) root.lastSeen = Number(data.seen) || 0
        } catch (e) {
        }
      }
    }
  }

  Process { id: markProc; environment: root.storeEnvironment }

  Component.onCompleted: {
    Plugin.ServiceRegistry.instance = root
    readSeen()
    load()
    dndRefresh.restart()
  }

  Component.onDestruction: {
    // A retiring service must not clear its replacement during a reload.
    if (Plugin.ServiceRegistry.instance === root) Plugin.ServiceRegistry.instance = null
  }

  IpcHandler {
    target: "foamy.notification-center.test"

    function seed(count: int): string {
      Quickshell.execDetached(root.storeCommand(["seed", String(count > 0 ? count : 25)]))
      reloadAfterSeed.restart()
      return "seeding " + count
    }

    function clear(): string {
      root.clearAll()
      return "cleared"
    }

    function reload(): string {
      root.load()
      return "reloading"
    }

    function state(): string {
      return JSON.stringify({
        entries: root.entries.length,
        newest: root.entries.length > 0 ? root.entries[0].summary : "",
        unread: root.unread,
        hasCriticalUnread: root.hasCriticalUnread,
        watching: watchProc.running,
        loaded: root.loaded,
        lastSeen: root.lastSeen,
        doNotDisturb: root.doNotDisturb,
        dndKnown: root.dndKnown,
        dndBusy: root.dndBusy,
        dndError: root.dndError
      })
    }
  }

  Timer {
    id: reloadAfterSeed
    interval: 600
    onTriggered: root.load()
  }
}
