import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createLedgerEngine } from "./engine/ledger-engine.mjs";
import { createHttpRpcHandler, createRpcDispatcher } from "./engine/rpc-handler.mjs";

const configFile = process.argv[2];
if (typeof configFile !== "string" || !path.isAbsolute(configFile)) throw new Error("Invalid runtime configuration path");
const config = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
    typeof config.secret !== "string" || !/^[a-f0-9]{64}$/.test(config.secret) ||
    typeof config.dataDir !== "string" || !path.isAbsolute(config.dataDir)) {
  throw new Error("Invalid runtime configuration");
}
try { fs.rmSync(configFile, { force: true }); } catch {}

let engine = null;
let initializationError = null;
const dispatch = createRpcDispatcher({ getEngine: () => engine, getInitError: () => initializationError });
const server = http.createServer(createHttpRpcHandler({ secret: config.secret, dispatch }));
server.requestTimeout = 30000;
server.headersTimeout = 10000;

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, "127.0.0.1", resolve);
});
console.log("TOKEN_TRACKER_READY");

// Store recovery can be large; it runs only in this managed child process.
setImmediate(() => {
  try {
    engine = createLedgerEngine({
      dataDir: config.dataDir,
      log: {
        info: (...args) => console.log(...args),
        warn: (...args) => console.warn(...args),
        error: (...args) => console.error(...args),
      },
    });
  } catch (error) {
    initializationError = { code: error?.code || "ENGINE_INIT_FAILED" };
    console.error("Token Tracker engine initialization failed:", error?.code || error?.message || "unknown error");
  }
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { engine?.close(); } catch {}
  server.close();
  server.closeAllConnections?.();
}
process.once("SIGTERM", () => { stop(); process.exit(0); });
process.once("SIGINT", () => { stop(); process.exit(0); });
