function sampleTime(value, locale) {
  if (!value) return 'pending';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'unknown' : timestamp.toLocaleString(locale);
}

export function formatV6LifecycleObserverStatus(status, locale = 'zh-CN') {
  if (!status) return 'Observer status not reported by API';
  const lastSample = `Last sample: ${sampleTime(status?.lastSampleAt, locale)}`;
  const worldMinute = status?.lastSampleWorldMinute == null
    ? 'World minute: pending' : `World minute: ${status.lastSampleWorldMinute}`;
  const findings = status?.lastFindingCount == null
    ? 'Integrity findings: pending' : `Integrity findings: ${status.lastFindingCount}`;

  if (!status?.available || !status.running) {
    const reason = status?.reason || 'runtime_not_registered';
    const error = status?.lastError ? ` · ${status.lastError}` : '';
    return `Observer unavailable · ${reason} · ${lastSample} · ${worldMinute}${error}`;
  }

  const error = status.lastError ? ` · Last error: ${status.lastError}` : '';
  const source = status.sourceOfTruth === 'database' ? 'Database source of truth' : 'Source of truth unknown';
  return `Running · Read-only · ${source} · ${lastSample} · ${worldMinute} · ${findings}${error}`;
}
