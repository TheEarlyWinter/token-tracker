import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launchService(dataDir) {
  const port = await freePort();
  const secret = "a".repeat(64);
  const configPath = path.join(dataDir, `config-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ port, secret, dataDir }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(rootDir, "runtime/service.mjs"), configPath], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (!output.includes("TOKEN_TRACKER_READY") && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runtime exited before ready: ${output}`);
    await pause(20);
  }
  if (!output.includes("TOKEN_TRACKER_READY")) throw new Error(`runtime startup timed out: ${output}`);
  async function rpc(method, payload = {}, auth = `Bearer ${secret}`) {
    const response = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ method, payload }),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  }
  return {
    child,
    rpc,
    get output() { return output; },
    async readyStatus() {
      const limit = Date.now() + 5000;
      while (Date.now() < limit) {
        const result = await rpc("status");
        if (result.body?.value?.ready) return result.body.value;
        await pause(25);
      }
      throw new Error(`runtime engine not ready: ${output}`);
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once("exit", resolve));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.kill("SIGTERM");
      try { await exited; } finally { clearTimeout(timeout); }
      assert.equal(child.exitCode, 0, "SIGTERM must exit cleanly without SIGKILL escalation");
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "child PID must have been reaped");
    },
  };
}

function entry(requestId) {
  return {
    requestId,
    startedAt: "2026-10-06T10:00:00.000Z",
    status: "ok",
    attribution: { agentId: "agent-a", sessionId: "session-a", kind: "session" },
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    usage: { input: { totalTokens: 10 }, output: { totalTokens: 2 }, cache: { readTokens: 3 }, totalTokens: 15 },
  };
}

test("managed child service authenticates RPC, scans ledger, and recovers journal cache after restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-runtime-"));
  let service;
  try {
    service = await launchService(dataDir);
    const status = await service.readyStatus();
    assert.equal(status.ready, true);

    const denied = await service.rpc("status", {}, "Bearer wrong");
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, "UNAUTHORIZED");

    const scanId = "integration-scan-1";
    assert.equal((await service.rpc("scan.begin", { scanId, agentNames: { "agent-a": "Alpha" } })).status, 200);
    assert.equal((await service.rpc("scan.append", { scanId, entries: [entry("req-1")] })).body.value.received, 1);
    const committed = await service.rpc("scan.commit", { scanId });
    const jobId = committed.body.value.jobId;
    let job;
    for (let i = 0; i < 100; i++) {
      job = await service.rpc("scan.status", { jobId });
      if (job.body.value.state !== "running") break;
      await pause(20);
    }
    assert.equal(job.body.value.state, "complete");
    assert.equal(job.body.value.result.newArchivedCount, 1);

    const page = await service.rpc("cache.page", { cursor: 0, maxBytes: 65536 });
    assert.equal(page.body.value.sessions["agent-a::desktop::2026-10-06"].totalTokens, 15);
    assert.equal(page.body.value.meta.agentNames["agent-a"], "Alpha");
    await service.stop();
    service = null;

    fs.appendFileSync(path.join(dataDir, "usage-archive.jsonl"), '\n\n{broken}\n{"cut":');
    fs.appendFileSync(path.join(dataDir, "token-cache.json.journal"), '\n\n{broken}\n{"cut":');
    service = await launchService(dataDir);
    const restarted = await service.readyStatus();
    assert.equal(restarted.dataReady, true);
    assert.match(service.output, /跳过.*行损坏记录/);
    const recovered = await service.rpc("cache.page", { cursor: 0, maxBytes: 65536 });
    assert.equal(recovered.body.value.sessions["agent-a::desktop::2026-10-06"].totalTokens, 15);
    const rescanId = "after-corrupt-tail";
    await service.rpc("scan.begin", { scanId: rescanId });
    await service.rpc("scan.append", { scanId: rescanId, entries: [entry("req-1"), entry("req-2")] });
    const rescan = await service.rpc("scan.commit", { scanId: rescanId });
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = await service.rpc("scan.status", { jobId: rescan.body.value.jobId });
      if (completed.body.value.state !== "running") break;
      await pause(20);
    }
    assert.equal(completed.body.value.state, "complete");
    assert.equal(completed.body.value.result.newArchivedCount, 1);
    const nextPage = await service.rpc("cache.page", { cursor: 0, maxBytes: 65536 });
    assert.equal(nextPage.body.value.sessions["agent-a::desktop::2026-10-06"].totalTokens, 30);
  } finally {
    await service?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
