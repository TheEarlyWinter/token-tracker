// ui/modules/reset-credits-modal.js — Codex 限额重置卡大界面弹窗组件

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

export function showResetCreditsModal({
  container = document.body,
  fetchFn = globalThis.fetch,
  onRefresh = null,
  onClose = null,
} = {}) {
  const existing = container.querySelector(".sb-codex-modal-overlay");
  if (existing) {
    try { existing.remove(); } catch {}
  }

  const overlay = document.createElement("div");
  overlay.className = "sb-codex-modal-overlay";
  overlay.innerHTML = `
    <div class="sb-codex-modal-dialog">
      <div class="sb-codex-modal-hdr">
        <span class="sb-codex-modal-title">限额重置卡</span>
        <button type="button" class="sb-codex-modal-close" id="sb-modal-close-btn" title="关闭">×</button>
      </div>
      <div class="sb-codex-modal-body" id="sb-modal-body-content">
        <div class="sb-codex-quiet" style="font-size:12px;padding:16px 0;text-align:center">正在加载重置卡...</div>
      </div>
    </div>
  `;

  container.appendChild(overlay);

  function closeModal() {
    try { overlay.remove(); } catch {}
    if (typeof onClose === "function") {
      try { onClose(); } catch {}
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });

  const closeBtn = overlay.querySelector("#sb-modal-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeModal);
  }

  const contentEl = overlay.querySelector("#sb-modal-body-content");

  async function loadCredits() {
    try {
      const res = await fetchFn("/codex-reset-credits?_t=" + Date.now());
      if (!res.ok) {
        contentEl.innerHTML = `<div class="sb-codex-reset-msg is-err">获取失败 (${res.status})</div>`;
        return;
      }
      const data = await res.json();
      if (!data || data.connected === false) {
        contentEl.innerHTML = `<div class="sb-codex-reset-msg is-err">${esc(data?.message || "无法获取重置卡列表")}</div>`;
        return;
      }
      const credits = Array.isArray(data.credits) ? data.credits : [];
      if (credits.length === 0) {
        contentEl.innerHTML = `<div class="sb-codex-quiet" style="font-size:12px;padding:16px 0;text-align:center">暂无可用的限额重置卡</div>`;
        return;
      }
      renderList(credits);
    } catch (err) {
      contentEl.innerHTML = `<div class="sb-codex-reset-msg is-err">加载失败：${esc(err?.message || err)}</div>`;
    }
  }

  function renderList(credits) {
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
    listHtml += `</div><div id="sb-modal-feedback-slot"></div>`;
    contentEl.innerHTML = listHtml;
    attachEvents();
  }

  function attachEvents() {
    contentEl.querySelectorAll("[data-act='prepare']").forEach((btn) => {
      btn.onclick = () => {
        const creditId = btn.getAttribute("data-credit-id");
        const actContainer = btn.closest(".sb-reset-card-act");
        if (!actContainer) return;
        actContainer.innerHTML = `
          <div class="sb-reset-confirm-box">
            <span style="font-size:11px;color:var(--text-secondary,#52525b)">确定使用?</span>
            <button type="button" class="sb-confirm-yes" data-act="confirm" data-credit-id="${esc(creditId)}">确定</button>
            <button type="button" class="sb-confirm-no" data-act="cancel" data-credit-id="${esc(creditId)}">取消</button>
          </div>
        `;
        attachEvents();
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
        attachEvents();
      };
    });

    contentEl.querySelectorAll("[data-act='confirm']").forEach((btn) => {
      btn.onclick = async () => {
        const creditId = btn.getAttribute("data-credit-id");
        const actContainer = btn.closest(".sb-reset-card-act");
        const feedbackSlot = contentEl.querySelector("#sb-modal-feedback-slot");

        if (actContainer) {
          actContainer.innerHTML = `<span style="font-size:11px;color:var(--text-muted,#71717a)">正在核销...</span>`;
        }

        try {
          const resp = await fetchFn("/codex-reset-credits/consume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ creditId }),
          });
          const res = await resp.json();
          if (res?.ok) {
            if (feedbackSlot) {
              feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-ok" style="margin-top:8px">${esc(res.message || "重置卡已成功使用，限额已清空")}</div>`;
            }
            if (actContainer) {
              actContainer.innerHTML = `<span class="sb-reset-spent-label">已使用</span>`;
            }
            if (typeof onRefresh === "function") {
              try { onRefresh(); } catch {}
            }
            setTimeout(() => {
              closeModal();
            }, 1500);
          } else {
            if (feedbackSlot) {
              feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-err" style="margin-top:8px">${esc(res?.message || "重置卡使用失败")}</div>`;
            }
            if (actContainer) {
              actContainer.innerHTML = `
                <button type="button" class="sb-reset-action-btn" data-act="prepare" data-credit-id="${esc(creditId)}">使用此卡</button>
              `;
              attachEvents();
            }
          }
        } catch (err) {
          if (feedbackSlot) {
            feedbackSlot.innerHTML = `<div class="sb-codex-reset-msg is-err" style="margin-top:8px">操作失败：${esc(err?.message || err)}</div>`;
          }
          if (actContainer) {
            actContainer.innerHTML = `
              <button type="button" class="sb-reset-action-btn" data-act="prepare" data-credit-id="${esc(creditId)}">使用此卡</button>
            `;
            attachEvents();
          }
        }
      };
    });
  }

  loadCredits();

  return { close: closeModal };
}
