import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";
import { hitRatePercent } from "../ui/hit-rate.js";

const source = fs.readFileSync(new URL("../server/dashboard.js", import.meta.url), "utf8");

function loadBuild(fixedIso, timeZone) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length ? args[0] : fixedIso);
    }

    static now() {
      return RealDate.parse(fixedIso);
    }
  }

  const context = vm.createContext({
    fs,
    path,
    Intl,
    Date: FixedDate,
    process: { env: { TOKEN_TRACKER_FORCE_TZ: timeZone } },
    DEFAULT_PRICE_TABLE: {},
    hitRatePercent,
  });
  vm.runInContext(source.slice(source.indexOf("function pickPrice("), source.indexOf("// 缓存汇率")), context);
  vm.runInContext(source.slice(source.indexOf("function build(cache,")), context);
  return context.build;
}

function record(id, date, totalTokens) {
  return {
    requestId: id,
    startedAt: `${date}T12:00:00+08:00`,
    status: "ok",
    source: { subsystem: "session" },
    attribution: { agentId: "week-agent", sessionId: id, kind: "session", conversationType: "desktop" },
    model: { provider: "p1", modelId: "m1" },
    usage: {
      input: { totalTokens, uncachedTokens: totalTokens },
      output: { totalTokens: 0 },
      cache: { readTokens: 0, writeTokens: 0 },
      totalTokens,
    },
  };
}

async function snapshotFor(records) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-week-tz-"));
  const engine = createLedgerEngine({ dataDir, log: { info() {}, warn() {}, error() {} } });
  try {
    await engine.scan(records, {});
    return engine.getData();
  } finally {
    engine.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("week uses the Shanghai Monday when UTC Sunday is already Shanghai Monday", async () => {
  const cache = await snapshotFor([
    record("sun", "2026-10-25", 100),
    record("mon", "2026-10-26", 10),
  ]);
  const build = loadBuild("2026-10-25T16:30:00Z", "Asia/Shanghai");

  assert.equal(build(cache, "week").summary.totalTokens, 10);
});

test("week keeps the local Monday start through a normal week and local Sunday", async () => {
  const cache = await snapshotFor([
    record("sun", "2026-10-25", 100),
    record("mon", "2026-10-26", 10),
    record("wed", "2026-10-28", 20),
  ]);
  const build = loadBuild("2026-10-28T12:00:00Z", "Asia/Shanghai");

  assert.equal(build(cache, "week").summary.totalTokens, 30);
});

test("week honors TOKEN_TRACKER_FORCE_TZ for the calendar day", async () => {
  const cache = await snapshotFor([
    record("old-sun", "2026-10-25", 100),
    record("local-mon", "2026-10-26", 10),
  ]);
  const build = loadBuild("2026-10-27T06:30:00Z", "America/Los_Angeles");

  assert.equal(build(cache, "week").summary.totalTokens, 10);
});
