import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { renderHeadlineCards } from "../ui/modules/headline-cards.js";
import { createAgentAnalytics } from "../ui/modules/agent-analytics.js";
import { createTurnsInspector } from "../ui/modules/turns-inspector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const appJsSource = fs.readFileSync(path.join(rootDir, "ui/dashboard-app.js"), "utf-8");

// ── 辅助：轻量 DOM 模拟器（解析 HTML 标签与属性，绝不凭空造节点） ──
class MockClassList {
  constructor(initial = "") {
    this.classes = new Set(initial.split(/\s+/).filter(Boolean));
  }
  add(cls) { this.classes.add(cls); }
  remove(cls) { this.classes.delete(cls); }
  contains(cls) { return this.classes.has(cls); }
  toggle(cls, force) {
    if (typeof force === "boolean") {
      if (force) this.add(cls);
      else this.remove(cls);
      return force;
    }
    if (this.contains(cls)) {
      this.remove(cls);
      return false;
    }
    this.add(cls);
    return true;
  }
}

function parseHTMLToNodes(html) {
  if (!html || typeof html !== "string") return [];
  const nodes = [];
  const tagRegex = /<([a-zA-Z0-9]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9]+)([^>]*)\/>|<([a-zA-Z0-9]+)([^>]*)>/g;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = match[1] || match[4] || match[6];
    const rawAttrs = match[2] || match[5] || match[7] || "";
    const inner = match[3] || "";

    const el = new MockElement(tagName);

    // 解析 class
    const classMatch = rawAttrs.match(/class=["']([^"']*)["']/);
    if (classMatch) {
      el.className = classMatch[1];
    }

    // 解析 dataset data-*
    const dataMatches = rawAttrs.matchAll(/data-([a-zA-Z0-9_-]+)=["']([^"']*)["']/g);
    for (const dm of dataMatches) {
      el.dataset[dm[1]] = dm[2];
    }

    // 解析 id
    const idMatch = rawAttrs.match(/id=["']([^"']*)["']/);
    if (idMatch) {
      el.id = idMatch[1];
    }

    // 递归解析子节点
    if (inner.trim()) {
      el.innerHTML = inner;
    }

    nodes.push(el);
  }

  return nodes;
}

class MockElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._className = "";
    this.classList = new MockClassList();
    this._innerHTML = "";
    this.textContent = "";
    this.onclick = null;
    this.onchange = null;
    this.disabled = false;
    this.title = "";
    this.value = "";
  }

  set className(val) {
    this._className = val;
    this.classList = new MockClassList(val);
  }
  get className() {
    return Array.from(this.classList.classes).join(" ");
  }

  set innerHTML(val) {
    this._innerHTML = String(val);
    this.textContent = String(val).replace(/<[^>]+>/g, " ");
    this.children = parseHTMLToNodes(this._innerHTML);
  }
  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    if (child) this.children.push(child);
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
  }

  setAttribute(k, v) {
    this[k] = v;
  }

  getAttribute(k) {
    return this[k] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      if (!node) return;
      if (selector === "[data-dim]" && node.dataset?.dim) results.push(node);
      else if (selector === "[data-scale]" && node.dataset?.scale) results.push(node);
      else if (selector.startsWith(".") && (node.classList?.contains(selector.slice(1)) || node.className?.split(/\s+/).includes(selector.slice(1)))) {
        results.push(node);
      } else if (selector.toLowerCase() === node.tagName.toLowerCase()) {
        results.push(node);
      }
      for (const ch of node.children || []) walk(ch);
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    const found = this.querySelectorAll(selector);
    return found.length > 0 ? found[0] : null;
  }

  addEventListener() {}
}

// ── 1. 负向断言：模板中没有目标按钮时 querySelector 必须返回 null，绝不凭空造节点 ──
test("MockElement negative: querySelector returns null and querySelectorAll returns empty when element is absent from template", () => {
  const el = new MockElement("div");
  el.innerHTML = '<div class="turns-title-group"><h3 class="turns-title">单轮明细</h3></div>';

  const absentBtn = el.querySelector(".turns-export-btn");
  assert.equal(absentBtn, null, "模板中未声明目标按钮时 querySelector 必须严格返回 null，绝不能凭空生成节点");

  const absentList = el.querySelectorAll(".turns-export-btn");
  assert.equal(absentList.length, 0, "模板中未声明目标按钮时 querySelectorAll 必须返回空数组");
});

// ── 2. 核心指标卡片：真实渲染 Code 汇总及缺字段安全零值 ──
test("renderHeadlineCards renders Code card with formatted and exact values", () => {
  const container = { innerHTML: "", children: [] };
  const summary = {
    totalTokens: 1500000,
    totalDesktop: 800000,
    totalChannel: 200000,
    totalCode: 500000,
    totalOutput: 150000,
    totalInput: 650000,
    totalCacheRead: 200000,
    cacheHitRate: 23.5,
  };

  renderHeadlineCards(container, summary, (n) => Number(n).toLocaleString());

  assert.match(container.innerHTML, /cd-code/, "必须包含 .cd-code 卡片容器");
  assert.match(container.innerHTML, />CODE</, "卡片标签必须为 CODE");
  assert.match(container.innerHTML, /500,000/, "展示格式化后的 Code 总量");
  assert.match(container.innerHTML, /精确值:\s*500,000/, "卡片 title 须展示精确值");
});

test("renderHeadlineCards safely defaults totalCode to 0 when missing", () => {
  const container = { innerHTML: "", children: [] };
  const summaryWithoutCode = {
    totalTokens: 1000000,
    totalDesktop: 800000,
    totalChannel: 200000,
  };

  renderHeadlineCards(container, summaryWithoutCode, (n) => String(n ?? 0));

  assert.match(container.innerHTML, /cd-code/, "缺少 totalCode 时仍须渲染 Code 卡片");
  assert.match(container.innerHTML, />0</, "缺少 totalCode 时安全降级为 0");
});

// ── 2. 来源图层：河流图 (Streamgraph) 消费 daily.kinds.code ──
test("createAgentAnalytics renders Code source layer in streamgraph legend", () => {
  const originalDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const el = new MockElement(tag);
      let htmlVal = "";
      Object.defineProperty(el, "innerHTML", {
        get() { return htmlVal; },
        set(val) {
          htmlVal = String(val);
          el.textContent = htmlVal.replace(/<[^>]+>/g, " ");
          if (htmlVal.includes("agent-heatmap-container")) {
            const heatBox = new MockElement("div");
            heatBox.className = "agent-heatmap-container";
            el.appendChild(heatBox);
          }
          if (htmlVal.includes("stream-controls")) {
            const btnAgent = new MockElement("button");
            btnAgent.className = "btn btn-xs active";
            btnAgent.dataset.dim = "agent";

            const btnKind = new MockElement("button");
            btnKind.className = "btn btn-xs";
            btnKind.dataset.dim = "kind";

            const btnAbs = new MockElement("button");
            btnAbs.className = "btn btn-xs active";
            btnAbs.dataset.scale = "abs";

            const btnPct = new MockElement("button");
            btnPct.className = "btn btn-xs";
            btnPct.dataset.scale = "pct";

            const chartBox = new MockElement("div");
            chartBox.className = "stream-chart-container";

            const legendBox = new MockElement("div");
            legendBox.className = "stream-legend";

            el.appendChild(btnAgent);
            el.appendChild(btnKind);
            el.appendChild(btnAbs);
            el.appendChild(btnPct);
            el.appendChild(chartBox);
            el.appendChild(legendBox);
          }
        },
      });
      return el;
    },
    createElementNS(ns, tag) {
      return new MockElement(tag);
    },
  };

  try {
    const container = new MockElement("div");
    const testData = {
      visualAnalytics: {
        daily: [
          {
            date: "2026-10-25",
            totalTokens: 12000,
            kinds: {
              desktop: 5000,
              channel: 3000,
              code: 4000,
            },
          },
        ],
        agents: [],
      },
    };

    createAgentAnalytics({
      container,
      getData: () => testData,
    });

    // 切换到按来源图层
    const kindBtn = container.querySelectorAll("[data-dim]").find((b) => b.dataset.dim === "kind");
    assert.ok(kindBtn, "应存在按来源切换按钮");
    kindBtn.onclick();

    // 检查图例中是否包含 Code 来源名称
    const legendItems = container.querySelectorAll(".legend-item");
    const hasCodeLegend = legendItems.some((el) => /\bCode\b/i.test(el.innerHTML || el.textContent)) ||
      container.querySelectorAll("div").some((el) => el.innerHTML?.includes("Code:"));
    assert.ok(hasCodeLegend, "用量全景河流图按来源划分时必须包含 Code 图层图例");
  } finally {
    globalThis.document = originalDoc;
  }
});

// ── 3. 明细排障：渲染 Code 来源标签与 CSV 导出强制断言 ──
test("createTurnsInspector displays Code badge and forwards type=code filter to CSV calls", async () => {
  const originalDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const el = new MockElement(tag);
      return el;
    },
  };

  try {
    const container = new MockElement("div");
    let fetchedUrl = "";
    let exportUrl = "";

    const inspector = createTurnsInspector({
      container,
      fetchFn: async (url, opts) => {
        if (url.startsWith("/turns?")) {
          fetchedUrl = url;
          return {
            ok: true,
            json: async () => ({
              total: 1,
              sumTokens: 1000,
              totalPages: 1,
              rows: [
                {
                  at: "2026-10-25T10:00:00Z",
                  agent: "sol-architect",
                  type: "code",
                  provider: "deepseek",
                  model: "deepseek-reasoner",
                  input: 800,
                  output: 200,
                  cacheRead: 500,
                  total: 1500,
                },
              ],
            }),
          };
        }
        if (url.startsWith("/turns/export?")) {
          exportUrl = url;
          return {
            ok: true,
            json: async () => ({ saved: true, path: "/exports/test.csv", rowCount: 1 }),
          };
        }
        return { ok: false };
      },
      getFilters: () => ({ type: "code", range: "today" }),
    });

    // 允许异步 fetchTurns 与 json 解析多轮 tick 推进完毕
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // 验证请求参数带了 type=code
    assert.ok(fetchedUrl.includes("type=code"), "明细列表请求必须包含 type=code 过滤参数");

    // 验证渲染的明细中含有 Code 标签
    const findTable = (node) => {
      if (!node) return "";
      if (node.innerHTML?.includes("turns-table") || node.className?.includes("turns-table-wrap")) return node.innerHTML;
      for (const ch of node.children || []) {
        const found = findTable(ch);
        if (found) return found;
      }
      return "";
    };
    const htmlContent = findTable(container);
    assert.match(htmlContent, /source-code/, "明细表格中应当包含 .source-code 标签");
    assert.match(htmlContent, />Code</, "明细表格中应当展示 Code 文本");

    // 强制断言实际渲染的导出按钮（必须为真实 BUTTON 标签，绝非凭空 mock），无条件触发点击
    const exportBtn = container.querySelectorAll(".turns-export-btn")[0];
    assert.ok(exportBtn, "必须在 DOM 中找到实际的 turns-export-btn 按钮");
    assert.equal(exportBtn.tagName, "BUTTON", "实际导出的元素标签必须严格为 BUTTON");
    assert.equal(typeof exportBtn.onclick, "function", "turns-export-btn 必须绑定 onclick 函数");
    await exportBtn.onclick();
    assert.ok(exportUrl.startsWith("/turns/export?"), "导出请求必须发起 /turns/export");
    assert.ok(exportUrl.includes("type=code"), "导出 CSV 请求必须透传 type=code 参数");
  } finally {
    globalThis.document = originalDoc;
  }
});

// ── 4. 真实生产 renderSourceNotice 运行断言（拒绝 evaluateNoticeState 自证） ──
test("production renderSourceNotice toggles actual DOM notice based on D.sourceClassification", () => {
  const match = appJsSource.match(/function renderSourceNotice\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "源码中必须包含 renderSourceNotice 函数");

  const noticeEl = {
    style: { display: "" },
    textContent: "",
  };

  const sandbox = {
    $: (id) => (id === "source-classification-notice" ? noticeEl : null),
    D: null,
  };

  const renderSourceNotice = vm.runInNewContext(`${match[0]}; renderSourceNotice;`, sandbox);
  assert.equal(typeof renderSourceNotice, "function", "必须成功取得生产 renderSourceNotice 函数");

  // 1. complete 状态（对象）：隐藏提示
  sandbox.D = { sourceClassification: { status: "complete", unresolvedSessionCount: 0 } };
  noticeEl.style.display = "block";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "none", "complete 状态必须隐藏提示");

  // 2. complete 状态（字符串）：隐藏提示
  sandbox.D = { sourceClassification: "complete" };
  noticeEl.style.display = "block";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "none", "complete 字符串状态必须隐藏提示");

  // 3. partial 状态：必须显示文案
  sandbox.D = { sourceClassification: { status: "partial", unresolvedSessionCount: 2 } };
  noticeEl.style.display = "none";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "block", "partial 状态必须显示提示");
  assert.equal(noticeEl.textContent, "部分历史会话无法识别来源，Code 分类可能不完整。");

  // 4. unavailable 状态：必须显示文案
  sandbox.D = { sourceClassification: { status: "unavailable" } };
  noticeEl.style.display = "none";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "block", "unavailable 状态必须显示提示");
  assert.equal(noticeEl.textContent, "部分历史会话无法识别来源，Code 分类可能不完整。");

  // 5. 缺字段（undefined）：绝不能假装完整，必须显示
  sandbox.D = {};
  noticeEl.style.display = "none";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "block", "缺少 sourceClassification 必须降级显示提示");
  assert.equal(noticeEl.textContent, "部分历史会话无法识别来源，Code 分类可能不完整。");

  // 6. null 状态：必须显示
  sandbox.D = { sourceClassification: null };
  noticeEl.style.display = "none";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "block", "null 状态必须降级显示提示");
  assert.equal(noticeEl.textContent, "部分历史会话无法识别来源，Code 分类可能不完整。");

  // 7. 未知对象结构：必须显示
  sandbox.D = { sourceClassification: { unknownKey: true } };
  noticeEl.style.display = "none";
  renderSourceNotice();
  assert.equal(noticeEl.style.display, "block", "未知对象结构必须降级显示提示");
  assert.equal(noticeEl.textContent, "部分历史会话无法识别来源，Code 分类可能不完整。");
});

// ── 5. 触发类型筛选生产事件链路并捕获 load 请求 query ──
test("production filter dropdown onSelect updates selection text and triggers load with type parameter", () => {
  const onSelectMatch = appJsSource.match(/onSelect:\s*(function\(item\)\s*\{[\s\S]*?\n  \})/);
  assert.ok(onSelectMatch, "必须提取到 initFilterDropdowns 的生产 onSelect 回调");

  const loadStart = appJsSource.indexOf("function load(refreshFirst)");
  const localTimeStart = appJsSource.indexOf("function localTime(value)");
  assert.ok(loadStart !== -1 && localTimeStart !== -1, "必须定位到生产 load 函数");
  const loadSrc = appJsSource.slice(loadStart, localTimeStart);

  const stypeTxt = { textContent: "类型" };
  const stypeEl = {
    querySelector: (sel) => (sel === ".cs-txt" ? stypeTxt : null),
  };

  let requestedUrl = "";

  const sandbox = {
    _selType: "",
    _selAgent: "",
    _selProvider: "",
    _selModel: "",
    _loadSequence: 0,
    _closed: false,
    R: "today",
    D: {},
    $: (id) => {
      if (id === "stype") return stypeEl;
      if (id === "df") return { value: "" };
      if (id === "dt") return { value: "" };
      if (id === "ld") return { textContent: "", style: {} };
      return null;
    },
    window: { location: { search: "" } },
    trackerFetch: (url) => {
      requestedUrl = url;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    render: () => {},
    renderStatus: () => {},
  };

  const script = `${loadSrc};\nvar onSelect = ${onSelectMatch[1]};`;
  vm.runInNewContext(script, sandbox);
  assert.equal(typeof sandbox.onSelect, "function", "必须取得生产 onSelect 处理器");

  // 1. 触发选择 Code
  sandbox.onSelect({ name: "stype", value: "code", label: "Code" });
  assert.equal(sandbox._selType, "code", "内部状态 _selType 必须更新为 code");
  assert.equal(stypeTxt.textContent, "Code", "界面文字必须更新为 Code");
  assert.ok(requestedUrl.includes("&type=code"), "load 触发的请求必须带 &type=code 参数");

  // 2. 切换到 聊天 (desktop)
  sandbox.onSelect({ name: "stype", value: "desktop", label: "聊天" });
  assert.equal(sandbox._selType, "desktop");
  assert.equal(stypeTxt.textContent, "聊天");
  assert.ok(requestedUrl.includes("&type=desktop"), "load 触发的请求必须带 &type=desktop 参数");

  // 3. 切换到 频道 (channel)
  sandbox.onSelect({ name: "stype", value: "channel", label: "频道" });
  assert.equal(sandbox._selType, "channel");
  assert.equal(stypeTxt.textContent, "频道");
  assert.ok(requestedUrl.includes("&type=channel"), "load 触发的请求必须带 &type=channel 参数");

  // 4. 切回 全部 ("")
  sandbox.onSelect({ name: "stype", value: "", label: "全部" });
  assert.equal(sandbox._selType, "");
  assert.equal(stypeTxt.textContent, "类型");
  assert.ok(!requestedUrl.includes("&type="), "全部选项时不应包含 &type= 参数");
});

// ── 6. 真实运行生产 renderTrend：Chart stub 捕获 daily / daily30 / hourly fixture ──
test("production renderTrend captures Chart datasets across daily, daily30 and hourly fixtures", () => {
  const trendStart = appJsSource.indexOf("function renderTrend()");
  const modelStart = appJsSource.indexOf("function renderModel()");
  assert.ok(trendStart !== -1 && modelStart !== -1, "必须定位到生产 renderTrend 函数");
  const renderTrendSrc = appJsSource.slice(trendStart, modelStart);

  let capturedConfig = null;
  class ChartStub {
    constructor(canvas, config) {
      capturedConfig = config;
    }
    destroy() {}
  }

  const titleEl = { textContent: "", appendChild() {}, querySelector() { return null; } };
  const canvasEl = { id: "tc" };

  const sandbox = {
    tc: null,
    Chart: ChartStub,
    chartColors: () => ({
      chat: "#007AFF",
      channel: "#5AC8FA",
      code: "#8B5CF6",
      doughnut: ["#1", "#2", "#3", "#4", "#5"],
      hitRate: "#34C759",
      text: "#000",
      grid: "#eee",
    }),
    isHourlyMode: () => sandbox.useHourlyFlag,
    useHourlyFlag: false,
    D: null,
    R: "today",
    _trendMode: "scene",
    localStorage: { getItem: () => "scene", setItem: () => {} },
    document: {
      createElement: () => ({
        className: "",
        innerHTML: "",
        addEventListener: () => {},
        querySelectorAll: () => [],
      }),
    },
    $: (id) => (id === "tc-title" ? titleEl : id === "tc" ? canvasEl : null),
    Date: Date,
  };

  vm.runInNewContext(`${renderTrendSrc};\nrenderTrend;`, sandbox);
  assert.equal(typeof sandbox.renderTrend, "function", "必须取得生产 renderTrend 函数");

  // ── Fixture A: daily 日趋势（多日不同非零值）──
  sandbox.useHourlyFlag = false;
  sandbox.R = "today";
  sandbox.D = {
    daily: [
      { date: "2026-10-23", desktop: 110, channel: 50, code: 230 },
      { date: "2026-10-24", desktop: 140, channel: 80, code: 310 },
      { date: "2026-10-25", desktop: 200, channel: 90, code: 450 },
    ],
  };
  sandbox.renderTrend();

  assert.equal(capturedConfig.type, "bar");
  assert.deepEqual(capturedConfig.data.labels, ["10-23", "10-24", "10-25"]);
  assert.equal(capturedConfig.data.datasets.length, 3, "必须包含聊天、频道、Code 3 个数据系列");

  const dailyDesk = capturedConfig.data.datasets.find((d) => d.label === "聊天");
  const dailyChan = capturedConfig.data.datasets.find((d) => d.label === "频道");
  const dailyCode = capturedConfig.data.datasets.find((d) => d.label === "Code");

  assert.deepEqual(dailyDesk.data, [110, 140, 200], "聊天数值必须完整保留");
  assert.deepEqual(dailyChan.data, [50, 80, 90], "频道数值必须完整保留");
  assert.deepEqual(dailyCode.data, [230, 310, 450], "Code 数值必须精准进入对应日期");
  assert.equal(dailyCode.backgroundColor, "#8B5CF6", "Code 系列必须使用专用主题色");

  // ── Fixture B: daily30 完整 30 天非零数据 ──
  const daily30Fixture = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    desktop: (i + 1) * 10,
    channel: (i + 1) * 5,
    code: (i + 1) * 25,
  }));
  sandbox.useHourlyFlag = false;
  sandbox.R = "today";
  sandbox.D = { daily: daily30Fixture };
  sandbox.renderTrend();

  const d30Code = capturedConfig.data.datasets.find((d) => d.label === "Code");
  const d30Desk = capturedConfig.data.datasets.find((d) => d.label === "聊天");
  const d30Chan = capturedConfig.data.datasets.find((d) => d.label === "频道");

  assert.equal(d30Code.data.length, 30, "30 天数据必须全部进入 Code 数据系列");
  assert.deepEqual(d30Code.data, daily30Fixture.map((d) => d.code));
  assert.deepEqual(d30Desk.data, daily30Fixture.map((d) => d.desktop));
  assert.deepEqual(d30Chan.data, daily30Fixture.map((d) => d.channel));

  // ── Fixture C: hourly 小时级趋势（单日 24 小时非零数据）──
  const hourlyFixture = [
    { hour: "08", desktop: 15, channel: 8, code: 42 },
    { hour: "09", desktop: 60, channel: 20, code: 105 },
    { hour: "10", desktop: 95, channel: 35, code: 160 },
    { hour: "11", desktop: 130, channel: 50, code: 220 },
  ];
  sandbox.useHourlyFlag = true;
  sandbox.D = { hourly: hourlyFixture };
  sandbox.renderTrend();

  assert.equal(titleEl.textContent, "消耗趋势（按小时）", "小时模式下标题须切换为按小时");
  assert.deepEqual(capturedConfig.data.labels, ["08:00", "09:00", "10:00", "11:00"]);

  const hrDesk = capturedConfig.data.datasets.find((d) => d.label === "聊天");
  const hrChan = capturedConfig.data.datasets.find((d) => d.label === "频道");
  const hrCode = capturedConfig.data.datasets.find((d) => d.label === "Code");

  assert.deepEqual(hrDesk.data, [15, 60, 95, 130]);
  assert.deepEqual(hrChan.data, [8, 20, 35, 50]);
  assert.deepEqual(hrCode.data, [42, 105, 160, 220], "Code 数值必须精准进入各小时");
});

// ── 7. 样式与主题别名断言 ──
test("ui/theme.css and ui/base.css define Code styling and theme aliases", () => {
  const themeCss = fs.readFileSync(path.join(rootDir, "ui/theme.css"), "utf-8");
  const baseCss = fs.readFileSync(path.join(rootDir, "ui/base.css"), "utf-8");

  assert.match(themeCss, /--chart-bar-code:\s*var\(--purple\);/);
  assert.match(baseCss, /\.cd-code/);
  assert.match(baseCss, /\.source-tag\.source-code/);
  assert.match(baseCss, /\.source-notice/);
});

// ── 8. 版本与静态入口一致性 6.9.1 ──
test("Version manifests, entries and static links are unified to 6.9.1", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf-8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  const indexHtml = fs.readFileSync(path.join(rootDir, "ui/index.html"), "utf-8");
  const v691HtmlPath = path.join(rootDir, "ui/dashboard-v6.9.1.html");
  const fnPanelHtml = fs.readFileSync(path.join(rootDir, "ui/function-panel.html"), "utf-8");

  assert.equal(manifest.version, "6.9.1", "manifest.json 版本必须为 6.9.1");
  assert.equal(pkg.version, "6.9.1", "package.json 版本必须为 6.9.1");
  assert.equal(manifest.contributes.cards[0].route, "/dashboard-v6.9.1.html", "主卡入口必须指向 dashboard-v6.9.1.html");

  assert.ok(fs.existsSync(v691HtmlPath), "ui/dashboard-v6.9.1.html 必须存在");
  const v691Html = fs.readFileSync(v691HtmlPath, "utf-8");
  assert.equal(v691Html, indexHtml, "dashboard-v6.9.1.html 内容必须与 ui/index.html 严格一致");
  assert.match(indexHtml, /data-ui-version="6\.9\.1"/, "ui/index.html 必须标记 6.9.1");
  assert.match(fnPanelHtml, /v6\.9\.1/, "ui/function-panel.html 必须展示 v6.9.1");
});
