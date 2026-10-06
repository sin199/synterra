export const WORLD_TICK_STALE_AFTER_MS = 60_000;
export const WORLD_TICK_WATCHDOG_INTERVAL_MS = 10_000;

function redactSensitiveText(value) {
  let text = String(value ?? '');
  for (const secret of [process.env.DATABASE_URL, process.env.TYPESAFE_API_KEY].filter(Boolean)) {
    text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted database URL]')
    .replace(/([?&](?:password|token|api_key)=)[^&\s]+/gi, '$1[redacted]');
}

export function worldEngineErrorRecord({ error, stage = 'tick', worldId = null, worldMinute = null,
  tickCount = null, phase = null, timestamp = new Date() } = {}) {
  const source = error instanceof Error ? error : new Error(String(error ?? 'Unknown world engine error'));
  return {
    timestamp: (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString(),
    worldId,
    worldMinute: worldMinute !== null && worldMinute !== undefined && Number.isFinite(Number(worldMinute)) ? Number(worldMinute) : null,
    tickCount: tickCount !== null && tickCount !== undefined && Number.isFinite(Number(tickCount)) ? Number(tickCount) : null,
    stage: String(stage).slice(0, 80),
    phase: phase ? String(phase).slice(0, 80) : null,
    errorName: redactSensitiveText(source.name || 'Error').slice(0, 120),
    errorMessage: redactSensitiveText(source.message || 'Unknown world engine error').slice(0, 1_000),
    stack: redactSensitiveText(source.stack || '').slice(0, 16_000)
  };
}

export function reportWorldEngineError({ error, stage, worldId, worldMinute, tickCount, phase,
  onError, emergencySink = process.stderr, timestamp = new Date() } = {}) {
  const record = worldEngineErrorRecord({ error, stage, worldId, worldMinute, tickCount, phase, timestamp });
  let logged = false;
  try { logged = onError?.(error, stage, record) === true; } catch { /* use the emergency sink */ }
  if (!logged) {
    try { emergencySink?.write?.(`${JSON.stringify(record)}\n`); } catch { /* error reporting must not throw */ }
  }
  return record;
}

export async function settleOptionalReasoning(task, { timeoutMs, fallback = null, onTimeout = () => {} } = {}) {
  let timer;
  let timedOut = false;
  let error = null;
  const operation = Promise.resolve().then(() => typeof task === 'function' ? task() : task);
  operation.catch(() => {});
  const fallbackOperation = operation.catch((reason) => { error = reason; return fallback; });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { onTimeout(); } catch { /* optional diagnostic callback */ }
      resolve(fallback);
    }, Math.max(1, Number(timeoutMs) || 1));
  });
  try {
    const value = await Promise.race([fallbackOperation, timeout]);
    return { value, timedOut, error };
  } finally {
    clearTimeout(timer);
  }
}

export function buildWorldLiveness({ serviceHealthy = true, databaseHealthy = false, runtime = null,
  engine = null, checkedAt = new Date(), staleAfterMs = WORLD_TICK_STALE_AFTER_MS } = {}) {
  const checkedAtMs = checkedAt instanceof Date ? checkedAt.getTime() : new Date(checkedAt).getTime();
  const lastTickAt = runtime?.last_tick_at ?? runtime?.lastTickAt ?? null;
  const lastTickMs = lastTickAt ? new Date(lastTickAt).getTime() : NaN;
  const secondsSinceLastTick = Number.isFinite(lastTickMs) && Number.isFinite(checkedAtMs)
    ? Math.max(0, Math.round((checkedAtMs - lastTickMs) / 100) / 10) : null;
  const worldEngineRunning = Boolean(engine?.running);
  const worldLockOwned = Boolean(engine?.worldLockOwned);
  const schedulerRunning = Boolean(engine?.schedulerRunning);
  const worldTickHealthy = Boolean(databaseHealthy && worldEngineRunning && worldLockOwned && schedulerRunning
    && secondsSinceLastTick !== null && secondsSinceLastTick * 1_000 <= staleAfterMs);
  return {
    ok: true,
    serviceHealthy: Boolean(serviceHealthy),
    databaseHealthy: Boolean(databaseHealthy),
    worldEngineRunning,
    worldLockOwned,
    worldLockOwnerPid: engine?.worldLockOwnerPid ?? null,
    schedulerRunning,
    worldId: runtime?.world_id ?? runtime?.worldId ?? engine?.worldId ?? null,
    worldMinute: runtime?.world_minutes === undefined ? engine?.worldMinute ?? null : Number(runtime.world_minutes),
    tickCount: runtime?.tick_count === undefined ? engine?.tickCount ?? null : Number(runtime.tick_count),
    lastTickAt,
    secondsSinceLastTick,
    worldTickHealthy,
    lastTickPhase: engine?.lastTickPhase ?? null,
    lastSuccessfulPhase: engine?.lastSuccessfulPhase ?? null,
    lastTickStartedAt: engine?.lastTickStartedAt ?? null,
    lastTickCompletedAt: engine?.lastTickCompletedAt ?? null,
    lastTickError: engine?.lastTickError ?? null
  };
}
