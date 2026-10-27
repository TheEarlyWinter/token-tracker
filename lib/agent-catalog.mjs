// 宿主 `agent:list` 按设计不列「子代理池」成员（hana-artisan / luna / gemini-coder…），
// 名册里没有名字。这些成员在本机是普通 Agent 目录，名字写在 agents/<id>/config.yaml 里，
// 引擎以 local-machine 档能读到。这里做合并：宿主名册优先，缺的用本机配置补。
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

export async function refreshAgentNames(shared, { force = false } = {}) {
  if (!force && Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
  lastRefreshAt = Date.now();
  const names = {};
  try {
    const listAgents = typeof shared.sdk?.agents?.list === "function"
      ? (params) => shared.sdk.agents.list(params)
      : (params) => shared.bus.request("agent:list", params);
    // lifecycle:all 才能拿到退役 Agent 的名字（否则历史 agent 只剩 id）。
    const result = await listAgents({ scope: "all", lifecycle: "all" });
    if (Array.isArray(result?.agents)) {
      for (const agent of result.agents) {
        if (agent?.id) names[agent.id] = agent.name || agent.id;
      }
    }
  } catch (error) {
    shared.log?.warn?.("[token-tracker] agent:list failed (retaining existing mappings):", error?.message || error);
  }

  // 名册补不全时问引擎要本机名字；只有名册里没有的 id 才会被采用。
  const poolAgentIds = new Set();
  if (typeof shared.client?.call === "function") {
    try {
      const diskNames = await shared.client.call("agents.names", {});
      for (const [id, name] of Object.entries(diskNames || {})) {
        if (typeof id !== "string" || !id) continue;
        if (names[id]) continue;
        if (typeof name !== "string" || !name.trim()) continue;
        names[id] = name.trim();
        poolAgentIds.add(id);
      }
    } catch (error) {
      shared.log?.warn?.("[token-tracker] 本机 Agent 名字读取失败（继续用 id）：", error?.code || error?.message || "UNKNOWN");
    }
  }

  if (Object.keys(names).length) {
    shared.agentNames = { ...shared.agentNames, ...names };
  }
  // 池成员身份：UI 用它把名字和 id 一起标出来（名字可能与供应商重名，如 DeepSeek）。
  shared.poolAgentIds = [...poolAgentIds];
  shared.log?.info?.(`[token-tracker] agent names: ${Object.keys(shared.agentNames || {}).length} known, ${poolAgentIds.size} from local config`);
}
