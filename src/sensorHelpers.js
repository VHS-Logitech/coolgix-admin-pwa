/** Same field shapes as coolgix-frontend/src/utils/alertSensorHelpers.js */
export function getTimestamp(r) {
  if (!r || typeof r !== 'object') return null;
  return (
    r.timestamp ??
    r.ts ??
    r.createdAt ??
    r.time ??
    r.date ??
    r.recordedAt ??
    r.sampleTime ??
    r.savedAt ??
    null
  );
}

/** Milliseconds for sorting / age; treats Unix seconds (< 1e12) as seconds. */
export function getReadingTimeMs(r) {
  const raw = getTimestamp(r);
  if (raw == null) return NaN;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return NaN;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (raw instanceof Date) return raw.getTime();
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

/** Axios body may be a bare array or wrapped ({ data, readings }). */
export function normalizeSensorReadingsPayload(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.readings)) return body.readings;
  if (body && Array.isArray(body.results)) return body.results;
  return [];
}

export function getTemperature(r) {
  if (!r) return undefined;
  if (typeof r.temperature === 'number') return r.temperature;
  if (r.temperature && typeof r.temperature === 'object') {
    const t = r.temperature;
    if (typeof t.avg === 'number') return t.avg;
    if (typeof t.min === 'number' && typeof t.max === 'number') return (t.min + t.max) / 2;
  }
  return typeof r.temp === 'number' ? r.temp : undefined;
}

export function getHumidity(r) {
  if (!r) return undefined;
  if (typeof r.humidity === 'number') return r.humidity;
  if (r.humidity && typeof r.humidity === 'object') {
    const h = r.humidity;
    if (typeof h.avg === 'number') return h.avg;
    if (typeof h.min === 'number' && typeof h.max === 'number') return (h.min + h.max) / 2;
  }
  if (typeof r.relativeHumidity === 'number') return r.relativeHumidity;
  return typeof r.hum === 'number' ? r.hum : undefined;
}

/** Min/max/avg for tooltips (matches Dashboard getTempAgg). */
export function getTempAgg(r) {
  if (!r) return null;
  const t = r.temperature;
  if (typeof t === 'number') return { min: t, max: t, avg: t };
  if (t && typeof t === 'object') {
    const min = typeof t.min === 'number' ? t.min : undefined;
    const max = typeof t.max === 'number' ? t.max : undefined;
    const avg =
      typeof t.avg === 'number'
        ? t.avg
        : min != null && max != null
          ? (min + max) / 2
          : undefined;
    return { min, max, avg };
  }
  const v = typeof r.temp === 'number' ? r.temp : undefined;
  return typeof v === 'number' ? { min: v, max: v, avg: v } : null;
}

/** Min/max/avg for humidity tooltips (matches Dashboard getHumAgg). */
export function getHumAgg(r) {
  if (!r) return null;
  const h = r.humidity;
  if (typeof h === 'number') return { min: h, max: h, avg: h };
  if (h && typeof h === 'object') {
    const min = typeof h.min === 'number' ? h.min : undefined;
    const max = typeof h.max === 'number' ? h.max : undefined;
    const avg =
      typeof h.avg === 'number'
        ? h.avg
        : min != null && max != null
          ? (min + max) / 2
          : undefined;
    return { min, max, avg };
  }
  const v = getHumidity(r);
  return typeof v === 'number' ? { min: v, max: v, avg: v } : null;
}

export function latestFromReadings(readings) {
  if (!Array.isArray(readings) || readings.length === 0) {
    return { temperature: null, humidity: null, timestamp: null };
  }
  const sorted = readings
    .filter(Boolean)
    .slice()
    .sort((a, b) => getReadingTimeMs(a) - getReadingTimeMs(b));
  const withTime = sorted.filter((x) => Number.isFinite(getReadingTimeMs(x)));
  const latest = withTime.length ? withTime[withTime.length - 1] : sorted[sorted.length - 1];
  if (!latest) {
    return { temperature: null, humidity: null, timestamp: null };
  }
  const ms = getReadingTimeMs(latest);
  const ts = Number.isFinite(ms) ? new Date(ms).toISOString() : getTimestamp(latest);
  return {
    temperature: getTemperature(latest) ?? null,
    humidity: getHumidity(latest) ?? null,
    timestamp: ts,
  };
}
