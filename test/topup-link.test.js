import test from "node:test";
import assert from "node:assert/strict";
import { TOPUP_URLS, openExternal } from "../ui/external-link.js";
import { renderDeepSeekCard } from "../ui/modules/deepseek-card.js";
import { renderLithosCard } from "../ui/modules/lithos-card.js";

// 卡片用 innerHTML 渲染，测试里用一个会「解析」出按钮的假容器，
// 这样断言的是「渲染完真的能点到按钮」，而不是只 grep 了一下字符串。
function mkContainer() {
  const clicks = [];
  const el = {
    _html: "",
    style: {},
    parentElement: { style: { display: "" } },
    set innerHTML(v) {
      el._html = v;
    },
    get innerHTML() {
      return el._html;
    },
    closest() {
      return el;
    },
    querySelector(sel) {
      if (sel !== "[data-topup]") return null;
      const m = /data-topup="([^"]+)"/.exec(el._html);
      if (!m) return null;
      return {
        getAttribute: (k) => (k === "data-topup" ? m[1] : null),
        addEventListener: (_t, fn) => clicks.push(fn),
      };
    },
  };
  el._clicks = clicks;
  return el;
}

function withWindow(win, fn) {
  const original = globalThis.window;
  globalThis.window = win;
  try {
    return fn();
  } finally {
    globalThis.window = original;
  }
}

const CONNECTED_DS = {
  connected: true,
  currency: "CNY",
  symbol: "¥",
  display: "¥14.96",
  granted: 0,
  grantedBalance: "0.00",
};

const CONNECTED_LITHOS = {
  connected: true,
  currency: "USD",
  display: "$21.91",
  onHold: false,
  organization: { name: "示例组织" },
};

test("两张余额卡都能点到充值按钮，各自跳自己的控制台", () => {
  const opened = [];
  const win = { hana: { external: { open: (u) => opened.push(u) } } };

  withWindow(win, () => {
    const ds = mkContainer();
    renderDeepSeekCard(ds, CONNECTED_DS);
    assert.match(ds.innerHTML, /data-topup="deepseek"/);
    ds._clicks[0]({ preventDefault() {} });

    const lit = mkContainer();
    renderLithosCard(lit, CONNECTED_LITHOS);
    assert.match(lit.innerHTML, /data-topup="lithos"/);
    lit._clicks[0]({ preventDefault() {} });
  });

  assert.deepEqual(opened, [TOPUP_URLS.deepseek, TOPUP_URLS.lithos]);
  assert.equal(TOPUP_URLS.deepseek, "https://platform.deepseek.com/top_up");
  assert.equal(TOPUP_URLS.lithos, "https://console.lithosai.cloud/billing/general");
});

test("宿主没有 external.open 时退到 window.open，不至于点了没反应", () => {
  const opened = [];
  const win = {
    hana: {},
    open: (url, target) => {
      opened.push([url, target]);
      return null;
    },
  };
  withWindow(win, () => openExternal(TOPUP_URLS.deepseek));
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], TOPUP_URLS.deepseek);
  assert.equal(opened[0][1], "_blank");
});

test("宿主接口抛错也会兜到 window.open", () => {
  const opened = [];
  const win = {
    hana: {
      external: {
        open: () => {
          throw new Error("denied");
        },
      },
    },
    open: (url) => opened.push(url),
  };
  withWindow(win, () => openExternal(TOPUP_URLS.lithos));
  assert.deepEqual(opened, [TOPUP_URLS.lithos]);
});

test("查不到余额时不摆充值按钮（那时该修的是 key / Cookie，不是钱）", () => {
  const container = mkContainer();
  renderDeepSeekCard(container, { connected: false, reason: "unauthorized", message: "DeepSeek API Key 无效" });
  assert.doesNotMatch(container.innerHTML, /data-topup/);
  assert.equal(container._clicks.length, 0);

  const lithos = mkContainer();
  renderLithosCard(lithos, { connected: false, reason: "session_expired", message: "会话过期" });
  assert.doesNotMatch(lithos.innerHTML, /data-topup/);
  assert.equal(lithos._clicks.length, 0);
});
