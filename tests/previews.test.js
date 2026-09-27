const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.resolve(__dirname, "../bin/notification-center");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notification-previews-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const store = path.join(root, "store");
  fs.mkdirSync(path.join(source, "history"), { recursive: true });
  const env = { ...process.env, NC_SRC_DIR: source, NC_SRC_HISTORY: path.join(source, "history"),
    NC_STORE: store, NC_PREVIEWS: "1" };
  let id = 0;
  return {
    root, source, store, env,
    image(name, ...args) {
      const file = path.join(root, name);
      const result = spawnSync("magick", [...args, file], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      return file;
    },
    send(file = "") {
      const timestamp = Date.now();
      const key = `${timestamp}-${++id}`;
      fs.writeFileSync(path.join(source, `${key}.json`), JSON.stringify({
        app: "Preview test", summary: key, timestamp, execArgv: file ? ["viewer", file] : [],
      }));
      return key;
    },
    run(command = "sync") {
      const result = spawnSync(script, [command], { env, encoding: "utf8", timeout: 12000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      return result;
    },
    entries() {
      return fs.readFileSync(path.join(store, "archive.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    },
    mockMagick(body) {
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "magick"), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
      env.PATH = `${bin}:${process.env.PATH}`;
    },
  };
}

test("real raster previews become bounded PNGs, including paths with spaces", t => {
  const f = fixture(t);
  for (const extension of ["png", "jpg", "gif", "webp"])
    f.send(f.image(`sample image.${extension}`, "-size", "1440x900", "xc:steelblue"));
  f.run();
  assert.equal(f.entries().length, 4);
  for (const entry of f.entries()) {
    assert.ok(entry.preview.startsWith("file://"));
    const result = spawnSync("magick", ["identify", "-format", "%m %wx%h %n", entry.preview.slice(7)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "PNG 720x450 1");
  }
});

test("unsupported, corrupt, oversized-dimension and over-5-MiB images leave text intact", t => {
  const f = fixture(t);
  const svg = path.join(f.root, "disguised.png");
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const corrupt = f.image("corrupt.png", "-size", "1x1", "xc:red");
  fs.truncateSync(corrupt, 40);
  const large = f.image("wide.png", "-size", "9000x1", "xc:red");
  const bigFile = f.image("big.png", "-size", "1x1", "xc:red");
  fs.truncateSync(bigFile, 5242881);
  for (const file of [svg, corrupt, large, bigFile]) f.send(file);
  const next = f.send();
  const result = f.run();
  assert.match(result.stderr, /preview_rejected/);
  assert.equal(f.entries().length, 5);
  assert.ok(f.entries().every(row => row.preview === ""));
  assert.ok(f.entries().some(row => row.key === next));
  assert.deepEqual(fs.readdirSync(path.join(f.store, "images")), []);
});

test("a failed converter cannot leave the original or a partial preview", t => {
  const f = fixture(t);
  const image = f.image("valid.png", "-size", "1x1", "xc:red");
  f.mockMagick('output=${!#}; printf partial > "${output#PNG:}"; exit 1');
  f.send(image);
  assert.match(f.run().stderr, /preview_rejected/);
  assert.equal(f.entries()[0].preview, "");
  assert.deepEqual(fs.readdirSync(path.join(f.store, "images")), []);
});

test("missing preview tools preserve notification text without a raw fallback", t => {
  const f = fixture(t);
  const image = f.image("valid.png", "-size", "1x1", "xc:red");
  const bin = path.join(f.root, "tools");
  fs.mkdirSync(bin);
  // Keep the backend's base tools, but deliberately omit optional decoders.
  for (const tool of ["bash", "dirname", "jq", "flock", "mkdir", "chmod", "timeout", "head", "stat",
    "file", "rm", "mv", "date", "grep", "tail", "sort", "comm", "cat", "basename"])
    fs.symlinkSync(`/usr/bin/${tool}`, path.join(bin, tool));
  f.env.PATH = bin;
  f.send(image);
  assert.match(f.run().stderr, /preview_rejected/);
  fs.unlinkSync(path.join(bin, "file"));
  f.send(image);
  assert.match(f.run().stderr, /preview_rejected/);
  assert.equal(f.entries().length, 2);
  assert.ok(f.entries().every(entry => entry.preview === ""));
  assert.deepEqual(fs.readdirSync(path.join(f.store, "images")), []);
});

test("a stuck converter is forcibly stopped and releases the archive lock", t => {
  const f = fixture(t);
  const image = f.image("valid.png", "-size", "1x1", "xc:red");
  // Ignore TERM to exercise the hard-kill deadline, including child processes.
  f.mockMagick('output=${!#}; printf partial > "${output#PNG:}"; trap "" TERM; sleep 30');
  f.send(image);
  const next = f.send();
  const start = Date.now();
  assert.match(f.run().stderr, /preview_rejected/);
  assert.ok(Date.now() - start < 10000, "conversion exceeded its deadline");
  assert.equal(f.entries().length, 2);
  assert.equal(f.entries()[0].preview, "");
  assert.ok(f.entries().some(row => row.key === next));
  assert.deepEqual(fs.readdirSync(path.join(f.store, "images")), []);
  f.run("seen");
});

test("the real watcher continues after rejecting an image", async t => {
  const f = fixture(t);
  const wide = f.image("wide.png", "-size", "9000x1", "xc:red");
  const initial = f.send();
  const child = spawn(script, ["watch"], { env: f.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  async function waitFor(check) {
    const deadline = Date.now() + 5000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(check(), `watcher did not advance: ${errors}`);
  }
  await waitFor(() => output.includes(initial));
  // Confirm registered watches before writing, without relying on a sleep.
  await waitFor(() => {
    const children = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    return children.some(pid => {
      try {
        return fs.readdirSync(`/proc/${pid}/fd`).some(fd => {
          try { return /^inotify wd:/m.test(fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8")); } catch { return false; }
        });
      } catch { return false; }
    });
  });
  const rejected = f.send(wide);
  const next = f.send();
  await waitFor(() => output.includes(next));
  const row = f.entries().find(entry => entry.key === rejected);
  assert.equal(row.preview, "");
  assert.match(errors, /preview_rejected/);
  assert.equal(child.exitCode, null);
});
