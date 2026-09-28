const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const test = require("node:test")
const Model = require("../Model.js")

const panel = fs.readFileSync(path.join(__dirname, "../Panel.qml"), "utf8")
const start = panel.indexOf("  function activate(")
const activate = panel.slice(start, panel.indexOf("\n  }", start) + 4)

function view(mode = "Auto", run = () => {}) {
  const state = vm.createContext({
    clickAction: mode, Model, omarchyPath: "/omarchy", focusProc: {},
    actions: [], images: [], removed: [], closed: 0,
    Util: { execArgv(argv) { state.actions.push(argv); run(argv) } },
    Quickshell: { execDetached(argv) { state.images.push(argv) } },
    remove(key) { state.removed.push(key) }, close() { state.closed++ }
  })
  state.root = state
  vm.runInContext(activate, state)
  return state
}

test("archive to stacked body activation preserves exact arguments and runs only on click", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "notification-actions-"))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const source = path.join(temp, "source")
  fs.mkdirSync(path.join(source, "history"), { recursive: true })
  const env = { ...process.env, NC_SRC_DIR: source, NC_SRC_HISTORY: path.join(source, "history"),
    NC_STORE: path.join(temp, "store"), NC_PREVIEWS: "0" }
  const script = path.join(__dirname, "../bin/notification-center")
  const run = command => {
    const result = spawnSync(script, [command], { env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const timestamp = Date.now()
  const marker = path.join(temp, "clicked.json")
  const injected = path.join(temp, "must-not-exist")
  const urls = ["https://example.test/first", `https://example.test/a b?q=$(touch ${injected})&x=\"quoted\";*`]
  for (let i = 0; i < 2; i++) {
    const argv = [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", marker, urls[i]]
    fs.writeFileSync(path.join(i ? source : path.join(source, "history"), `${timestamp + i}-${i}.json`),
      JSON.stringify({ timestamp: timestamp + i, app: "Actions", summary: "Open link",
        execArgv: i ? JSON.stringify(argv) : argv }))
  }
  run("sync")
  run("backfill")
  const entries = run("list")
  assert.equal(entries.length, 2)
  assert.equal(fs.existsSync(marker), false)
  const state = view("Auto", argv => {
    // Exercise the toast helper's positional-argument execution contract.
    const result = spawnSync("bash", ["-lc", 'exec "$@"', "bash", ...argv], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  })
  const collapsed = Model.stackRows(entries, {}, "").filter(row => row.kind === "message")
  assert.equal(collapsed.length, 1)
  state.activate(collapsed[0].entry)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), [urls[1]])
  const expanded = Model.stackRows(entries, { Actions: true }, "").filter(row => row.kind === "message")
  state.activate(expanded[1].entry)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), [urls[0]])
  assert.deepEqual(Array.from(state.removed), [collapsed[0].entry.key, expanded[1].entry.key])
  assert.equal(state.closed, 2)
  assert.equal(fs.existsSync(injected), false)
})

test("saved action takes priority over preview and settings still override it", () => {
  const row = { key: "100-1", app: "Browser", file: "/tmp/preview.png",
    execArgv: JSON.stringify(["xdg-open", "https://example.test/"]) }
  const auto = view()
  auto.activate(row)
  assert.deepEqual(auto.actions, [["xdg-open", "https://example.test/"]])
  assert.equal(auto.images.length, 0)
  const focus = view("Focus the app")
  focus.activate(row)
  assert.equal(focus.actions.length, 0)
  assert.equal(focus.images.length, 0)
  assert.deepEqual(Array.from(focus.focusProc.command), ["/omarchy/bin/omarchy-hyprland-focus-app", "Browser"])
  const nothing = view("Nothing")
  nothing.activate(row)
  assert.equal(nothing.actions.length + nothing.images.length + nothing.removed.length, 0)
  assert.equal(nothing.closed, 0)
})

test("missing and malformed actions keep the toast-style fallback without executing legacy strings", () => {
  for (const value of [undefined, "", "bad JSON", "null", "{}", "[]", '["", "url"]',
    '["-program"]', '["xdg-open", 3]', '["xdg-open", null]', ["xdg-open", "url"]]) {
    assert.equal(Model.parseExecArgv(value), null)
    const state = view()
    state.activate({ key: "100-1", app: "Browser", file: "/tmp/preview.png", execArgv: value, exec: "touch /tmp/never-run" })
    assert.equal(state.actions.length, 0)
    assert.deepEqual(Array.from(state.images[0]), ["xdg-open", "/tmp/preview.png"])
  }
  const state = view()
  state.activate({ key: "100-1", app: "Browser" })
  assert.equal(state.focusProc.running, true)
  assert.deepEqual(Model.parseExecArgv('["bash", "-c", "echo explicit command"]'),
    ["bash", "-c", "echo explicit command"])
})
