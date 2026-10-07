// ui/modules/filter-dropdown.js — 自定义下拉筛选控件交互逻辑

export function initFilterDropdowns({ onSelect } = {}) {
  function handleDocumentClick(e) {
    const cs = e.target.closest(".cs");
    document.querySelectorAll(".cs.open").forEach((c) => {
      if (c !== cs) c.classList.remove("open");
    });
    if (!cs) return;
    e.stopPropagation();
    cs.classList.toggle("open");

    const opt = e.target.closest(".cs-opt");
    if (opt) {
      cs.classList.remove("open");
      const value = opt.dataset.v || "";
      const text = opt.textContent;
      const txtEl = cs.querySelector(".cs-txt");
      if (txtEl) txtEl.textContent = text;
      if (typeof onSelect === "function") {
        onSelect({ name: cs.id, value, label: text });
      }
    }
  }

  document.addEventListener("click", handleDocumentClick);

  return {
    destroy: () => document.removeEventListener("click", handleDocumentClick),
  };
}
