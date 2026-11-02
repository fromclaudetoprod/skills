#!/usr/bin/env node
// Prints the models this user's Copilot account offers, as JSON: {"models":[{id,name,usage}]} or {"error":"..."}.
// Copilot CLI has no "list models" command, but its ACP server reports them when a session opens. No prompt is sent,
// so nothing is billed, and the session is closed again. core.mjs runs this and caches the answer for a day.
import { spawn } from "node:child_process";
import os from "node:os";
import { parseAcpModels } from "./core.mjs";

// One fixed command string: on Windows the .cmd shim needs a shell, and Node warns about args passed alongside one.
const p = process.platform === "win32"
  ? spawn("copilot --acp --no-custom-instructions", { shell: true, stdio: ["pipe", "pipe", "ignore"] })
  : spawn("copilot", ["--acp", "--no-custom-instructions"], { stdio: ["pipe", "pipe", "ignore"] });
let buf = "", finished = false;
const send = (id, method, params) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
const finish = (result) => {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(result));
  p.stdin.end();
  setTimeout(() => { p.kill(); process.exit(0); }, 2000).unref();
};
setTimeout(() => finish({ error: "Copilot did not answer within 40 seconds" }), 40_000).unref();
p.on("error", (e) => finish({ error: e.message }));
p.on("exit", () => finish({ error: "Copilot exited before listing models (is it signed in? run: copilot login)" }));
let models = null;
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) send(2, "session/new", { cwd: os.tmpdir(), mcpServers: [] });
    else if (m.id === 2) {
      if (!m.result) return finish({ error: m.error?.message ?? "no session" });
      models = parseAcpModels(m.result);
      send(3, "session/close", { sessionId: m.result.sessionId });
    } else if (m.id === 3) finish({ models });
  }
});
send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
