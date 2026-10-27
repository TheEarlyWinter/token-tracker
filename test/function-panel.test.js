import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCodexQuotaCard } from "../ui/modules/codex-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("Function Panel 静态模板与组件结构完整性", () => {
  const panelHtmlPath = path.join(rootDir, "ui", "function-panel.html");
  assert.ok(fs.existsSync(panelHtmlPath), "function-panel.html 文件必须存在");

  const html = fs.readFileSync(panelHtmlPath, "utf-8");
  assert.ok(html.includes('data-surface="function-panel"'), "包含 function-panel surface 标记");
  assert.ok(html.includes('href="./base.css"'), "引入基础极简样式 base.css");
  assert.ok(html.includes('href="./theme.css"'), "引入主题样式 theme.css");
  assert.ok(html.includes('id="fp-codex-section"'), "包含 fp-codex-section 分区");
  assert.ok(html.includes('id="fp-deepseek-section"'), "包含 fp-deepseek-section 分区");
  assert.ok(html.includes('id="fp-empty-notice"'), "包含 fp-empty-notice 空状态提示");
  assert.ok(html.includes('id="codex-card-slot"'), "包含 codex-card-slot 容器");
  assert.ok(html.includes('id="deepseek-card-slot"'), "包含 deepseek-card-slot 容器");
  assert.ok(html.includes('id="fp-refresh"'), "包含刷新按钮 fp-refresh");
  assert.ok(html.includes('src="./function-panel.js"'), "引入模块化逻辑 function-panel.js");

  const panelJsPath = path.join(rootDir, "ui", "function-panel.js");
  assert.ok(fs.existsSync(panelJsPath), "function-panel.js 文件必须存在");
  const js = fs.readFileSync(panelJsPath, "utf-8");
  assert.ok(js.includes("/settings"), "支持请求 settings 配置");
  assert.ok(js.includes("renderCodexQuotaCard"), "正确复用 Codex 卡片渲染函数");
  assert.ok(js.includes("/codex-quota"), "请求 codex-quota 路由");
  assert.ok(js.includes("/codex-reset-credits"), "请求 codex-reset-credits 路由");
  assert.ok(js.includes("/codex-reset-credits/consume"), "请求 codex-reset-credits/consume 路由");
  assert.ok(js.includes("fetchResetCredits"), "导出/包含 fetchResetCredits 函数");
  assert.ok(js.includes("consumeResetCredit"), "导出/包含 consumeResetCredit 函数");
  assert.ok(js.includes("renderDeepSeekCard"), "正确引入 DeepSeek 卡片渲染函数");
  assert.ok(js.includes("/deepseek-balance"), "请求 deepseek-balance 路由");
});

test("renderCodexQuotaCard 正确渲染账户余额 badge 与重置卡数量按钮", () => {
  const container = { innerHTML: "" };
  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    primary: { remainingPercent: 80, resetAfterSeconds: 3600 },
    secondary: { remainingPercent: 50, resetAfterSeconds: 86400 },
    resetCredits: 2,
    creditsBalance: "$15.00",
  });

  assert.ok(container.innerHTML.includes("sb-codex-bal-badge"), "包含余额 badge");
  assert.ok(container.innerHTML.includes("$15.00"), "正确展示余额文本");
  assert.ok(container.innerHTML.includes("sb-codex-credit-btn"), "包含重置卡按钮");
  assert.ok(container.innerHTML.includes("卡 2"), "展示卡数量 2");

  // 无余额且无重置卡时，不应渲染对应的 badge 或 button
  const cleanContainer = { innerHTML: "" };
  renderCodexQuotaCard(cleanContainer, {
    connected: true,
    planLabel: "Plus",
    primary: { remainingPercent: 90 },
    resetCredits: 0,
    creditsBalance: null,
  });
  assert.ok(!cleanContainer.innerHTML.includes("sb-codex-bal-badge"), "无余额时不渲染余额 badge");
  assert.ok(!cleanContainer.innerHTML.includes("sb-codex-credit-btn"), "无重置卡时不渲染卡按钮");
});

test("renderCodexQuotaCard 重置卡交互流程（选卡、二次确认、核销与刷新触发）", async () => {
  class SimpleMockEl {
    constructor(tag = "div", id = "") {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.attributes = {};
      this.style = {};
      this.children = [];
      this.parentElement = null;
      this.listeners = {};
      this._innerHTML = "";
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] || (k === "id" ? this.id : null); }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    click() {
      const event = { currentTarget: this, target: this };
      const result = typeof this.onclick === "function" ? this.onclick(event) : undefined;
      const listeners = (this.listeners["click"] || []).map((handler) => handler(event));
      if (listeners.length === 0) return result;
      return Promise.all(result === undefined ? listeners : [result, ...listeners]);
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel.startsWith(".") && (cur.className || "").split(/\s+/).includes(sel.slice(1))) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    set innerHTML(val) {
      this._innerHTML = String(val);
      this.children = [];
      const tagMatches = val.matchAll(/<([a-zA-Z0-9]+)([^>]*)>/g);
      let lastAct = null;
      for (const m of tagMatches) {
        const tag = m[1];
        const attrs = m[2];
        const idM = attrs.match(/id=["\x27]([^"\x27]*)["\x27]/);
        const classM = attrs.match(/class=["\x27]([^"\x27]*)["\x27]/);
        const dataActM = attrs.match(/data-act=["\x27]([^"\x27]*)["\x27]/);
        const dataCreditM = attrs.match(/data-credit-id=["\x27]([^"\x27]*)["\x27]/);

        const child = new SimpleMockEl(tag, idM ? idM[1] : "");
        if (classM) child.className = classM[1];
        if (dataActM) child.setAttribute("data-act", dataActM[1]);
        if (dataCreditM) child.setAttribute("data-credit-id", dataCreditM[1]);

        if (child.className && child.className.includes("sb-reset-card-act")) {
          lastAct = child;
          child.parentElement = this;
          this.children.push(child);
        } else if (lastAct && (dataActM || tag.toLowerCase() === "button")) {
          child.parentElement = lastAct;
          lastAct.children.push(child);
        } else {
          child.parentElement = this;
          this.children.push(child);
        }
      }
    }
    get innerHTML() { return this._innerHTML; }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const res = [];
      const walk = (node) => {
        if (!node) return;
        let match = false;
        if (sel.startsWith("#") && node.id === sel.slice(1)) match = true;
        else if (sel.startsWith(".") && (node.className || "").split(/\s+/).includes(sel.slice(1))) match = true;
        else if (sel === "[data-act=\x27prepare\x27]" && node.getAttribute("data-act") === "prepare") match = true;
        else if (sel === "[data-act=\x27confirm\x27]" && node.getAttribute("data-act") === "confirm") match = true;
        else if (sel === "[data-act=\x27cancel\x27]" && node.getAttribute("data-act") === "cancel") match = true;

        if (match && node !== this) res.push(node);
        for (const ch of node.children) walk(ch);
      };
      walk(this);
      return res;
    }
  }

  const container = new SimpleMockEl("div");
  let fetchedCount = 0;
  let consumedId = null;
  let refreshed = false;

  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    resetCredits: 2,
    creditsBalance: "$10.00",
  }, {
    onFetchResetCredits: async () => {
      fetchedCount++;
      return {
        connected: true,
        credits: [
          { id: "credit_card_alpha", title: "5h限额重置卡 A", status: "available", expiresAt: "2026-12-01T00:00:00Z" },
          { id: "credit_card_beta", title: "备用重置卡 B", status: "redeemed" },
        ],
        availableCount: 1,
      };
    },
    onConsumeResetCredit: async (id) => {
      consumedId = id;
      return { ok: true, code: "reset", message: "重置卡已成功使用，限额已清空" };
    },
    onRefresh: () => {
      refreshed = true;
    },
  });

  const toggleBtn = container.querySelector("#sb-codex-credit-toggle");
  assert.ok(toggleBtn, "卡数量按钮应存在");

  // 1. 点击展开重置卡抽屉
  await toggleBtn.click();
  assert.equal(fetchedCount, 1, "点击卡按钮后应拉取重置卡列表");

  // 2. 选择指定卡片进行准备核销
  const prepareBtn = container.querySelector("[data-act=\x27prepare\x27]");
  assert.ok(prepareBtn, "可用卡片应具有'使用此卡'操作按钮");
  assert.equal(prepareBtn.getAttribute("data-credit-id"), "credit_card_alpha");

  // 3. 点击'使用此卡'进入二次确认阶段
  prepareBtn.click();
  const cancelBtn = container.querySelector("[data-act=\x27cancel\x27]");
  const confirmBtn = container.querySelector("[data-act=\x27confirm\x27]");
  assert.ok(cancelBtn, "应出现取消按钮");
  assert.ok(confirmBtn, "应出现确定按钮");

  // 4. 测试取消可还原按钮
  cancelBtn.click();
  const restoredPrepareBtn = container.querySelector("[data-act=\x27prepare\x27]");
  assert.ok(restoredPrepareBtn, "点击取消后应还原'使用此卡'按钮");

  // 5. 再次点击准备并确认核销
  restoredPrepareBtn.click();
  const finalConfirmBtn = container.querySelector("[data-act=\x27confirm\x27]");
  assert.ok(finalConfirmBtn);
  await finalConfirmBtn.click();

  assert.equal(consumedId, "credit_card_alpha", "应使用用户选中的指定卡片 ID 进行核销");
});
