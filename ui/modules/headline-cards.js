// ui/modules/headline-cards.js — 核心用量指标卡片渲染

export function renderHeadlineCards(container, summary = {}, fmt = (n) => String(n ?? 0)) {
  if (!container) return;

  const totalTokens = fmt(summary.totalTokens);
  const totalDesktop = fmt(summary.totalDesktop);
  const totalChannel = fmt(summary.totalChannel);
  const totalOutput = fmt(summary.totalOutput);
  const totalInput = fmt(summary.totalInput);
  const totalCacheRead = fmt(summary.totalCacheRead);
  const cacheHitRate = (summary.cacheHitRate || 0) + "%";

  container.innerHTML =
    '<div class="cd cd-total"><div class="cl">总消耗</div><div class="cv">' + totalTokens + '</div></div>' +
    '<div class="cd cd-chat"><div class="cl">聊天</div><div class="cv">' + totalDesktop + '</div></div>' +
    '<div class="cd cd-channel"><div class="cl">频道</div><div class="cv">' + totalChannel + '</div></div>' +
    '<div class="cd cd-output"><div class="cl">输出</div><div class="cv">' + totalOutput + '</div></div>' +
    '<div class="cd cd-input"><div class="cl">输入(未命中)</div><div class="cv">' + totalInput + '</div></div>' +
    '<div class="cd cd-cache"><div class="cl">输入(命中)</div><div class="cv">' + totalCacheRead + '</div></div>' +
    '<div class="cd cd-hitrate"><div class="cl">缓存命中率</div><div class="cv">' + cacheHitRate + '</div></div>';

  const items = container.children;
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    el.style.animation = "tt-fade-up .45s " + (0.05 + i * 0.05) + "s ease-out backwards";
    el.addEventListener("animationend", function (ev) {
      ev.currentTarget.style.animation = "";
    }, { once: true });
  }
}
