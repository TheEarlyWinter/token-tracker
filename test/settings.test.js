import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  loadSettings,
  saveSettings,
} from "../lib/settings-store.mjs";
import registerRoutes from "../server/dashboard.js";
import { createSyncScheduler } from "../lib/sync-scheduler.mjs";
import { initSettingsDialog } from "../ui/modules/settings-dialog.js";

test("settings-store normalizeSettings handles defaults, clamping, and types", () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ scanInterval: 15 }).scanInterval, 15);
  assert.equal(normalizeSettings({ scanInterval: "45" }).scanInterval, 45);
  // 小于 5 秒的无效值应回退到默认值 60
  assert.equal(normalizeSettings({ scanInterval: 2 }).scanInterval, 60);
  assert.equal(normalizeSettings({ scanInterval: -10 }).scanInterval, 60);
  assert.equal(normalizeSettings({ scanInterval: "invalid" }).scanInterval, 60);

  assert.equal(normalizeSettings({ highUsageThreshold: 50000 }).highUsageThreshold, 50000);
  assert.equal(normalizeSettings({ highUsageThreshold: 0 }).highUsageThreshold, 0);
  assert.equal(normalizeSettings({ highUsageThreshold: -1 }).highUsageThreshold, 30000);

  assert.equal(normalizeSettings({ showCodexQuota: false }).showCodexQuota, false);
  assert.equal(normalizeSettings({ showDeepseekBalance: false }).showDeepseekBalance, false);
  assert.equal(normalizeSettings({ showCodexQuota: true }).showCodexQuota, true);
});

test("settings-store loadSettings and saveSettings perform atomic storage with legacy fallback", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-settings-"));
  try {
    // 首次无 settings.json，从 hostConfig 兼容获取
    const mockHostConfig = { get: async (k) => (k === "scanInterval" ? 42 : null) };
    const firstLoad = await loadSettings(tmpDir, mockHostConfig);
    assert.equal(firstLoad.scanInterval, 42);
    assert.equal(firstLoad.highUsageThreshold, 30000);

    // 保存新设置
    const saved = await saveSettings(tmpDir, { scanInterval: 90, highUsageThreshold: 60000 });
    assert.equal(saved.scanInterval, 90);
    assert.equal(saved.highUsageThreshold, 60000);

    // 再次读取验证磁盘落盘内容
    const secondLoad = await loadSettings(tmpDir);
    assert.equal(secondLoad.scanInterval, 90);
    assert.equal(secondLoad.highUsageThreshold, 60000);

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(raw.scanInterval, 90);
    assert.equal(raw.highUsageThreshold, 60000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("server routes GET /settings and POST /settings work cleanly and hot-update scheduler", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-settings-routes-"));
  try {
    const routes = {};
    let schedulerUpdatedMs = null;
    const mockScheduler = {
      updateInterval(ms) {
        schedulerUpdatedMs = ms;
      },
    };
    const mockCtx = {
      dataDir: tmpDir,
      _tokenCache: {
        dataDir: tmpDir,
        settings: { scanInterval: 60, highUsageThreshold: 30000 },
        scheduler: mockScheduler,
      },
    };

    registerRoutes(
      {
        get: (p, fn) => { routes["GET " + p] = fn; },
        post: (p, fn) => { routes["POST " + p] = fn; },
      },
      mockCtx
    );

    // GET /settings
    const getRes = await routes["GET /settings"]({
      json: (data, status = 200) => ({ status, body: data }),
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.scanInterval, 60);

    // POST /settings
    const postRes = await routes["POST /settings"]({
      req: {
        json: async () => ({ scanInterval: 120, highUsageThreshold: 80000 }),
      },
      json: (data, status = 200) => ({ status, body: data }),
    });
    assert.equal(postRes.status, 200);
    assert.equal(postRes.body.ok, true);
    assert.equal(postRes.body.settings.scanInterval, 120);
    assert.equal(postRes.body.settings.highUsageThreshold, 80000);

    // 验证内存缓存和调度器已热更新
    assert.equal(mockCtx._tokenCache.settings.scanInterval, 120);
    assert.equal(schedulerUpdatedMs, 120000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("createSyncScheduler supports live updateInterval", async () => {
  let timerInterval = null;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = (fn, ms) => {
    timerInterval = ms;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {
    timerInterval = null;
  };

  try {
    const shared = {
      scanIntervalMs: 60000,
      disposed: false,
      log: {},
      health: { set() {} },
    };
    const scheduler = createSyncScheduler({
      shared,
      client: { scan: async () => ({}), readSnapshot: async () => ({}) },
      sdk: { usage: { list: async () => ({ entries: [] }) } },
      interval: 60000,
    });

    scheduler.start();
    assert.equal(timerInterval, 60000);

    scheduler.updateInterval(15000);
    assert.equal(timerInterval, 15000);
    assert.equal(shared.scanIntervalMs, 15000);

    scheduler.stop();
    assert.equal(timerInterval, null);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("ui initSettingsDialog loads and saves settings via fetchFn", async () => {
  const elements = {};
  function makeEl(id) {
    const el = {
      id,
      style: {},
      value: "",
      textContent: "",
      className: "",
      onclick: null,
      dataset: {},
      disabled: false,
    };
    elements[id] = el;
    return el;
  }

  makeEl("st-btn");
  makeEl("set-panel");
  makeEl("set-shade");
  makeEl("set-close");
  makeEl("set-save");
  makeEl("set-scan-interval");
  makeEl("set-high-usage");
  makeEl("set-show-codex");
  makeEl("set-show-deepseek");
  makeEl("set-msg");

  const originalDoc = globalThis.document;
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    body: { getAttribute: () => "light" },
    addEventListener: () => {},
  };

  try {
    let postedBody = null;
    const fetchFn = async (url, opts) => {
      if (url === "/settings" && (!opts || opts.method !== "POST")) {
        return {
          ok: true,
          json: async () => ({ scanInterval: 45, highUsageThreshold: 25000 }),
        };
      }
      if (url === "/settings" && opts?.method === "POST") {
        postedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({ ok: true, settings: postedBody }),
        };
      }
      return { ok: false, status: 404 };
    };

    const dialog = initSettingsDialog({ fetchFn });
    await dialog.loadSettingsData();

    assert.equal(elements["set-scan-interval"].value, "45");
    assert.equal(elements["set-high-usage"].value, "25000");

    // 修改输入并保存
    elements["set-scan-interval"].value = "75";
    elements["set-high-usage"].value = "40000";
    elements["set-show-codex"].checked = false;
    elements["set-show-deepseek"].checked = true;
    await dialog.saveSettings();

    assert.deepEqual(postedBody, {
      scanInterval: 75,
      highUsageThreshold: 40000,
      showCodexQuota: false,
      showDeepseekBalance: true,
    });
    assert.match(elements["set-msg"].textContent, /已保存/);
  } finally {
    globalThis.document = originalDoc;
  }
});
