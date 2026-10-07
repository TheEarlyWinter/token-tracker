import { classifyError } from "./runtime-health.mjs";

export const DEFAULT_MAX_LEDGER_LIMIT = 20000;

export function createSyncScheduler({ shared, client, sdk, interval, maxLedgerLimit = DEFAULT_MAX_LEDGER_LIMIT }) {
  async function performScan(force) {
    shared.lastAttemptAt = new Date().toISOString();
    shared.health.set("scanner", "unknown", "checking");
    let entries = [];
    let usageQueryError = null;
    try {
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

    const scanResult = await client.scan(entries, {
      force: force === true,
      agentNames: shared.agentNames,
      coverageLimitReached: entries.length >= maxLedgerLimit,
      usageQueryError,
    });
    const data = await client.readSnapshot();
    if (shared.disposed) return scanResult;
    shared.data = data;
    shared.ready = true;
    shared.syncFailed = false;
    shared.lastSuccessAt = data.lastScan;
    shared.health.set("scanner", "ok", "scan_ok");
    shared.coverageLimitReached = scanResult.coverageLimitReached;
    shared.usageQueryError = scanResult.usageQueryError;
    shared.scanMeta = scanResult;
    shared.log?.info?.(`[token-tracker] scan complete: ${entries.length} ledger entries, ${scanResult.newArchivedCount ?? 0} newly archived, ${Object.keys(data.sessions || {}).length} cached sessions`);
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

  return {
    scan,
    fullScan: () => scan(true),
    start,
    stop,
    performScan,
  };
}
