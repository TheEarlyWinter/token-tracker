// 池成员显示名：宿主 agent:list 不列子代理池成员，名字只能从本机 agents/<id>/config.yaml 读。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentIdentity, loadAgentNames, resetAgentNameMemo } from "../runtime/engine/services/agent-names.js";
import { refreshAgentNames } from "../lib/agent-catalog.mjs";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";

const SAMPLE = `# HanaAgent 系统配置
# 由设置页面管理，手动编辑也可以

agent:
  name: DeepSeek
  yuan: kong
  latinName: Artisan
  latinNameSource: auto
user:
  name: ""
models:
  chat:
    provider: deepseek
    id: deepseek-ai/DeepSeek-V4.1-Flash
`;

test("readAgentIdentity reads only the agent block and never invents a name", () => {
  assert.deepEqual(readAgentIdentity(SAMPLE), { name: "DeepSeek", latinName: "Artisan" });
  assert.equal(readAgentIdentity('agent:\n  name: "有 引号"\n').name, "有 引号");
  assert.equal(readAgentIdentity("agent:\n  name: 'Luna'  # 行尾注释\n").name, "Luna");
  assert.equal(readAgentIdentity("user:\n  name: 不是这个名字\n"), null, "user.name 不能被当成 agent 名");
  assert.equal(readAgentIdentity("agent:\n  yuan: kong\n"), null);
  assert.equal(readAgentIdentity(""), null);
});

test("loadAgentNames walks agents/*/config.yaml and survives broken entries", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-agent-names-"));
  t.after(() => { resetAgentNameMemo(); fs.rmSync(home, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, "agents", "hana-artisan"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "hana-artisan", "config.yaml"), SAMPLE);
  fs.mkdirSync(path.join(home, "agents", "luna"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "luna", "config.yaml"), "agent:\n  name: Luna\n");
  // 没有 config.yaml 的目录、坏 YAML、普通文件都应被跳过而不是抛错。
  fs.mkdirSync(path.join(home, "agents", "empty"), { recursive: true });
  fs.mkdirSync(path.join(home, "agents", "broken"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "broken", "config.yaml"), "\u0000\u0001");
  fs.writeFileSync(path.join(home, "agents", "loose.txt"), "x");

  resetAgentNameMemo();
  const names = loadAgentNames(home, { warn() {} });
  assert.deepEqual(names, { "hana-artisan": "DeepSeek", luna: "Luna" });

  // 命中缓存后不再读盘：删掉文件仍返回上次结果。
  fs.rmSync(path.join(home, "agents"), { recursive: true, force: true });
  assert.deepEqual(loadAgentNames(home, { warn() {} }), { "hana-artisan": "DeepSeek", luna: "Luna" });
  resetAgentNameMemo();
  assert.deepEqual(loadAgentNames(home, { warn() {} }), {});
});

test("engine exposes local agent names and refuses when it has no home", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-agent-names-engine-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-agent-names-data-"));
  t.after(() => { resetAgentNameMemo(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, "agents", "gemini-coder"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "gemini-coder", "config.yaml"), "agent:\n  name: Gemini\n");
  resetAgentNameMemo();

  const engine = createLedgerEngine({ dataDir, homeDir: home, log: { info() {}, warn() {}, error() {} } });
  t.after(() => engine.close());
  assert.deepEqual(engine.agentNamesFromDisk(), { "gemini-coder": "Gemini" });

  const sandboxed = createLedgerEngine({ dataDir, homeDir: null, log: { info() {}, warn() {}, error() {} } });
  t.after(() => sandboxed.close());
  assert.deepEqual(sandboxed.agentNamesFromDisk(), {});
});

test("refreshAgentNames merges local names only for ids missing from the host roster", async () => {
  const shared = {
    agentNames: {},
    poolAgentIds: [],
    log: { info() {}, warn() {}, error() {} },
    sdk: { agents: { list: async () => ({ agents: [{ id: "sol-architect", name: "日下晴", state: "active" }] }) } },
    client: { call: async () => ({ "sol-architect": "不该覆盖", "hana-artisan": "DeepSeek", luna: "Luna", "": "空 id", "empty-name": "  " }) },
  };
  await refreshAgentNames(shared, { force: true });
  assert.equal(shared.agentNames["sol-architect"], "日下晴", "宿主名册优先");
  assert.equal(shared.agentNames["hana-artisan"], "DeepSeek");
  assert.equal(shared.agentNames.luna, "Luna");
  assert.equal(shared.agentNames[""], undefined);
  assert.equal(shared.agentNames["empty-name"], undefined);
  assert.deepEqual(shared.poolAgentIds.sort(), ["hana-artisan", "luna"]);

  // 5 分钟节流：非 force 的第二次调用不再打接口。
  let calls = 0;
  const throttled = {
    ...shared,
    sdk: { agents: { list: async () => { calls++; return { agents: [] }; } } },
  };
  await refreshAgentNames(throttled);
  assert.equal(calls, 0);
});

test("refreshAgentNames keeps working when the engine has no local names", async () => {
  const shared = {
    agentNames: { hanako: "小鲸鱼" },
    poolAgentIds: [],
    log: { info() {}, warn() {}, error() {} },
    sdk: { agents: { list: async () => ({ agents: [{ id: "hanako", name: "小鲸鱼" }] }) } },
    client: { call: async () => { throw Object.assign(new Error("no home"), { code: "NO_HANA_HOME" }); } },
  };
  await refreshAgentNames(shared, { force: true });
  assert.equal(shared.agentNames.hanako, "小鲸鱼");
  assert.deepEqual(shared.poolAgentIds, []);
});
