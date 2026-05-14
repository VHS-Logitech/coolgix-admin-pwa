/**
 * Timezone + UTC window helpers aligned with coolgix-frontend Dashboard / hourWindow.
 */

export function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Compare same instant formatted in target tz — used to map local wall time to UTC. */
export function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const values = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') values[type] = value;
  }
  const asUTC = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUTC - date.getTime();
}

/**
 * Current calendar hour in `timeZone`, as UTC ISO bounds for `/sensor-data?start=&end=`.
 */
export function getCurrentHourUtcWindow(timeZone = getBrowserTimeZone()) {
  const nowUtc = new Date();
  const offsetNow = getTimeZoneOffsetMs(nowUtc, timeZone);
  const nowLocal = new Date(nowUtc.getTime() + offsetNow);
  const startLocal = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate(),
      nowLocal.getUTCHours(),
      0,
      0,
      0,
    ),
  );
  const startUtc = new Date(startLocal.getTime() - offsetNow);
  const endUtc = new Date(startUtc.getTime() + 60 * 60 * 1000 - 1);
  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    startMs: startUtc.getTime(),
    endMs: endUtc.getTime(),
  };
}

/** Calendar YYYY-MM-DD for an instant in an IANA timezone. */
export function getCalendarYmdInTimeZone(inst, timeZone) {
  const tz = timeZone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(inst instanceof Date ? inst : new Date(inst));
  } catch {
    const d = inst instanceof Date ? inst : new Date(inst);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

export function addCalendarDaysToYmd(ymd, deltaDays, timeZone) {
  const parts = String(ymd || '').split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return ymd;
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  const shifted = new Date(utcNoon + Number(deltaDays) * 86400000);
  return getCalendarYmdInTimeZone(shifted, timeZone);
}

/** UTC range for a business calendar day in `timeZone` (matches Dashboard). */
export function buildUtcRangeForDate(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startLocal = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const endLocal = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));

  const offsetStart = getTimeZoneOffsetMs(startLocal, timeZone);
  const offsetEnd = getTimeZoneOffsetMs(endLocal, timeZone);

  const startUtc = new Date(startLocal.getTime() - offsetStart);
  const endUtc = new Date(endLocal.getTime() - offsetEnd);

  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    startMs: startUtc.getTime(),
    endMs: endUtc.getTime(),
  };
}

const tzFormatCache = new Map();

function getTzFormatter(timeZone, includeSeconds) {
  const key = `${timeZone}\0${includeSeconds ? '1' : '0'}`;
  let fmtter = tzFormatCache.get(key);
  if (!fmtter) {
    const options = {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone || 'UTC',
    };
    if (includeSeconds) options.second = '2-digit';
    fmtter = new Intl.DateTimeFormat('en-US', options);
    tzFormatCache.set(key, fmtter);
  }
  return fmtter;
}

export function formatTimeInTimezone(timestamp, timeZone, includeSeconds = false) {
  return getTzFormatter(timeZone, includeSeconds).format(new Date(timestamp));
}
