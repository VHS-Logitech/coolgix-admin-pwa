/** Same field shapes as coolgix-frontend/src/utils/alertSensorHelpers.js */
export function getTimestamp(r) {
  return r?.timestamp || r?.ts || r?.createdAt || r?.time || r?.date || null;
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

export function latestFromReadings(readings) {
  if (!Array.isArray(readings) || readings.length === 0) {
    return { temperature: null, humidity: null, timestamp: null };
  }
  const sorted = readings
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const ma = getTimestamp(a) ? new Date(getTimestamp(a)).getTime() : 0;
      const mb = getTimestamp(b) ? new Date(getTimestamp(b)).getTime() : 0;
      return ma - mb;
    });
  const latest = sorted[sorted.length - 1];
  const ts = getTimestamp(latest);
  return {
    temperature: getTemperature(latest) ?? null,
    humidity: getHumidity(latest) ?? null,
    timestamp: ts,
  };
}
