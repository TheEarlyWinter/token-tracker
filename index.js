import fs from "node:fs";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { LocalClient } from "./lib/local-client.mjs";
import { RuntimeHealth, trackerStatus } from "./lib/runtime-health.mjs";
import { observeAsync } from "./lib/retained-map.mjs";
import { refreshAgentNames } from "./lib/agent-catalog.mjs";
import {
  createRealtimeState,
  realtimeSnapshot,
  handleLlmUsageEvent,
  handleLegacyTokenUsageEvent,
} from "./lib/realtime-stream.mjs";
import { createSyncScheduler } from "./lib/sync-scheduler.mjs";
import { createSessionSourceResolver } from "./lib/session-sources.mjs";
import { loadSettings } from "./lib/settings-store.mjs";
import { initMetricsCollector } from "./lib/metrics-collector.mjs";
import { ModelRoutingStore } from "./lib/model-routing.mjs";
import { deriveHanaHome } from "./lib/local-client.mjs";

function safeCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/.test(code) ? code : "UNKNOWN";
}

const pluginVersion = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8")
).version;

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const currentSettings = await loadSettings(dataDir, sdk.config);
  const scanIntervalSec = currentSettings.scanInterval;
  const interval = scanIntervalSec * 1000;
  const hostLog = sdk.logger || console;
  const log = Object.fromEntries(
    ["info", "warn", "error", "debug"].map((level) => [
      level,
      (...args) => observeAsync(() => hostLog[level]?.(args.map(String).join(" "))),
    ])
  );

  const client = new LocalClient({
    ctx: sdk,
    dataDir,
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });

  const shared = {
    sdk,
    health: new RuntimeHealth({ version: pluginVersion }),
    scanIntervalMs: interval,
    settings: currentSettings,
    status() { return trackerStatus(shared); },
    lastAttemptAt: null,
    lastSuccessAt: null,
    syncFailed: false,
    bus: sdk.bus,
    log,
    client,
    dataDir,
    data: null,
    ready: false,
    scanning: false,
    scanPromise: null,
    pendingForce: false,
    disposed: false,
    agentNames: {},
    _seenRealtimeUsage: new Set(),
    _realtimeClients: new Set(),
    realtime: createRealtimeState(),
    realtimeSnapshot,
  };

  const modelRoutingStore = new ModelRoutingStore({
    dataDir,
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });
  shared.modelRoutingStore = modelRoutingStore;

  sdk._tokenCache = shared;
  if (sdk.rawContext) {
    try { sdk.rawContext._tokenCache = shared; } catch {}
  }

  // 注册 HTTP 与数据看板路由
  if (typeof sdk.routes?.register === "function") {
    try {
      const { default: registerRoutes } = await import("./server/dashboard.js");
      await sdk.routes.register((app) => registerRoutes(app, sdk));
    } catch (error) {
      shared.log.warn?.("[token-tracker] route registration failed:", error?.message || error);
    }
  }

  await refreshAgentNames(shared);

  // 会话来源（Code）识别：官方 session:get 的有界查询与正负缓存
  const sourceResolver = createSessionSourceResolver({ sdk, client, dataDir, log });
  shared.sourceResolver = sourceResolver;

  // 账本同步调度服务
  const scheduler = createSyncScheduler({
    shared,
    client,
    sdk,
    interval,
    sourceResolver,
    // 部署改名/新建 Agent 后看板不用等重启；节流在 refreshAgentNames 里。
    afterScan: async () => {
      try {
        await refreshAgentNames(shared);
      } catch (error) {
        shared.log.warn?.(`[token-tracker] agent names refresh failed: ${safeCode(error)}`);
      }
      try {
        const hanaHome = client.hanaHome || deriveHanaHome(dataDir);
        if (hanaHome) modelRoutingStore.scanSessions(hanaHome);
      } catch (error) {
        shared.log.warn?.(`[token-tracker] model routing history scan failed: ${safeCode(error)}`);
      }
    },
  });
  shared.scheduler = scheduler;
  shared.scan = scheduler.scan;
  shared.fullScan = scheduler.fullScan;
  scheduler.start();

  // 指标收集器（首响、流速、输入栏胶囊与生命周期）
  const metrics = await initMetricsCollector({ sdk, shared, log });

  // 订阅总线用量事件
  let unsubBus = null;
  try {
    if (typeof sdk.bus?.subscribe === "function") {
      unsubBus = await sdk.bus.subscribe((event) => {
        try {
          if (event?.type === "llm_usage" && event?.entry) handleLlmUsageEvent(shared, event.entry);
          else if (event?.type === "token_usage") handleLegacyTokenUsageEvent(shared, event);
        } catch (error) {
          shared.log.warn?.("[token-tracker] event handling error:", error?.message || error);
        }
      }, { types: ["llm_usage"] });
    }
  } catch (error) {
    shared.log.warn?.("[token-tracker] bus.subscribe failed:", error?.message || error);
  }

  // 统一释放与优雅停机
  shared.dispose = () => {
    if (shared.disposePromise) return shared.disposePromise;
    shared.disposed = true;
    shared.ready = false;
    shared.data = null;
    shared._seenRealtimeUsage.clear();
    shared.health.clear();

    scheduler.stop();

    if (shared.modelRoutingStore?.close) {
      try { shared.modelRoutingStore.close(); } catch {}
      shared.modelRoutingStore = null;
    }

    if (shared.turnsStore?.close) {
      try { shared.turnsStore.close(); } catch {}
      shared.turnsStore = null;
    }

    const cleanup = [];
    try {
      if (typeof unsubBus === "function") cleanup.push(Promise.resolve(unsubBus()));
      else if (unsubBus?.disposeAsync) cleanup.push(Promise.resolve(unsubBus.disposeAsync()));
      else if (unsubBus?.unsubscribe) cleanup.push(Promise.resolve(unsubBus.unsubscribe()));
    } catch {}

    for (const realtimeClient of shared._realtimeClients) {
      try { realtimeClient.close?.(); } catch {}
    }
    shared._realtimeClients.clear();

    cleanup.push(client.dispose());
    cleanup.push(Promise.resolve().then(() => sourceResolver.dispose()));
    cleanup.push(metrics.dispose());

    shared.disposePromise = Promise.allSettled(cleanup).then((results) => {
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(failures.map((r) => r.reason), "Token Tracker cleanup failed");
      }
    });
    return shared.disposePromise;
  };

  shared.log.info?.(`[token-tracker] v2 app loaded (interval ${interval}ms; isolated engine)`);
});
