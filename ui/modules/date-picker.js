// ui/modules/date-picker.js — 独立日期选择器弹出组件

export function initDatePicker({ fromInputId = "df", toInputId = "dt", onDateSelect } = {}) {
  const cal = document.createElement("div");
  cal.className = "cal";
  document.body.appendChild(cal);

  let curInp = null;
  let curY = 0;
  let curM = 0;
  const today = new Date();
  const tY = today.getFullYear();
  const tM = today.getMonth();
  const tD = today.getDate();

  function build(y, m, selDay = 0) {
    const d = new Date(y, m, 1);
    const start = d.getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let h = '<div class="cal-hd"><button type="button" class="cal-nav-btn" data-a="prev" title="上月">◀</button><span>' + y + '年' + (m + 1) + '月</span><button type="button" class="cal-nav-btn" data-a="next" title="下月">▶</button></div>';
    h += '<div class="cal-grid"><div class="wk">日</div><div class="wk">一</div><div class="wk">二</div><div class="wk">三</div><div class="wk">四</div><div class="wk">五</div><div class="wk">六</div>';
    for (let i = 0; i < start; i++) h += '<div class="dim"></div>';
    for (let day = 1; day <= days; day++) {
      const isToday = (y === tY && m === tM && day === tD);
      const isSel = (selDay > 0 && day === selDay);
      let cls = [];
      if (isToday) cls.push("today");
      if (isSel) cls.push("sel");
      const clsAttr = cls.length ? ' class="' + cls.join(" ") + '"' : '';
      h += '<div' + clsAttr + ' data-d="' + day + '">' + day + '</div>';
    }
    h += '</div>';
    cal.innerHTML = h;

    const prevBtn = cal.querySelector('[data-a=prev]');
    if (prevBtn) {
      prevBtn.onclick = function (e) {
        e.stopPropagation();
        curM--;
        if (curM < 0) { curM = 11; curY--; }
        build(curY, curM, 0);
      };
    }
    const nextBtn = cal.querySelector('[data-a=next]');
    if (nextBtn) {
      nextBtn.onclick = function (e) {
        e.stopPropagation();
        curM++;
        if (curM > 11) { curM = 0; curY++; }
        build(curY, curM, 0);
      };
    }

    cal.querySelectorAll('[data-d]').forEach(function (el) {
      el.onclick = function (e) {
        e.stopPropagation();
        const dd = String(this.dataset.d).padStart(2, '0');
        const mm = String(curM + 1).padStart(2, '0');
        if (curInp) curInp.value = curY + '-' + mm + '-' + dd;
        const df = document.getElementById(fromInputId);
        const dt = document.getElementById(toInputId);
        if (df && dt && df.value && dt.value) {
          if (df.value > dt.value) {
            const t = df.value;
            df.value = dt.value;
            dt.value = t;
          }
          cal.classList.remove('on');
          curInp = null;
          if (typeof onDateSelect === "function") {
            onDateSelect(df.value, dt.value);
          }
          return;
        }
        cal.classList.remove('on');
        curInp = null;
      };
    });
  }

  function show(inp) {
    if (!inp) return;
    curInp = inp;
    const v = inp.value || '';
    const p = v.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    curY = p ? parseInt(p[1], 10) : tY;
    curM = p ? parseInt(p[2], 10) - 1 : tM;
    const curD = p && p[3] ? parseInt(p[3], 10) : (curY === tY && curM === tM ? tD : 0);
    build(curY, curM, curD);

    const r = typeof inp.getBoundingClientRect === "function"
      ? inp.getBoundingClientRect()
      : { bottom: 0, left: 0, top: 0 };
    const calHeight = 240;
    const calWidth = 228;
    const winH = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
    const winW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1024;

    let top = (r.bottom || 0) + 6;
    if (top + calHeight > winH && (r.top || 0) - calHeight > 0) {
      top = Math.max(8, (r.top || 0) - calHeight - 6);
    }
    const left = Math.max(8, Math.min(r.left || 0, winW - calWidth - 8));

    cal.style.top = top + 'px';
    cal.style.left = left + 'px';
    cal.classList.add('on');
  }

  const onClickOutside = function (e) {
    if (cal.classList.contains('on') && !cal.contains(e.target) && e.target !== curInp) {
      cal.classList.remove('on');
      curInp = null;
    }
  };
  document.addEventListener('click', onClickOutside);

  const onKeyDown = function (e) {
    if (e.key === 'Escape' && cal.classList.contains('on')) {
      cal.classList.remove('on');
      curInp = null;
    }
  };
  document.addEventListener('keydown', onKeyDown);

  let timer1 = null;
  let timer2 = null;

  const attachInputs = () => {
    if (typeof document === "undefined" || !document?.getElementById) return;
    const df = document.getElementById(fromInputId);
    const dt = document.getElementById(toInputId);
    if (df && !df._dpBound) {
      df._dpBound = true;
      const onDf = function (e) {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        show(df);
      };
      df.addEventListener("click", onDf);
      df.addEventListener("focus", onDf);
    }
    if (dt && !dt._dpBound) {
      dt._dpBound = true;
      const onDt = function (e) {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        show(dt);
      };
      dt.addEventListener("click", onDt);
      dt.addEventListener("focus", onDt);
    }
  };

  attachInputs();
  timer1 = setTimeout(attachInputs, 100);
  timer2 = setTimeout(attachInputs, 300);

  return {
    destroy: () => {
      if (timer1) clearTimeout(timer1);
      if (timer2) clearTimeout(timer2);
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
      cal.remove();
    },
    show,
  };
}
