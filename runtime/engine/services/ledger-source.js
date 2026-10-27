// runtime/engine/services/ledger-source.js
// 宿主官方账本的直接来源（引擎以 local-machine 档运行时可读）。
//
// 为什么不走宿主的 usage:list：那条接口把条目投影成白名单字段，投影里保留了
// attribution.childSessionId，但删掉了 attribution.childAgentId 与 source.actor。
// 于是应用只知道「这条子代理请求是被谁派出去的」，不知道「是谁在跑」。
// 直接读账本文件拿到的是原始 entry_json，执行者身份完整。
//
// 两个来源的条目形状是同一份：sqlite 的 entry_json 存的就是原来那个条目对象，
// 所以上层 normalize 一行都不用改。
//
// 指纹：WAL 模式下主库文件的 mtime 只在检查点才动，所以把 -wal 的大小与时间也算进去，
// 否则「刚写进去、还没检查点」的那段时间会被当成没变化。
import fs from "node:fs";
import path from "node:path";
import { loadSqliteDriver } from "./turns-store.js";
import { readTextFile } from "./platform.js";

// 同一份账本只解析一次：20000 条 entry_json 全量读+解析约 150ms，
// 每次扫描都问一遍不能每次重来。
let memo = { key: "", value: null };

function emptySource(sourcePath, key, error = null) {
  return { entries: [], sourcePath, sourceMode: "none", key, error };
}

export function loadLedger(homeDir, log = () => {}) {
  const sqlitePath = path.join(homeDir, "usage-ledger.sqlite");
  const jsonPath = path.join(homeDir, "usage-ledger.json");

  const Driver = loadSqliteDriver();
  if (Driver && fs.existsSync(sqlitePath)) {
    try {
      const st = fs.statSync(sqlitePath);
      let wal = "";
      try { const w = fs.statSync(sqlitePath + "-wal"); wal = `:${w.mtimeMs}:${w.size}`; } catch {}
      const key = `sqlite:${st.mtimeMs}:${st.size}${wal}`;
      if (memo.key === key) return memo.value;
      const db = new Driver(sqlitePath, { readOnly: true });
      let entries = [];
      try {
        entries = db.prepare("SELECT entry_json FROM usage_entries ORDER BY entry_order").all()
          .map((row) => { try { return JSON.parse(row.entry_json); } catch { return null; } })
          .filter(Boolean);
      } finally { try { db.close(); } catch {} }
      memo = { key, value: { entries, sourcePath: sqlitePath, sourceMode: "sqlite", key, error: null } };
      return memo.value;
    } catch (e) {
      log.warn?.("[token-tracker] 账本 sqlite 读取失败，退回 json：" + (e?.code || "") + " " + (e?.message || ""));
    }
  }

  // 退回 json（老版本宿主，或 sqlite 驱动不可用）
  try {
    if (!fs.existsSync(jsonPath)) return emptySource(sqlitePath, "missing");
    const st = fs.statSync(jsonPath);
    const key = `json:${st.mtimeMs}:${st.size}`;
    if (memo.key === key) return memo.value;
    const data = JSON.parse(readTextFile(jsonPath));
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    memo = { key, value: { entries, sourcePath: jsonPath, sourceMode: "json", key, error: null } };
    return memo.value;
  } catch (e) {
    log.warn?.("[token-tracker] 账本 json 读取失败：" + (e?.code || "") + " " + (e?.message || ""));
    return emptySource(jsonPath, "json:error", e?.code || "JSON_ERROR");
  }
}

export function resetLedgerMemo() {
  memo = { key: "", value: null };
}
