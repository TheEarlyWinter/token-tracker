function formatDuration(seconds) {
  if (typeof seconds !== "number" || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return `${h}h${m > 0 ? `${m}m` : ""}后重置`;
  }
  return `${m}m后重置`;
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return "";
  try {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) return String(expiresAt).slice(0, 10);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `有效期至 ${y}-${m}-${day}`;
  } catch {
    return String(expiresAt).slice(0, 10);
  }
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCodexQuotaCard(container, quotaData, handlers = {}) {
  if (!container) return;
  if (!quotaData || !quotaData.connected) {
    const msg = quotaData?.message || "未检测到 Codex 登录";
    container.innerHTML = `
      <div class="sb-codex-card sb-codex-dim">
        <div class="sb-codex-hdr">
          <span class="sb-codex-title">Codex 额度</span>
        </div>
        <div class="sb-codex-quiet">${esc(msg)}</div>
      </div>
    `;
    return;
  }

  const existingModal = typeof container.querySelector === "function"
    ? container.querySelector("#sb-codex-reset-modal")
    : null;
  const existingBadges = typeof container.querySelector === "function"
    ? container.querySelector(".sb-codex-badges")
    : null;
  const existingBody = typeof container.querySelector === "function"
    ? container.querySelector(".sb-codex-body")
    : null;
  const plan = quotaData.planLabel || quotaData.planType || "Codex";
  const credits = quotaData.resetCredits ?? 0;
  const creditsBalance = quotaData.creditsBalance;
  const primary = quotaData.primary;
  const secondary = quotaData.secondary;

  const priRem = primary?.remainingPercent != null ? Math.round(primary.remainingPercent) : null;
  const priReset = primary?.resetAfterSeconds ? formatDuration(primary.resetAfterSeconds) : "";
  const secRem = secondary?.remainingPercent != null ? Math.round(secondary.remainingPercent) : null;
  const secReset = secondary?.resetAfterSeconds ? formatDuration(secondary.resetAfterSeconds) : "";

  let primaryHtml = "";
  if (priRem !== null) {
    primaryHtml = `
      <div class="sb-codex-item">
        <div class="sb-codex-row">
          <span class="sb-codex-label">5h 窗口</span>
          <span class="sb-codex-val">${priRem}%</span>
        </div>
        <div class="sb-codex-track">
          <div class="sb-codex-bar" style="width:${Math.max(0, Math.min(100, priRem))}%"></div>
        </div>
        ${priReset ? `<div class="sb-codex-hint">${esc(priReset)}</div>` : ""}
      </div>
    `;
  }

  let secondaryHtml = "";
  if (secRem !== null) {
    secondaryHtml = `
      <div class="sb-codex-item">
        <div class="sb-codex-row">
          <span class="sb-codex-label">每周窗口</span>
          <span class="sb-codex-val">${secRem}%</span>
        </div>
        <div class="sb-codex-track">
          <div class="sb-codex-bar" style="width:${Math.max(0, Math.min(100, secRem))}%"></div>
        </div>
        ${secReset ? `<div class="sb-codex-hint">${esc(secReset)}</div>` : ""}
      </div>
    `;
  }

  if (existingBadges && existingBody) {
    const planBadge = Array.from(existingBadges.querySelectorAll(".sb-codex-badge"))
      .find((badge) => !String(badge.className || "").split(/\s+/).includes("sb-codex-bal-badge"));
    if (planBadge) planBadge.textContent = plan;

    const doc = container.ownerDocument || (typeof document !== "undefined" ? document : null);
    let balanceBadge = existingBadges.querySelector(".sb-codex-bal-badge");
    if (creditsBalance) {
      if (!balanceBadge && doc?.createElement) {
        balanceBadge = doc.createElement("span");
        balanceBadge.className = "sb-codex-badge sb-codex-bal-badge";
        balanceBadge.setAttribute("title", "账户余额");
        const currentToggle = existingBadges.querySelector("#sb-codex-credit-toggle");
        if (currentToggle && typeof existingBadges.insertBefore === "function") {
          existingBadges.insertBefore(balanceBadge, currentToggle);
        } else {
          existingBadges.appendChild(balanceBadge);
        }
      }
      if (balanceBadge) balanceBadge.textContent = creditsBalance;
    } else if (balanceBadge) {
      balanceBadge.remove();
    }

    let toggleBtn = existingBadges.querySelector("#sb-codex-credit-toggle");
    if (credits > 0) {
      if (!toggleBtn && doc?.createElement) {
        toggleBtn = doc.createElement("button");
        toggleBtn.setAttribute("type", "button");
        toggleBtn.className = "sb-codex-credit sb-codex-credit-btn";
        toggleBtn.setAttribute("id", "sb-codex-credit-toggle");
        toggleBtn.setAttribute("title", "点击查看并使用重置卡");
        existingBadges.appendChild(toggleBtn);
      }
      if (toggleBtn) toggleBtn.textContent = `卡 ${credits} ▾`;
    } else if (toggleBtn) {
      toggleBtn.remove();
    }

    existingBody.innerHTML = `${primaryHtml}${secondaryHtml}`;
    attachResetCreditsHandlers(container, handlers);
    return;
  }

  const balanceHtml = creditsBalance
    ? `<span class="sb-codex-badge sb-codex-bal-badge" title="账户余额">${esc(creditsBalance)}</span>`
    : "";

  const creditBtnHtml = credits > 0
    ? `<button type="button" class="sb-codex-credit sb-codex-credit-btn" id="sb-codex-credit-toggle" title="点击查看并使用重置卡">卡 ${credits} ▾</button>`
    : "";

  container.innerHTML = `
    <div class="sb-codex-card">
      <div class="sb-codex-hdr">
        <span class="sb-codex-title">Codex 额度</span>
        <div class="sb-codex-badges">
          <span class="sb-codex-badge">${esc(plan)}</span>
          ${balanceHtml}
          ${creditBtnHtml}
        </div>
      </div>
      <div class="sb-codex-body">
        ${primaryHtml}
        ${secondaryHtml}
      </div>
    </div>
    ${existingModal ? "" : '<div id="sb-codex-reset-modal" class="sb-codex-modal-overlay" style="display:none"></div>'}
  `;

  if (existingModal && typeof container.appendChild === "function") {
    container.appendChild(existingModal);
  }
  attachResetCreditsHandlers(container, handlers);
}

function attachResetCreditsHandlers(container, handlers) {
  if (!container || !handlers || typeof container.querySelector !== "function") return;
  const toggleBtn = container.querySelector("#sb-codex-credit-toggle");
  const modal = container.querySelector("#sb-codex-reset-modal");
  if (!toggleBtn || !modal) return;

  const { onFetchResetCredits, onConsumeResetCredit, onRefresh } = handlers;

  async function openModal() {
    if (typeof handlers.onOpenResetModal === "function") {
      try {
        const handled = await handlers.onOpenResetModal();
        if (handled) return;
      } catch {}
    }
    modal.style.display = "flex";
    return renderModalContent();
  }

  function closeModal() {
    modal.style.display = "none";
  }

  toggleBtn.onclick = openModal;

  modal.onclick = (e) => {
    if (e && e.target === modal) {
      closeModal();
    }
  };

  async function renderModalContent() {
    modal.innerHTML = `
      <div class="sb-codex-modal-dialog">
        <div class="sb-codex-modal-hdr">
          <span class="sb-codex-modal-title">限额重置卡</span>
          <button type="button" class="sb-codex-modal-close" id="sb-codex-modal-close-btn" title="关闭">×</button>
        </div>
        <div class="sb-codex-modal-body" id="sb-codex-reset-content">
          <div class="sb-codex-quiet" style="font-size:11px;padding:6px 0">正在加载重置卡...</div>
        </div>
      </div>
    `;

    const closeBtn = modal.querySelector("#sb-codex-modal-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", closeModal);
    }

    if (typeof onFetchResetCredits !== "function") {
      const contentEl = modal.querySelector("#sb-codex-reset-content");
      if (contentEl) contentEl.innerHTML = `<div class="sb-codex-quiet" style="font-size:11px;padding:4px 0">未配置重置卡加载函数</div>`;
      return;
    }

    try {
      const res = await onFetchResetCredits(false);
      const contentEl = modal.querySelector("#sb-codex-reset-content");
      if (!contentEl) return;

      if (!res || res.connected === false) {
        contentEl.innerHTML = `<div class="sb-codex-reset-msg is-err">${esc(res?.message || "无法获取重置卡列表")}</div>`;
        return;
      }

      const credits = Array.isArray(res.credits) ? res.credits : [];
      if (credits.length === 0) {
        contentEl.innerHTML = `<div class="sb-codex-quiet" style="font-size:11px;padding:4px 0">暂无可用的重置卡</div>`;
        return;
      }

      renderCreditsList(contentEl, credits);
    } catch (err) {
      const contentEl = modal.querySelector("#sb-codex-reset-content");
      if (contentEl) {
        contentEl.innerHTML = `<div class="sb-codex-reset-msg is-err">加载失败：${esc(err?.message || err)}</div>`;
      }
    }
  }

  function renderCreditsList(contentEl, credits) {
    let listHtml = `<div class="sb-codex-reset-list">`;
    for (const card of credits) {
      const isAvailable = card.status === "available";
      const expStr = formatExpiry(card.expiresAt);
      const sub = expStr || card.description || "";
      const displayTitle = card.title || (card.resetType === "fast" ? "快速窗口重置卡" : "限额重置卡");
      listHtml += `
        <div class="sb-reset-card ${!isAvailable ? 'is-spent' : ''}" data-card-id="${esc(card.id)}">
          <div class="sb-reset-card-info">
            <div class="sb-reset-card-header">
              <span class="sb-reset-card-name" title="${esc(displayTitle)}">${esc(displayTitle)}</span>
              <span class="sb-reset-card-status-pill ${isAvailable ? 'is-avail' : 'is-spent'}">${isAvailable ? '可用' : '已使用'}</span>
            </div>
            ${sub ? `<span class="sb-reset-card-sub" title="${esc(sub)}">${esc(sub)}</span>` : ''}
          </div>
          <div class="sb-reset-card-act" data-card-id="${esc(card.id)}">
            ${isAvailable
              ? `<button type="button" class="sb-reset-action-btn" data-act="prepare" data-credit-id="${esc(card.id)}">使用此卡</button>`
              : `<span class="sb-reset-spent-label">已使用</span>`
            }
          </div>
        </div>
      `;
    }
    listHtml += `</div><div id="sb-reset-feedback-slot"></div>`;
    contentEl.innerHTML = listHtml;

    attachCardListEvents(contentEl);
  }

  function attachCardListEvents(contentEl) {
    contentEl.querySelectorAll("[data-act='prepare']").forEach((btn) => {
      btn.onclick = () => {
        const creditId = btn.getAttribute("data-credit-id");
        const actContainer = btn.closest(".sb-reset-card-act");
        if (!actContainer) return;
        actContainer.innerHTML = `
          <div class="sb-reset-confirm-box">
            <span style="font-size:10px;color:var(--text-secondary,#52525b)">确定使用?</span>
            <button type="button" class="sb-confirm-yes" data-act="confirm" data-credit-id="${esc(creditId)}">确定</button>
            <button type="button" class="sb-confirm-no" data-act="cancel" data-credit-id="${esc(creditId)}">取消</button>
          </div>
        `;
        attachCardListEvents(contentEl);
      };
    });

    contentEl.querySelectorAll("[data-act='cancel']").forEach((btn) => {
      btn.onclick = () => {
        const creditId = btn.getAttribute("data-credit-id");
        const actContainer = btn.closest(".sb-reset-card-act");
        if (!actContainer) return;
        actContainer.innerHTML = `
          <button type="button" class="sb-reset-action-btn" data-act="prepare" data-credit-id="${esc(creditId)}">使用此卡</button>
        `;
        attachCardListEvents(contentEl);
      };
    });

    contentEl.querySelectorAll("[data-act='confirm']").forEach((btn) => {
      btn.onclick = async () => {
        const creditId = btn.getAttribute("data-credit-id");
        const actContainer = btn.closest(".sb-reset-card-act");
        const feedbackSlot = contentEl.querySelector("#sb-reset-feedback-slot");

        if (actContainer) {
          actContainer.innerHTML = `<span style="font-size:10px;color:var(--text-muted,#71717a)">使用中...</span>`;
        }

        if (typeof onConsumeResetCredit !== "function") {
          if (feedbackSlot) {
            feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-err" style="margin-top:6px">未配置重置卡核销函数</div>`;
          }
          return;
        }

        try {
          const res = await onConsumeResetCredit(creditId);
          if (res?.ok) {
            if (feedbackSlot) {
              feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-ok" style="margin-top:6px">${esc(res.message || "重置卡已成功使用，限额已清空")}</div>`;
            }
            if (actContainer) {
              actContainer.innerHTML = `<span class="sb-reset-spent-label">已使用</span>`;
            }
            if (typeof onRefresh === "function") {
              setTimeout(() => onRefresh(true), 800);
            }
            setTimeout(() => {
              closeModal();
            }, 1500);
          } else {
            if (feedbackSlot) {
              feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-err" style="margin-top:6px">${esc(res?.message || "重置卡使用失败")}</div>`;
            }
            if (actContainer) {
              actContainer.innerHTML = `
                <button type="button" class="sb-reset-action-btn" data-act="prepare" data-credit-id="${esc(creditId)}">使用此卡</button>
              `;
              attachCardListEvents(contentEl);
            }
          }
        } catch (err) {
          if (feedbackSlot) {
            feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-err" style="margin-top:6px">操作失败：${esc(err?.message || err)}</div>`;
          }
          if (actContainer) {
            actContainer.innerHTML = `
              <button type="button" class="sb-reset-action-btn" data-act="prepare" data-credit-id="${esc(creditId)}">使用此卡</button>
            `;
            attachCardListEvents(contentEl);
          }
        }
      };
    });
  }
}
