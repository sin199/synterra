function publicCounts(source) {
  return Object.fromEntries(Object.entries(source || {}).map(([key, value]) => [
    String(key).slice(0, 64), Math.max(0, Number(value) || 0)
  ]));
}

export function summarizeArcObserverHealth(status, config) {
  const network = status?.network || { name: config?.name || 'mainnet', chainId: config?.chainId ?? null };
  const rpc = status?.rpc || {};
  const sourceNetworkStatus = status?.arcMainnet || {};
  const networkStatus = {
    configured: sourceNetworkStatus.configured === true || Boolean(config?.chainId),
    chainId: sourceNetworkStatus.chainId ?? config?.chainId ?? null,
    rpcHealthy: sourceNetworkStatus.rpcHealthy === true,
    latestBlock: sourceNetworkStatus.latestBlock ?? null,
    lastIndexedBlock: sourceNetworkStatus.lastIndexedBlock ?? null,
    indexerLag: sourceNetworkStatus.indexerLag ?? null,
    pendingSettlements: Math.max(0, Number(sourceNetworkStatus.pendingSettlements) || 0),
    failedSettlements: Math.max(0, Number(sourceNetworkStatus.failedSettlements) || 0),
    settlementEnabled: sourceNetworkStatus.settlementEnabled === true
  };
  const source = status?.database;
  const reconciliationFindings = (source?.reconciliationFindings || []).map((finding) => ({
    code: String(finding?.code || 'ARC_OBSERVER_FINDING').slice(0, 96),
    entityType: String(finding?.entityType || 'unknown').slice(0, 48),
    detail: String(finding?.detail || '').slice(0, 500)
  }));
  const database = source ? {
    worldMinute: source.worldMinute ?? null,
    worldLastTickAt: source.worldLastTickAt || null,
    wallets: { total: Math.max(0, Number(source.wallets?.total) || 0),
      byStatus: publicCounts(source.wallets?.byStatus) },
    settlements: {
      byStatus: publicCounts(source.settlements?.byStatus),
      pending: Math.max(0, Number(source.settlements?.pending) || 0),
      failed: Math.max(0, Number(source.settlements?.failed) || 0),
      final: Math.max(0, Number(source.settlements?.final) || 0)
    },
    checkpoints: { total: Math.max(0, Number(source.checkpoints?.total) || 0),
      byStatus: publicCounts(source.checkpoints?.byStatus) },
    capabilityProvenance: { total: Math.max(0, Number(source.capabilityProvenance?.total) || 0),
      byStatus: publicCounts(source.capabilityProvenance?.byStatus) },
    indexer: { configured: source.indexer?.configured === true,
      sourceCount: Math.max(0, Number(source.indexer?.sources?.length) || 0),
      lastIndexedBlock: source.indexer?.lastIndexedBlock ?? null,
      lag: source.indexer?.lag ?? null },
    receiptChecks: Math.max(0, Number(source.receiptChecks) || 0),
    reconciliationFindings,
    readinessBlockers: (source.readinessBlockers || []).map((item) => String(item).slice(0, 96))
  } : null;
  return {
    available: status?.available === true,
    running: status?.running === true,
    mode: status?.mode || 'read_only',
    sourceOfTruth: status?.sourceOfTruth || 'database_and_arc_chain',
    worldId: status?.worldId || null,
    samplingIntervalMs: status?.samplingIntervalMs ?? null,
    lastSampleAt: status?.lastSampleAt || null,
    lastSampleWorldMinute: status?.lastSampleWorldMinute ?? null,
    lastFindingCount: status?.lastFindingCount ?? null,
    lastError: status?.lastError || null,
    reason: status?.reason || null,
    network: { name: network.name, chainId: network.chainId ?? null,
      explorerUrl: network.explorerUrl || null },
    rpc: {
      configured: rpc.configured === true,
      chainId: rpc.chainId ?? null,
      expectedChainId: rpc.expectedChainId ?? config?.chainId ?? null,
      rpcHealthy: rpc.rpcHealthy === true,
      provider: rpc.provider || null,
      latestBlock: rpc.latestBlock ?? null,
      latencyMs: rpc.latencyMs ?? null,
      checkedAt: rpc.checkedAt || null,
      error: rpc.error || null
    },
    usdc: status?.usdc ? { verified: status.usdc.verified === true,
      address: status.usdc.address || null, codeNonEmpty: status.usdc.codeNonEmpty === true,
      erc20Decimals: status.usdc.erc20Decimals ?? null,
      nativeGasDecimals: config?.nativeGasDecimals ?? null } : null,
    findings: reconciliationFindings,
    database,
    arcNetwork: networkStatus,
    arcMainnet: network.name === 'mainnet' ? networkStatus : null
  };
}
