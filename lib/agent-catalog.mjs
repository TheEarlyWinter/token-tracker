export async function refreshAgentNames(shared) {
  try {
    const listAgents = typeof shared.sdk?.agents?.list === "function"
      ? (params) => shared.sdk.agents.list(params)
      : (params) => shared.bus.request("agent:list", params);
    const result = await listAgents({ scope: "all" });
    if (Array.isArray(result?.agents)) {
      const names = {};
      for (const agent of result.agents) {
        if (agent?.id) names[agent.id] = agent.name || agent.id;
      }
      shared.agentNames = { ...shared.agentNames, ...names };
    }
  } catch (error) {
    shared.log?.warn?.("[token-tracker] agent:list failed (retaining existing mappings):", error?.message || error);
  }
}
