// runtime/engine/services/agent-names.js
// 从本机 agents/<id>/config.yaml 读 Agent 的显示名。
//
// 为什么需要：宿主 `agent:list` 按设计把「子代理池」条目过滤掉（listAgents 默认
// includeSubagentPool:false，而这个参数没有暴露给应用接口），所以 hana-artisan、luna、
// gemini-coder 这些执行者在接口层只有 id、没有名字。但它们在本机就是普通 Agent 目录，
// 名字写在自己的 config.yaml 里：引擎以 local-machine 档运行，读得到。
//
// 不引 YAML 依赖：只取 `agent:` 段下的 name / latinName 两个标量，按缩进判断层级。
// 解析不出来就返回 null，调用方继续用 id——不猜、不编。
import fs from "node:fs";
import path from "node:path";

const TTL_MS = 5 * 60 * 1000;
let memo = { at: 0, homeDir: null, value: null };

function scalar(raw) {
  const value = String(raw).trim();
  if (!value) return null;
  // 引号开头：引号内的 # 不是注释，取到配对引号为止。
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    if (end > 0) return value.slice(1, end).trim() || null;
  }
  const cut = value.replace(/\s+#.*$/, "").trim();
  return cut || null;
}

// 只读 `agent:` 段里 indent 2 的 name / latinName；其余字段一概不碰。
export function readAgentIdentity(text) {
  if (typeof text !== "string") return null;
  let inAgent = false;
  let name = null;
  let latinName = null;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      inAgent = trimmed === "agent:";
      continue;
    }
    if (!inAgent || indent > 2) continue;
    const pair = /^(name|latinName):\s*(.+)$/.exec(trimmed);
    if (!pair) continue;
    if (pair[1] === "name") name = scalar(pair[2]);
    else latinName = scalar(pair[2]);
  }
  if (!name) return null;
  return { name, latinName: latinName || null };
}

export function loadAgentNames(homeDir, log = () => {}) {
  if (typeof homeDir !== "string" || !homeDir) return {};
  if (memo.homeDir === homeDir && Date.now() - memo.at < TTL_MS) return memo.value;
  const base = path.join(homeDir, "agents");
  const names = {};
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const identity = readAgentIdentity(fs.readFileSync(path.join(base, entry.name, "config.yaml"), "utf8"));
        if (identity?.name) names[entry.name] = identity.name;
      } catch { /* 单个 Agent 的配置读不到就跳过，不影响其他人 */ }
    }
  } catch (error) {
    log.warn?.("[token-tracker] agents 目录不可读：" + (error?.code || error?.message || "UNKNOWN"));
    return {};
  }
  memo = { at: Date.now(), homeDir, value: names };
  return names;
}

export function resetAgentNameMemo() {
  memo = { at: 0, homeDir: null, value: null };
}
