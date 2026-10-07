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
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        pause(3000).then(() => { child.kill("SIGKILL"); }),
      ]);
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

    service = await launchService(dataDir);
    const restarted = await service.readyStatus();
    assert.equal(restarted.dataReady, true);
    const recovered = await service.rpc("cache.page", { cursor: 0, maxBytes: 65536 });
    assert.equal(recovered.body.value.sessions["agent-a::desktop::2026-10-06"].totalTokens, 15);
  } finally {
    await service?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
