// ui/external-link.js — 在宿主里开外部链接
//
// 为什么需要这层：看板跑在宿主的 iframe 里，直接 window.open 可能被沙箱拦掉，
// 而且拦掉的表现为「点了没反应」，用户根本看不出是没开还是开失败了。
// 所以优先走宿主提供的 hana.external.open，拿不到这个能力时才退到 window.open。
//
// 充值地址集中在这里，一是两处复用，二是测试能直接盯住这两个字符串，
// 避免哪天改地址时改了卡片却没改文档。

export const TOPUP_URLS = {
  // 官方 DeepSeek：控制台的充值页。这个站是 SPA，路径写错也只会落到控制台首页，
  // 不会 404 —— 实测 /top_up、/usage、/api_keys 都返回 200。
  deepseek: "https://platform.deepseek.com/top_up",
  // Lithos 控制台：计费页。实测未登录时会 302 到 /login?next=/billing/general，
  // 说明路由存在；登录态下直接落在「余额 / 消费 / 付款记录」这一页，充值按钮就在上面。
  lithos: "https://console.lithosai.cloud/billing/general",
};

export function openExternal(url) {
  if (!url) return;
  const fallback = () => {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      try {
        window.hana?.toast?.show?.(`请手动打开：${url}`);
      } catch {}
    }
  };

  const api = window.hana?.external?.open;
  if (typeof api !== "function") {
    fallback();
    return;
  }
  try {
    const p = api(url);
    if (p && typeof p.catch === "function") p.catch(fallback);
  } catch {
    fallback();
  }
}

// 卡片用 innerHTML 渲染，按钮绑定要在渲染之后做，所以单独暴露一个挂载函数。
export function bindTopup(container) {
  const btn = container?.querySelector?.("[data-topup]");
  if (!btn || typeof btn.addEventListener !== "function") return;
  btn.addEventListener("click", (e) => {
    e?.preventDefault?.();
    const key = btn.getAttribute("data-topup");
    openExternal(TOPUP_URLS[key] || btn.getAttribute("data-topup-url") || "");
  });
}

export default { TOPUP_URLS, openExternal, bindTopup };
