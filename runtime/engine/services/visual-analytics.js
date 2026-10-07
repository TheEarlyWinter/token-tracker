// runtime/engine/services/visual-analytics.js
// 深度可视化分析数据服务：聚合来源、Agent 与模型多维分布。

const value = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

function modelsFor(bucket, { model, provider } = {}) {
  const models = Array.isArray(model) ? model : model ? [model] : [];
  const providers = Array.isArray(provider) ? provider : provider ? [provider] : [];
  const result = new Map();
  const add = (id, row) => {
    if (models.length && !models.includes(id)) return;
    const old = result.get(id) || { totalTokens: 0, count: 0 };
    old.totalTokens += value(row.totalTokens);
    old.count += value(row.assistantCount);
    result.set(id, old);
  };

  if (providers.length) {
    for (const [key, row] of Object.entries(bucket.providerTotals || {})) {
      const sep = key.indexOf("/");
      if (providers.includes(key.slice(0, sep))) add(key.slice(sep + 1), row);
    }
  } else {
    for (const [id, row] of Object.entries(bucket.models || {})) add(id, row);
    if (!models.length) {
      const gap =
        value(bucket.totalTokens) -
        [...result.values()].reduce((sum, row) => sum + row.totalTokens, 0);
      if (gap > 0) result.set("未归属", { totalTokens: gap, count: 0 });
    }
  }
  return result;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarizeTurns(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const n = r?.totalTokens ?? r?.total;
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = r.model || "";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(n);
  }
  let max = 1;
  for (const values of groups.values()) {
    for (const n of values) if (n > max) max = n;
  }
  const scale = Math.log1p(max);
  const models = [...groups]
    .map(([id, values]) => {
      const bins = Array(32).fill(0);
      for (const n of values) {
        bins[Math.min(31, Math.floor((Math.log1p(n) / scale) * 32))]++;
      }
      return {
        id,
        count: values.length,
        totalTokens: values.reduce((sum, n) => sum + n, 0),
        p50: quantile(values, 0.5),
        p90: quantile(values, 0.9),
        bins,
      };
    })
    .sort((a, b) => b.count - a.count);

  return { turnCount: rows.length, models };
}

export function buildVisualAnalytics(sessions, dateFilter, filters = {}, rows = []) {
  const days = new Map();
  const agents = new Map();
  const hours = new Map();
  let sessionCount = 0;

  const canSplit = !(filters.model?.length) && !(filters.provider?.length);
  const kindsOf = (b) =>
    canSplit
      ? {
          desktop: value(b.desktop),
          sub: value(b.sub),
          bridge: value(b.bridge),
          background: value(b.background),
          ledger: value(b.ledger),
          channel: value(b.channel),
        }
      : null;

  for (const session of sessions) {
    if (filters.agent?.length && !filters.agent.includes(session.agent)) continue;
    if (filters.type?.length && !filters.type.includes(session.type)) continue;
    let active = false;

    for (const [date, bucket] of Object.entries(session.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(date)) continue;
      const models = modelsFor(bucket, filters);
      let total = 0;
      let calls = 0;
      for (const m of models.values()) {
        total += m.totalTokens;
        calls += m.count;
      }
      if (!total) continue;
      active = true;

      if (!days.has(date)) {
        days.set(date, { date, totalTokens: 0, models: {}, kinds: {}, agents: {}, calls: 0 });
      }
      const day = days.get(date);
      day.totalTokens += total;
      day.calls += calls;

      for (const [id, data] of models) {
        day.models[id] = (day.models[id] || 0) + data.totalTokens;
      }

      const kb = kindsOf(bucket);
      if (kb) {
        for (const [k, v] of Object.entries(kb)) {
          if (v) day.kinds[k] = (day.kinds[k] || 0) + v;
        }
      }

      if (canSplit) {
        day.agents[session.agent] = (day.agents[session.agent] || 0) + total;
      }

      if (!agents.has(session.agent)) {
        agents.set(session.agent, { id: session.agent, totalTokens: 0, days: {} });
      }
      const agent = agents.get(session.agent);
      agent.totalTokens += total;
      agent.days[date] = (agent.days[date] || 0) + total;
    }

    if (active) sessionCount++;

    for (const [date, buckets] of Object.entries(session.hourlyBreakdown || {})) {
      if (dateFilter && !dateFilter(date)) continue;
      for (const [hour, bucket] of Object.entries(buckets)) {
        const models = modelsFor(bucket, filters);
        let total = 0;
        let calls = 0;
        for (const m of models.values()) {
          total += m.totalTokens;
          calls += m.count;
        }
        if (!total) continue;

        const key = `${date}/${hour}`;
        if (!hours.has(key)) {
          hours.set(key, { date, hour: Number(hour), totalTokens: 0, models: {}, kinds: {}, agents: {}, calls: 0 });
        }
        const cell = hours.get(key);
        cell.totalTokens += total;
        cell.calls += calls;

        for (const [id, data] of models) {
          cell.models[id] = (cell.models[id] || 0) + data.totalTokens;
        }

        const kb = kindsOf(bucket);
        if (kb) {
          for (const [k, v] of Object.entries(kb)) {
            if (v) cell.kinds[k] = (cell.kinds[k] || 0) + v;
          }
        }

        if (canSplit) {
          cell.agents[session.agent] = (cell.agents[session.agent] || 0) + total;
        }
      }
    }
  }

  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const hourly = [...hours.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);

  return {
    sessionCount,
    daily,
    hourly,
    agents: [...agents.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    turns: summarizeTurns(rows),
  };
}

export default { summarizeTurns, buildVisualAnalytics };
