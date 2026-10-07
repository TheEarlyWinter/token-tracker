// ui/modules/curve.js
// 三次单调样条（Fritsch–Carlson）与 Hermite 插值，纯数学函数无依赖。

export function splineTangents(ys, dx = 1) {
  const n = ys.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const s = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) s[i] = (ys[i + 1] - ys[i]) / dx;
  if (n === 2) {
    m[0] = m[1] = s[0];
    return m;
  }
  for (let i = 1; i < n - 1; i++) {
    if (s[i - 1] === 0 || s[i] === 0 || Math.sign(s[i - 1]) !== Math.sign(s[i])) {
      m[i] = 0;
      continue;
    }
    m[i] = 2 / (1 / s[i - 1] + 1 / s[i]);
  }
  const end = (near, far) => {
    let v = (3 * near - far) / 2;
    if (Math.sign(v) !== Math.sign(near)) v = 0;
    else if (Math.sign(near) !== Math.sign(far) && Math.abs(v) > 3 * Math.abs(near)) v = 3 * near;
    return v;
  };
  m[0] = end(s[0], s[1]);
  m[n - 1] = end(s[n - 2], s[n - 3]);
  return m;
}

export function hermiteAt(v0, v1, m0, m1, t) {
  const h = 1 - t;
  return h * h * h * v0 + 3 * h * h * t * (v0 + m0 / 3) + 3 * h * t * t * (v1 - m1 / 3) + t * t * t * v1;
}

export function splineCurve(pts) {
  const n = pts.length;
  if (n < 2) return "";
  const dx = pts[1][0] - pts[0][0];
  const m = splineTangents(pts.map((p) => p[1]), dx);
  let d = "";
  for (let i = 1; i < n; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], c = dx / 3;
    d += ` C${x0 + c},${y0 + m[i - 1] * c} ${x1 - c},${y1 - m[i] * c} ${x1},${y1}`;
  }
  return d;
}

export function splineValueAt(values, fx) {
  const n = values.length;
  if (!n) return 0;
  const a = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const b = Math.min(n - 1, a + 1);
  if (a === b) return values[a];
  const m = splineTangents(values, 1);
  return hermiteAt(values[a], values[b], m[a], m[b], Math.max(0, Math.min(1, fx - a)));
}

export default { splineTangents, hermiteAt, splineCurve, splineValueAt };
