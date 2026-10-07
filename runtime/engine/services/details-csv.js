// runtime/engine/services/details-csv.js
// 轮次消费明细 CSV 流式服务端拼装

export function hitRate(r) {
  const read = Number(r?.cacheRead || 0);
  const uncached = Number(r?.input ?? r?.inputTokens ?? 0);
  const totalIn = read + uncached;
  if (totalIn <= 0) return null;
  return Math.max(0, Math.min(1, read / totalIn));
}

export function buildDetailsCSV(rows) {
  const header = ["时间", "Agent", "Provider", "模型", "输入Token", "输出Token", "缓存命中率", "调用次数", "总Token"];
  const lines = (Array.isArray(rows) ? rows : []).map((r) => {
    const hr = hitRate(r);
    return [
      r.at || r.time || "",
      r.agentName || r.agent || "",
      r.provider || "",
      r.model || "",
      r.input ?? r.inputTokens ?? "",
      r.output ?? r.outputTokens ?? "",
      hr == null ? "" : (hr * 100).toFixed(1) + "%",
      r.calls ?? r.msgCount ?? "",
      r.total ?? r.totalTokens ?? 0,
    ];
  });

  return (
    "\uFEFF" +
    [header, ...lines]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n")
  );
}

export default { hitRate, buildDetailsCSV };
