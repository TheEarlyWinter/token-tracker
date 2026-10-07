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

  function build(y, m) {
    const d = new Date(y, m, 1);
    const start = d.getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let h = '<div class="cal-hd"><button data-a="prev">◀</button><span>' + y + '年' + (m + 1) + '月</span><button data-a="next">▶</button></div>';
    h += '<div class="cal-grid"><div class="wk">日</div><div class="wk">一</div><div class="wk">二</div><div class="wk">三</div><div class="wk">四</div><div class="wk">五</div><div class="wk">六</div>';
    for (let i = 0; i < start; i++) h += '<div class="dim"></div>';
    for (let day = 1; day <= days; day++) {
      const cls = (y === tY && m === tM && day === tD) ? ' class="today"' : '';
      h += '<div' + cls + ' data-d="' + day + '">' + day + '</div>';
    }
    h += '</div>';
    cal.innerHTML = h;

    const prevBtn = cal.querySelector('[data-a=prev]');
    if (prevBtn) {
      prevBtn.onclick = function (e) {
        e.stopPropagation();
        curM--;
        if (curM < 0) { curM = 11; curY--; }
        build(curY, curM);
      };
    }
    const nextBtn = cal.querySelector('[data-a=next]');
    if (nextBtn) {
      nextBtn.onclick = function (e) {
        e.stopPropagation();
        curM++;
        if (curM > 11) { curM = 0; curY++; }
        build(curY, curM);
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
    curInp = inp;
    const v = inp.value || '';
    const p = v.match(/^(\d{4})-(\d{2})/);
    curY = p ? parseInt(p[1], 10) : tY;
    curM = p ? parseInt(p[2], 10) - 1 : tM;
    build(curY, curM);
    const r = inp.getBoundingClientRect();
    cal.style.top = (r.bottom + 8) + 'px';
    cal.style.left = r.left + 'px';
    cal.classList.add('on');
  }

  document.addEventListener('click', function (e) {
    if (cal.classList.contains('on') && !cal.contains(e.target) && e.target !== curInp) {
      cal.classList.remove('on');
    }
  });

  const attachInputs = () => {
    const df = document.getElementById(fromInputId);
    const dt = document.getElementById(toInputId);
    if (df) df.addEventListener("click", function (e) { e.stopPropagation(); show(this); });
    if (dt) dt.addEventListener("click", function (e) { e.stopPropagation(); show(this); });
  };

  setTimeout(attachInputs, 200);

  return {
    destroy: () => cal.remove(),
    show,
  };
}
