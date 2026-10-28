import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiQuotaService, normalizeBaseUrl, GEMINI_CPA_BASE_URL } from "../lib/gemini-quota.mjs";

const OK_BASE = "https://cpa.example.invalid";
const KEY = "synthetic-management-key";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gemini-base-url-"));
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function writeConfigFile(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "gemini-cpa.json"), JSON.stringify(config), { mode: 0o600 });
}

test("normalizeBaseUrl 只接受干净的 https 根地址", () => {
  assert.equal(normalizeBaseUrl(`${OK_BASE}`), OK_BASE);
  assert.equal(normalizeBaseUrl(`  ${OK_BASE}/  `), OK_BASE, "首尾空白与尾部斜杠被去掉");
  assert.equal(normalizeBaseUrl(`${OK_BASE}/cpa/`), `${OK_BASE}/cpa`, "保留路径前缀，去掉尾部斜杠");
  assert.equal(normalizeBaseUrl("https://example.test:8443/gw"), "https://example.test:8443/gw");
  assert.equal(normalizeBaseUrl("HTTPS://example.test"), "https://example.test", "大小写归一");

  for (const invalid of [
    "",
    "   ",
    "http://example.test",
    "ftp://example.test",
    "example.test",
    "//example.test",
    "https://",
    "https://example.test?x=1",
    "https://example.test/?x=1",
    "https://example.test#frag",
    "https://user:pass@example.test",
    "https://user@example.test",
    `https://example.test/${"a".repeat(200)}`,
    "not a url",
  ]) {
    assert.equal(normalizeBaseUrl(invalid), "", `应拒绝: ${invalid}`);
  }

  for (const nonString of [null, undefined, 42, {}, []]) {
    assert.equal(normalizeBaseUrl(nonString), "");
  }
});

test("实例按配置拼接 management 地址，缺失或非法时回退占位默认值", () => {
  const dataDir = tempDir();
  try {
    const service = new GeminiQuotaService({ dataDir });
    assert.equal(service.effectiveBaseUrl, GEMINI_CPA_BASE_URL);
    assert.equal(service.credentialsUrl, `${GEMINI_CPA_BASE_URL}/v8/management/credentials`);
    assert.equal(service.apiCallUrl, `${GEMINI_CPA_BASE_URL}/v8/management/requests/api-call`);

    writeConfigFile(dataDir, { managementKey: KEY, baseUrl: `${OK_BASE}/cpa/` });
    assert.equal(service.effectiveBaseUrl, `${OK_BASE}/cpa`);
    assert.equal(service.credentialsUrl, `${OK_BASE}/cpa/v8/management/credentials`);
    assert.equal(service.apiCallUrl, `${OK_BASE}/cpa/v8/management/requests/api-call`);

    writeConfigFile(dataDir, { managementKey: KEY, baseUrl: "http://insecure.test" });
    assert.equal(service.effectiveBaseUrl, GEMINI_CPA_BASE_URL, "非法地址不参与拼接");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("有密钥但缺地址：不发任何网络请求，reason 为 missing_base_url", async () => {
  for (const config of [{ managementKey: KEY }, { managementKey: KEY, baseUrl: "" }, { managementKey: KEY, baseUrl: "http://insecure.test" }]) {
    const dataDir = tempDir();
    let calls = 0;
    try {
      writeConfigFile(dataDir, config);
      const service = new GeminiQuotaService({
        dataDir,
        network: { async fetch() { calls++; throw new Error("network must not run"); } },
        fetchFn: async () => { calls++; throw new Error("network must not run"); },
      });
      const dto = await service.getQuota();
      assert.deepEqual(dto, {
        configured: true,
        connected: false,
        reason: "missing_base_url",
        updatedAt: null,
        accounts: [],
      });
      assert.equal(calls, 0);
      assert.deepEqual(service.getConfig(), {
        configured: true,
        baseUrl: GEMINI_CPA_BASE_URL,
        baseUrlConfigured: false,
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test("配上合法地址后照常出网，并使用配置的主机", async () => {
  const dataDir = tempDir();
  const calls = [];
  try {
    const service = new GeminiQuotaService({
      dataDir,
      fetchFn: async (url) => {
        calls.push(url);
        return response(200, { files: [] });
      },
    });
    const saved = await service.saveConfig({ action: "save", managementKey: KEY, baseUrl: `${OK_BASE}/cpa` });
    assert.equal(saved.ok, true);
    const dto = await service.getQuota();
    assert.equal(dto.reason, "no_accounts");
    assert.deepEqual(calls, [`${OK_BASE}/cpa/v8/management/credentials`]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("saveConfig 保存、规范化、沿用与拒绝非法 baseUrl", async () => {
  const dataDir = tempDir();
  try {
    const service = new GeminiQuotaService({ dataDir });

    const saved = await service.saveConfig({ action: "save", managementKey: KEY, baseUrl: `${OK_BASE}/cpa/` });
    assert.deepEqual(saved, { ok: true, configured: true, baseUrl: `${OK_BASE}/cpa`, baseUrlConfigured: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "gemini-cpa.json"), "utf8")), {
      managementKey: KEY,
      baseUrl: `${OK_BASE}/cpa`,
    });

    // 只轮换密钥：不传 baseUrl 就沿用已有地址
    const rotated = await service.saveConfig({ action: "save", managementKey: `${KEY}-2` });
    assert.equal(rotated.ok, true);
    assert.equal(rotated.baseUrl, `${OK_BASE}/cpa`);
    assert.equal(service.getConfig().baseUrlConfigured, true);

    for (const badBase of ["http://insecure.test", `${OK_BASE}?token=1`, "https://user:pass@example.test", ""]) {
      const rejected = await service.saveConfig({ action: "save", managementKey: KEY, baseUrl: badBase });
      assert.deepEqual(rejected, { ok: false, code: "INVALID_INPUT" }, `应拒绝: ${badBase}`);
    }
    // 被拒绝的保存不能污染已存配置
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "gemini-cpa.json"), "utf8")), {
      managementKey: `${KEY}-2`,
      baseUrl: `${OK_BASE}/cpa`,
    });

    const cleared = await service.saveConfig({ action: "clear" });
    assert.deepEqual(cleared, { ok: true, configured: false, baseUrl: GEMINI_CPA_BASE_URL, baseUrlConfigured: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "gemini-cpa.json"), "utf8")), {});
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("getConfig 区分未配置、缺地址与已配置，且不回吐原始非法值", async () => {
  const dataDir = tempDir();
  try {
    const service = new GeminiQuotaService({ dataDir });
    assert.deepEqual(service.getConfig(), { configured: false, baseUrl: GEMINI_CPA_BASE_URL, baseUrlConfigured: false });

    writeConfigFile(dataDir, { managementKey: KEY, baseUrl: "http://insecure.test?leak=1" });
    const config = service.getConfig();
    assert.equal(config.configured, true);
    assert.equal(config.baseUrl, GEMINI_CPA_BASE_URL);
    assert.equal(config.baseUrlConfigured, false);
    assert.doesNotMatch(JSON.stringify(config), /insecure\.test|leak/);
    assert.doesNotMatch(JSON.stringify(config), new RegExp(KEY));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
