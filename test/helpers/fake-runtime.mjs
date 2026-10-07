import fs from "node:fs";
import { createLedgerEngine } from "../../runtime/engine/ledger-engine.mjs";
import { createRpcDispatcher } from "../../runtime/engine/rpc-handler.mjs";

export function createFakeRuntime({ onStart = () => {} } = {}) {
  const runtimes = new Map();
  const stats = { starts: 0, stops: 0, fetches: 0, lastStartInput: null };
  return {
    stats,
    api: {
      async start(input) {
        stats.starts++;
        stats.lastStartInput = input;
        onStart(input);
        if (input.service && !["loopback", "external"].includes(input.network)) {
          throw Object.assign(new Error("Managed services require loopback or external networking"), { code: "RUNTIME_INVALID_SERVICE_NETWORK" });
        }
        const config = JSON.parse(fs.readFileSync(input.args[0], "utf8"));
        const engine = createLedgerEngine({ dataDir: config.dataDir, log: { info() {}, warn() {}, error() {} } });
        const dispatch = createRpcDispatcher({ getEngine: () => engine });
        const runtimeId = `fake-runtime-${stats.starts}`;
        runtimes.set(runtimeId, { engine, dispatch, secret: config.secret });
        return { runtimeId, state: "ready", service: { state: "ready", port: config.port } };
      },
      async get(runtimeId) {
        return runtimes.has(runtimeId) ? { runtimeId, state: "ready", service: { state: "ready" } } : null;
      },
      async fetch(runtimeId, endpoint, init) {
        stats.fetches++;
        const runtime = runtimes.get(runtimeId);
        if (!runtime || endpoint !== "/rpc") return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
        if (init.headers?.Authorization !== `Bearer ${runtime.secret}`) return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
        let input;
        try { input = JSON.parse(init.body); }
        catch { return new Response(JSON.stringify({ error: { code: "INVALID_JSON" } }), { status: 400 }); }
        try {
          const value = await runtime.dispatch(input.method, input.payload || {});
          return new Response(JSON.stringify({ value }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (error) {
          return new Response(JSON.stringify({ error: { code: error.code || "ENGINE_ERROR", message: error.message } }), { status: 503 });
        }
      },
      async stop(runtimeId) {
        stats.stops++;
        const runtime = runtimes.get(runtimeId);
        runtime?.engine.close();
        runtimes.delete(runtimeId);
        return { runtimeId, state: "stopped" };
      },
    },
  };
}
