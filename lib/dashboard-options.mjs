// Configuration is authoritative only when the host returned a model list.
// Historical ledger records remain part of usage totals, never current configuration.
export function applyDashboardOptions(result, configuredProviders, configurationKnown) {
  const configuredModels = new Set(configuredProviders.flatMap(p => p.models || []));
  const configuredIds = new Set(configuredProviders.map(p => p.id));
  const historicalModels = result.modelOptions || [];
  result.modelStates = Object.fromEntries([...new Set([...historicalModels, ...configuredModels])].map(id => [id,
    id === 'unknown' ? 'unattributed' : !configurationKnown ? 'unconfirmed' : configuredModels.has(id) ? 'current' : 'historical',
  ]));
  result.modelOptions = (configurationKnown ? [...configuredModels] : historicalModels).filter(id => id !== 'unknown').sort();
  const providerIds = new Set([...(result.providerOptions || []).map(p => p.provider), ...configuredIds]);
  result.providerOptions = [...providerIds].sort().map(provider => ({provider,
    state: !configurationKnown ? 'unconfirmed' : configuredIds.has(provider) ? 'current' : 'historical',
  }));
  result.providers ||= [];
  return result;
}
