// Gemini 算力池纯渲染卡与双端共享加载控制器。
// 只接收后端归一化 DTO，不接触 CPA、管理密钥或原始响应。

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sectionFor(container) {
  if (!container) return null;
  if (typeof container.closest === "function") {
    const section = container.closest(".gemini-pool-section");
    if (section) return section;
  }
  return container.parentElement || null;
}

function healthLabel(value) {
  switch (value) {
    case "healthy": return "账号正常";
    case "disabled": return "账号已禁用";
    case "unavailable": return "账号不可用";
    default: return "账号状态未知";
  }
}

function quotaLabel(value) {
  switch (value) {
    case "ok": return "配额正常";
    case "missing_project": return "缺少项目";
    case "error": return "配额查询失败";
    case "empty": return "暂无配额";
    case "timeout": return "查询超时";
    case "not_checked": return "尚未检查配额";
    default: return "配额状态未知";
  }
}

function safeNow(value) {
  const numeric = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function resetLabel(value, now) {
  if (value == null || value === "") return "重置时间未知";
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return "重置时间未知";
  if (timestamp <= now) return "待刷新";

  const minutes = Math.max(1, Math.ceil((timestamp - now) / 60000));
  if (minutes < 60) return `${minutes}m后重置`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return `${hours}h${remainder ? `${remainder}m` : ""}后重置`;
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return `${days}d${hourRemainder ? `${hourRemainder}h` : ""}后重置`;
}

function fractionValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function renderMessageCard(message) {
  return `<div class="gemini-pool-card gemini-pool-card-message">
    <div class="gemini-pool-header">
      <div>
        <div class="gemini-pool-title">Gemini 算力池</div>
        <div class="gemini-pool-subtitle">Antigravity共享配额</div>
      </div>
    </div>
    <div class="gemini-pool-message">${esc(message)}</div>
  </div>`;
}

function renderBucket(bucket, now) {
  if (!bucket || typeof bucket !== "object") return "";
  const fraction = fractionValue(bucket.remainingFraction);
  if (fraction === null) return "";
  const percent = Math.round(fraction * 100);
  const label = bucket.label == null || bucket.label === "" ? "未命名配额" : bucket.label;
  return `<div class="gemini-bucket">
    <div class="gemini-bucket-row">
      <span class="gemini-bucket-label">${esc(label)}</span>
      <span class="gemini-bucket-value">${percent}%</span>
    </div>
    <div class="gemini-bucket-track" aria-hidden="true"><div class="gemini-bucket-fill" style="width:${percent}%"></div></div>
    <div class="gemini-bucket-reset">${resetLabel(bucket.resetTime, now)}</div>
  </div>`;
}

function renderAccount(account, now) {
  const label = account?.label == null || account.label === "" ? "匿名账号" : account.label;
  const groups = Array.isArray(account?.groups) ? account.groups : [];
  let groupsHtml = "";

  for (const group of groups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const bucketsHtml = buckets.map((bucket) => renderBucket(bucket, now)).filter(Boolean).join("");
    if (!bucketsHtml) continue;
    const groupLabel = group?.label == null || group.label === "" ? "未命名分组" : group.label;
    groupsHtml += `<div class="gemini-group">
      <div class="gemini-group-label">${esc(groupLabel)}</div>
      ${bucketsHtml}
    </div>`;
  }

  if (!groupsHtml) {
    groupsHtml = `<div class="gemini-account-empty">暂无可展示的分组配额</div>`;
  }

  return `<div class="gemini-account">
    <div class="gemini-account-header">
      <span class="gemini-account-label">${esc(label)}</span>
      <span class="gemini-status gemini-health-status">${healthLabel(account?.health)}</span>
      <span class="gemini-status gemini-quota-status">${quotaLabel(account?.quotaStatus)}</span>
    </div>
    <div class="gemini-account-groups">${groupsHtml}</div>
  </div>`;
}

function safeReasonMessage(reason, connected) {
  switch (reason) {
    case "missing_project": return "缺少项目，暂时无法查询配额。";
    case "unauthorized":
    case "forbidden": return "管理鉴权受限，请检查密钥和远程管理，再重新保存配置";
    case "rate_limited": return "请求受限，请稍后重试。";
    case "timeout": return "配额查询超时，请稍后重试。";
    case "empty": return "暂无可展示的 Antigravity 账号。";
    case "request_failed":
    default:
      return connected === false ? "暂时无法读取 Gemini 算力池，请稍后重试。" : "暂无可展示的 Antigravity 账号。";
  }
}

function renderConfiguredCard(dto, now) {
  const accounts = Array.isArray(dto?.accounts) ? dto.accounts : [];
  if (!accounts.length) {
    return renderMessageCard(safeReasonMessage(dto?.reason, dto?.connected));
  }

  const accountHtml = accounts.map((account) => renderAccount(account, now)).join("");
  const connectionHint = dto?.connected === false
    ? `<div class="gemini-pool-message gemini-pool-inline-message">部分账号结果可用，连接状态仍需检查。</div>`
    : "";
  return `<div class="gemini-pool-card">
    <div class="gemini-pool-header">
      <div>
        <div class="gemini-pool-title">Gemini 算力池</div>
        <div class="gemini-pool-subtitle">Antigravity共享配额</div>
      </div>
      <span class="gemini-account-count">${accounts.length} 个账号</span>
    </div>
    ${connectionHint}
    <div class="gemini-accounts">${accountHtml}</div>
  </div>`;
}

/**
 * 纯渲染 Gemini 卡片。外部 label 全部转义，账号百分比不做跨账号聚合。
 */
export function renderGeminiCard(container, dto, { now = Date.now() } = {}) {
  if (!container) return;
  const section = sectionFor(container);
  const configured = dto?.configured === true;
  if (!configured) {
    container.innerHTML = "";
    if (section?.style) section.style.display = "none";
    return;
  }

  if (section?.style) section.style.display = "";
  container.innerHTML = renderConfiguredCard(dto, safeNow(now));
}

function errorDto(configured) {
  return {
    configured: configured === true,
    connected: false,
    reason: "request_failed",
    updatedAt: null,
    accounts: [],
  };
}

/**
 * 两端实际复用的轻量加载控制器。
 * load/refresh 共享在途请求；reload/hide 使旧响应失效，不添加轮询。
 */
export function createGeminiQuotaController({ container, fetchFn, onRendered, now = Date.now } = {}) {
  let sequence = 0;
  let inFlight = null;
  let disposed = false;
  let configuredState = null;

  function notify(dto) {
    try {
      renderGeminiCard(container, dto, { now: typeof now === "function" ? now() : now });
      if (typeof onRendered === "function") onRendered(dto);
    } catch {
      // 渲染错误不应阻断其他功能卡片。
    }
  }

  function start() {
    const requestSequence = ++sequence;
    let task;
    let failed = false;
    try {
      task = Promise.resolve(fetchFn("/gemini-quota"));
    } catch (error) {
      task = Promise.reject(error);
    }

    const promise = task
      .then(async (response) => {
        if (!response || response.ok === false) throw new Error("gemini_quota_request_failed");
        const dto = await response.json();
        if (!dto || typeof dto.configured !== "boolean") throw new Error("gemini_quota_invalid_response");
        return dto;
      })
      .catch(() => {
        failed = true;
        return errorDto(configuredState === true);
      })
      .then((dto) => {
        if (!disposed && requestSequence === sequence) {
          if (!failed && typeof dto.configured === "boolean") configuredState = dto.configured;
          notify(dto);
        }
        return dto;
      })
      .finally(() => {
        if (inFlight?.sequence === requestSequence) inFlight = null;
      });

    inFlight = { sequence: requestSequence, promise };
    return promise;
  }

  function load() {
    if (disposed) return Promise.resolve(null);
    if (inFlight) return inFlight.promise;
    return start();
  }

  return {
    load,
    refresh: load,
    reload({ hide = false, configured } = {}) {
      if (disposed) return Promise.resolve(null);
      if (typeof configured === "boolean") configuredState = configured;
      else if (hide) configuredState = false;
      sequence += 1;
      inFlight = null;
      if (hide || configuredState === false) notify({ configured: false, connected: false, accounts: [] });
      return start();
    },
    hide() {
      if (disposed) return;
      configuredState = false;
      sequence += 1;
      inFlight = null;
      notify({ configured: false, connected: false, accounts: [] });
    },
    dispose() {
      disposed = true;
      sequence += 1;
      inFlight = null;
    },
  };
}
