import test from "node:test";
import assert from "node:assert/strict";
import { createAgentAnalytics } from "../ui/modules/agent-analytics.js";

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

class MockElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._className = "";
    this.classList = new MockClassList();
    this.innerHTML = "";
    this.onclick = null;
  }

  set className(val) {
    this._className = val;
    this.classList = new MockClassList(val);
  }
  get className() {
    return Array.from(this.classList.classes).join(" ");
  }

  appendChild(child) {
    this.children.push(child);
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      if (selector === "[data-dim]" && node.dataset.dim) results.push(node);
      if (selector === "[data-scale]" && node.dataset.scale) results.push(node);
      for (const ch of node.children) walk(ch);
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || new MockElement();
  }
}

test("streamgraph buttons toggle active class on click", () => {
  const originalDoc = globalThis.document;

  const createdButtons = [];
  globalThis.document = {
    createElement(tag) {
      const el = new MockElement(tag);
      return el;
    },
  };

  try {
    const container = new MockElement("div");

    // 构造模拟的 visualAnalytics 数据
    const mockData = {
      visualAnalytics: {
        agents: [{ id: "ag-1", days: { "2026-10-08": 100 }, totalTokens: 100 }],
        daily: [{ date: "2026-10-08", total: 100 }],
      },
    };

    // 拦截 streamPanel.innerHTML 设置，手动挂载 4 个切换按钮以支持 querySelectorAll
    const origCreateElement = globalThis.document.createElement;
    let streamPanelRef = null;
    let btnAgent, btnKind, btnAbs, btnPct;

    globalThis.document.createElement = (tag) => {
      const el = origCreateElement(tag);
      let htmlVal = "";
      Object.defineProperty(el, "innerHTML", {
        get() { return htmlVal; },
        set(val) {
          htmlVal = val;
          if (val.includes("stream-controls")) {
            streamPanelRef = el;
            btnAgent = new MockElement("button");
            btnAgent.className = "btn btn-xs active";
            btnAgent.dataset.dim = "agent";

            btnKind = new MockElement("button");
            btnKind.className = "btn btn-xs";
            btnKind.dataset.dim = "kind";

            btnAbs = new MockElement("button");
            btnAbs.className = "btn btn-xs active";
            btnAbs.dataset.scale = "abs";

            btnPct = new MockElement("button");
            btnPct.className = "btn btn-xs";
            btnPct.dataset.scale = "pct";

            el.appendChild(btnAgent);
            el.appendChild(btnKind);
            el.appendChild(btnAbs);
            el.appendChild(btnPct);
          }
        },
      });
      return el;
    };

    createAgentAnalytics({
      container,
      getData: () => mockData,
    });

    // 初始状态校验
    assert.equal(btnAgent.classList.contains("active"), true);
    assert.equal(btnKind.classList.contains("active"), false);
    assert.equal(btnAbs.classList.contains("active"), true);
    assert.equal(btnPct.classList.contains("active"), false);

    // 1. 点击“按来源”
    btnKind.onclick();
    assert.equal(btnAgent.classList.contains("active"), false, "点击按来源后，按 Agent 应失去 active");
    assert.equal(btnKind.classList.contains("active"), true, "点击按来源后，按来源应获得 active");

    // 2. 点击“占比”
    btnPct.onclick();
    assert.equal(btnAbs.classList.contains("active"), false, "点击占比后，总量应失去 active");
    assert.equal(btnPct.classList.contains("active"), true, "点击占比后，占比应获得 active");

    // 3. 点击回“按 Agent”和“总量”
    btnAgent.onclick();
    btnAbs.onclick();
    assert.equal(btnAgent.classList.contains("active"), true);
    assert.equal(btnKind.classList.contains("active"), false);
    assert.equal(btnAbs.classList.contains("active"), true);
    assert.equal(btnPct.classList.contains("active"), false);
  } finally {
    globalThis.document = originalDoc;
  }
});
