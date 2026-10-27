import { classifyError } from "./runtime-health.mjs";

export const DEFAULT_MAX_LEDGER_LIMIT = 20000;

// 账本来源的探测间隔：引擎侧按文件指纹记忆，这里只是防止每轮扫描都问一遍。
const LEDGER_PROBE_TTL_MS = 30 * 1000;

export function createSyncScheduler({ shared, client, sdk, interval, maxLedgerLimit = DEFAULT_MAX_LEDGER_LIMIT, sourceResolver = null, afterScan = null }) {
  let ledgerProbe = null;
  let ledgerProbeAt = 0;

  // 优先用引擎直读官方账本（字段完整，含执行者身份）；探不到才退回宿主接口。
  async function probeLedger(force = false) {
    if (!force && ledgerProbe && Date.now() - ledgerProbeAt < LEDGER_PROBE_TTL_MS) return ledgerProbe;
    try {
      const result = typeof client.probeLedger === "function" ? await client.probeLedger() : null;
      ledgerProbe = {
        available: result?.available === true && Number(result?.count) > 0,
        mode: result?.mode || "none",
        path: result?.path || null,
        count: Number(result?.count) || 0,
        error: result?.error || null,
      };
    } catch (error) {
      ledgerProbe = { available: false, mode: "none", path: null, count: 0, error: error?.code || "PROBE_FAILED" };
    }
    ledgerProbeAt = Date.now();
    return ledgerProbe;
  }

  async function performScan(force) {
    shared.lastAttemptAt = new Date().toISOString();
    shared.health.set("scanner", "unknown", "checking");
    let entries = [];
    let usageQueryError = null;
    const useLocalLedger = (await probeLedger()).available;
    try {
      if (!useLocalLedger) {
        const listUsage = typeof sdk.usage?.list === "function"
          ? (params) => sdk.usage.list(params)
          : (params) => sdk.bus.request("usage:list", params);
        const result = await listUsage({ limit: maxLedgerLimit });
        if (result?.error) {
          throw Object.assign(new Error(String(result.error?.message || result.error)), {
            code: result.code || result.error?.code,
            status: result.status,
          });
        }
        if (!Array.isArray(result?.entries)) {
          throw Object.assign(new Error("无效账本数据"), { code: "INVALID_DATA" });
        }
        entries = result.entries;
      }
      shared.health.set("ledger", "ok", "ledger_ok");
    } catch (error) {
      usageQueryError = classifyError(error);
      shared.syncFailed = true;
      shared.usageQueryError = usageQueryError;
      shared.health.set("ledger", "degraded", usageQueryError);
      if (!shared.data) {
        try {
          const previous = await client.readSnapshot();
          if (!shared.disposed && (previous.lastScan || Object.keys(previous.sessions || {}).length)) {
            shared.data = previous;
            shared.ready = true;
            shared.lastSuccessAt = previous.usageQueryError ? null : previous.lastScan || null;
          }
        } catch {}
      }
      throw Object.assign(new Error("官方账本同步失败"), { code: "LEDGER_SYNC_FAILED", reason: usageQueryError });
    }

    // 会话来源分类：失败只降级来源完整性，不影响用量扫描。
    let resolution = null;
    if (sourceResolver) {
      try {
        resolution = await sourceResolver.resolve(entries);
      } catch (error) {
        shared.log?.warn?.(`[token-tracker] session source classification failed: ${error?.code || error?.message || "UNKNOWN"}`);
        resolution = null;
      }
    }

    const scanResult = await client.scan(useLocalLedger ? null : entries, {
      force: force === true,
      localLedger: useLocalLedger,
      agentNames: shared.agentNames,
      poolAgentIds: Array.isArray(shared.poolAgentIds) ? shared.poolAgentIds : [],
      coverageLimitReached: useLocalLedger
        ? (ledgerProbe?.count || 0) >= maxLedgerLimit
        : entries.length >= maxLedgerLimit,
      usageQueryError,
      sessionNamespaces: resolution?.sessionNamespaces || {},
      sourceResolution: resolution?.sourceResolution || null,
    });
    const data = await client.readSnapshot();
    // 仅在扫描与快照都成功后确认；只确认引擎声明已持久化的 ID。
    if (resolution && typeof sourceResolver?.ack === "function") {
      try {
        await sourceResolver.ack(Array.isArray(scanResult?.sourceAckSessionIds) ? scanResult.sourceAckSessionIds : []);
      } catch (error) {
        shared.log?.warn?.(`[token-tracker] session source ack failed: ${error?.code || error?.message || "UNKNOWN"}`);
      }
    }
    if (shared.disposed) return scanResult;
    shared.data = data;
    shared.ready = true;
    shared.syncFailed = false;
    shared.lastSuccessAt = data.lastScan;
    shared.health.set("scanner", "ok", "scan_ok");
    shared.coverageLimitReached = scanResult.coverageLimitReached;
    shared.usageQueryError = scanResult.usageQueryError;
    shared.scanMeta = scanResult;
    shared.ledgerSource = scanResult.ledgerSource || (ledgerProbe ? { mode: ledgerProbe.mode, path: ledgerProbe.path, count: ledgerProbe.count } : null);
    const scannedCount = scanResult.ledgerSource?.count ?? entries.length;
    shared.log?.info?.(`[token-tracker] scan complete: ${scannedCount} ${useLocalLedger ? "local ledger" : "ledger"} entries, ${scanResult.newArchivedCount ?? 0} newly archived, ${Object.keys(data.sessions || {}).length} cached sessions`);
    if (typeof afterScan === "function") {
      try { await afterScan(); } catch (error) {
        shared.log?.warn?.(`[token-tracker] post-scan hook failed: ${error?.code || error?.message || "UNKNOWN"}`);
      }
    }
    return scanResult;
  }

  const scan = (force = false) => {
    if (shared.disposed) {
      return Promise.reject(Object.assign(new Error("Token Tracker 已停止"), { code: "APP_STOPPED" }));
    }
    if (shared.scanPromise) {
      if (force) shared.pendingForce = true;
      return shared.scanPromise;
    }
    const run = async () => {
      let nextForce = force === true;
      let result;
      do {
        if (shared.disposed) break;
        shared.scanning = true;
        try {
          result = await performScan(nextForce);
        } catch (error) {
          if (!shared.disposed) {
            shared.syncFailed = true;
            shared.health.set("scanner", "degraded", error.reason || classifyError(error));
          }
          throw error;
        } finally {
          shared.scanning = false;
        }
        nextForce = shared.pendingForce;
        shared.pendingForce = false;
      } while (nextForce);
      return result;
    };
    shared.scanPromise = Promise.resolve().then(run).finally(() => {
      shared.scanning = false;
      shared.scanPromise = null;
      shared.pendingForce = false;
    });
    return shared.scanPromise;
  };

  let timer = null;

  function start() {
    scan(false).catch((error) => {
      shared.log?.warn?.(`[token-tracker] initial scan failed: ${error?.code || "UNKNOWN"}: ${error?.message || "unknown error"}`);
    });
    timer = setInterval(() => {
      scan(false).catch((error) => {
        shared.log?.warn?.(`[token-tracker] scheduled scan failed: ${error?.code || "UNKNOWN"}: ${error?.message || "unknown error"}`);
      });
    }, interval);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function updateInterval(newIntervalMs) {
    if (typeof newIntervalMs === "number" && newIntervalMs >= 5000) {
      interval = newIntervalMs;
      shared.scanIntervalMs = newIntervalMs;
      if (timer) {
        clearInterval(timer);
        timer = setInterval(() => {
          scan(false).catch((error) => {
            shared.log?.warn?.(`[token-tracker] scheduled scan failed: ${error?.code || "UNKNOWN"}: ${error?.message || "unknown error"}`);
          });
        }, interval);
        timer.unref?.();
      }
    }
  }

  return {
    scan,
    fullScan: () => scan(true),
    start,
    stop,
    updateInterval,
    performScan,
  };
}
