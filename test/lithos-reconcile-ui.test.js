import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deltaClass,
  esc,
  fmtTokens,
  formatDeltaPct,
  formatRate,
  money,
  moneyDelta,
  renderNull,
  shortDate,
  shortModel,
} from "../ui/modules/lithos-reconcile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("对账页的金额格式：null 一律给 null，交给上层渲染 —，不写 0", () => {
  assert.equal(money(null), null);
  assert.equal(money(undefined), null);
  assert.equal(money(Number.NaN), null);
  assert.equal(money(0), "$0.00");
  assert.equal(money(3.616), "$3.62");
  assert.equal(money(0.004), "<$0.01");
  assert.equal(money(-0.004), "-<$0.01");
  assert.equal(moneyDelta(0.25), "+$0.25");
  assert.equal(moneyDelta(-0.25), "-$0.25");
  assert.equal(moneyDelta(null), null);
});

test("对账页的偏差百分比带符号，null 不伪造为 0.0%", () => {
  assert.equal(formatDeltaPct(-26.1), "-26.1%");
  assert.equal(formatDeltaPct(8), "+8.0%");
  assert.equal(formatDeltaPct(0), "0.0%");
  assert.equal(formatDeltaPct(null), null);
});

test("对账页的 token 与单价格式化", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(1200), "1,200");
  assert.equal(fmtTokens(63900), "6.4万");
  assert.equal(fmtTokens(8300000), "830万");
  assert.equal(fmtTokens(100000000), "1亿");
  assert.equal(formatRate(0.0039), "$0.004");
  assert.equal(formatRate(null), null);
});

test("对账页的日期与模型名精简", () => {
  assert.equal(shortDate("2026-10-28"), "10月28日");
  assert.equal(shortDate("bad"), "bad");
  assert.equal(shortModel("deepseek-ai/DeepSeek-V4.1-Flash"), "DeepSeek-V4.1-Flash");
  assert.equal(shortModel("m1"), "m1");
});

test("对账页的差额着色只表达方向，不表达好坏", () => {
  assert.equal(deltaClass(0.1), "lr-delta-pos");
  assert.equal(deltaClass(-0.1), "lr-delta-neg");
  assert.equal(deltaClass(0), "");
  assert.equal(deltaClass(null), "");
});

test("对账页所有外部字符串都转义", () => {
  assert.equal(esc('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(esc("a&b"), "a&amp;b");
  assert.match(renderNull("价目表未定价"), /class="lr-null"/);
  assert.match(renderNull("价目表未定价"), /title="价目表未定价"/);
});

test("对账页签在看板里接好：页签按钮、容器、懒加载与刷新都在", () => {
  const dashboard = fs.readFileSync(path.join(root, "ui/dashboard-app.js"), "utf8");
  assert.match(dashboard, /import \{ createLithosReconcile \} from "\.\/modules\/lithos-reconcile\.js"/);
  assert.match(dashboard, /data-view="reconcile">对账</);
  assert.match(dashboard, /id="lithos-reconcile-section"/);
  // 懒加载：只有切到该页签才建控制器
  assert.match(dashboard, /_activeView === "reconcile" && reconcile/);
  assert.match(dashboard, /createLithosReconcile\(\{/);
  // 刷新按钮要能强制重取
  assert.match(dashboard, /_lithosReconcile\.reload\(\{ force: true \}\)/);
  // 账单类视图统一置灰 Agent/类型筛选
  assert.match(dashboard, /_activeView === "ds-usage" \|\| _activeView === "reconcile"/);
});

test("对账模块不引入外部依赖，也不自己拼接口域名", () => {
  const mod = fs.readFileSync(path.join(root, "ui/modules/lithos-reconcile.js"), "utf8");
  assert.doesNotMatch(mod, /https?:\/\//, "前端不应硬编码任何地址，统一走 fetchFn");
  assert.doesNotMatch(mod, /from "(?!\.)/, "不应有裸模块名导入");
  assert.match(mod, /fetchFn\(/);
});
