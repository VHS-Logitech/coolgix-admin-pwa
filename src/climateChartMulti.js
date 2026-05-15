/**
 * Multi-BLE climate series + room averages (aligned with coolgix-frontend Dashboard.jsx).
 */
import {
  getReadingTimeMs,
  getTemperature,
  getHumidity,
  getTempAgg,
  getHumAgg,
} from './sensorHelpers.js';
import { formatTimeInTimezone } from './timeWindow.js';

export const CHART_24H_HOURLY_TICKS = 24;
export const CHART_24H_DAY_MS = 24 * 60 * 60 * 1000;
export const CHART_24H_HOUR_MS = 60 * 60 * 1000;

/** X-axis stays 24 hourly ticks; data point count varies by interval chip. */
export const CHART_24H_INTERVALS = {
  '15m': { stepMs: 15 * 60 * 1000, points: 96 },
  '30m': { stepMs: 30 * 60 * 1000, points: 48 },
  '1h': { stepMs: 60 * 60 * 1000, points: 24 },
};

export function build24hHourlyAxisLabels(startMs, timeZone) {
  return buildClimateChartLabels(
    startMs,
    startMs + CHART_24H_DAY_MS - 1,
    CHART_24H_HOUR_MS,
    timeZone,
    false,
    CHART_24H_HOURLY_TICKS,
  );
}

export function valuesToTimeSeriesData(values, startMs, stepMs, useLinearTimeX) {
  if (!useLinearTimeX) return values;
  return values.map((y, i) => ({
    x: startMs + (i + 1) * stepMs,
    y: y == null ? null : y,
  }));
}

export function chartNumericValue(pt) {
  if (pt == null) return null;
  if (typeof pt === 'number' && !Number.isNaN(pt)) return pt;
  if (typeof pt === 'object' && typeof pt.y === 'number' && !Number.isNaN(pt.y)) return pt.y;
  return null;
}

function breachValueInBucket(bucketEndMs, stepMs, alertIntervals, seriesMetric) {
  if (!alertIntervals?.length) return null;
  const bucketStart = bucketEndMs - stepMs;
  for (let i = 0; i < alertIntervals.length; i++) {
    const it = alertIntervals[i];
    if (it.metric !== seriesMetric) continue;
    if (it.breachTimestamps?.length) {
      for (let j = 0; j < it.breachTimestamps.length; j++) {
        const breach = it.breachTimestamps[j];
        const ts = breach.timestamp;
        if (ts > bucketStart && ts <= bucketEndMs) {
          const v = breach.actualValue;
          if (v != null && typeof v === 'number' && !Number.isNaN(v)) return v;
        }
      }
    }
  }
  return null;
}

function hasBreachInBucket(bucketEndMs, stepMs, alertIntervals, seriesMetric) {
  if (!alertIntervals?.length) return false;
  const bucketStart = bucketEndMs - stepMs;
  for (let i = 0; i < alertIntervals.length; i++) {
    const it = alertIntervals[i];
    if (it.metric !== seriesMetric) continue;
    if (it.breachTimestamps?.length) {
      for (let j = 0; j < it.breachTimestamps.length; j++) {
        const ts = it.breachTimestamps[j].timestamp;
        if (ts > bucketStart && ts <= bucketEndMs) return true;
      }
    } else {
      const start = new Date(it.firstSeenAt || it.createdAt).getTime();
      const end = new Date(it.lastSeenAt || it.updatedAt || it.createdAt).getTime();
      if (end >= bucketStart && start <= bucketEndMs) return true;
    }
  }
  return false;
}

function aggregateBucketReading(readings, bucketEndMs, stepMs, readValue, readMeta, getMs) {
  const bucketStart = bucketEndMs - stepMs;
  const values = [];
  let lastMeta = null;
  for (let i = 0; i < readings.length; i++) {
    const ts = getMs(readings[i]);
    if (ts <= bucketStart) continue;
    if (ts > bucketEndMs) break;
    const v = readValue(readings[i]);
    if (v != null && typeof v === 'number' && !Number.isNaN(v)) values.push(v);
    lastMeta = readMeta(readings[i]);
  }
  if (!values.length) return { value: null, info: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const info =
    values.length === 1 && lastMeta
      ? lastMeta
      : { min, max, avg: Number(avg.toFixed(2)) };
  return { value: Number(avg.toFixed(2)), info };
}

function calculateRoomAverage(
  bleList,
  bleIdToReadings,
  startMs,
  endMs,
  stepMs,
  timeZone,
  readValue = getTemperature,
  precomputedLabels = null,
  pointCountOverride = null,
) {
  if (bleList.length === 0) return { labels: [], data: [] };

  let labels;
  if (precomputedLabels && precomputedLabels.length > 0) {
    labels = precomputedLabels;
  } else {
    labels = [];
    for (let t = startMs; t <= endMs; t += stepMs) {
      labels.push(formatTimeInTimezone(t, timeZone, false));
    }
  }

  const roomAverages = [];
  const n = pointCountOverride ?? labels.length;

  for (let i = 0; i < n; i++) {
    const bucketEnd = startMs + (i + 1) * stepMs;
    const bucketStart = bucketEnd - stepMs;
    const validTemps = [];

    bleList.forEach((ble) => {
      const readings = bleIdToReadings[ble._id] || [];
      if (readings.length === 0) return;

      let closestReading = null;
      let closestTimeDiff = Infinity;

      readings.forEach((reading) => {
        const readingMs = getReadingTimeMs(reading);
        if (!Number.isFinite(readingMs)) return;
        if (readingMs > bucketStart && readingMs <= bucketEnd) {
          const timeDiff = Math.abs(readingMs - bucketEnd);
          if (timeDiff < closestTimeDiff) {
            closestTimeDiff = timeDiff;
            closestReading = reading;
          }
        }
      });

      if (closestReading) {
        const temp = readValue(closestReading);
        if (temp !== null && temp !== undefined && !Number.isNaN(temp)) {
          validTemps.push(temp);
        }
      }
    });

    if (validTemps.length > 0) {
      const average = validTemps.reduce((sum, x) => sum + x, 0) / validTemps.length;
      roomAverages.push(Number(average.toFixed(2)));
    } else {
      roomAverages.push(null);
    }
  }

  return { labels, data: roomAverages };
}

export function buildClimateChartLabels(startMs, endMs, stepMs, timeZone, includeSeconds, fixedPointCount = null) {
  const labels = [];
  if (fixedPointCount != null && fixedPointCount > 0) {
    for (let i = 0; i < fixedPointCount; i++) {
      labels.push(formatTimeInTimezone(startMs + i * stepMs, timeZone, includeSeconds));
    }
    return labels;
  }
  for (let t = startMs; t <= endMs; t += stepMs) {
    labels.push(formatTimeInTimezone(t, timeZone, includeSeconds));
  }
  return labels;
}

/**
 * @param {string} labelMode 'live' | '24h'
 * @param {object|null} seriesOptions { dataPointCount, useLinearTimeX }
 */
export function buildMultiSeriesUniform(
  bleList,
  bleIdToReadings,
  startMs,
  endMs,
  stepMs,
  alertTimeline = [],
  showAlerts = false,
  tempThresholds = null,
  warehouseStructure = null,
  selectedSpot = null,
  labelMode = '24h',
  timeZone = 'UTC',
  seriesMetric = 'temperature',
  legendCollapseToFirst = true,
  precomputedLabels = null,
  seriesOptions = null,
) {
  const readValue = seriesMetric === 'humidity' ? getHumidity : getTemperature;
  const readMeta = seriesMetric === 'humidity' ? getHumAgg : getTempAgg;
  const opts = seriesOptions || {};
  const useLinearTimeX = Boolean(opts.useLinearTimeX);
  const labels =
    precomputedLabels && precomputedLabels.length > 0
      ? precomputedLabels
      : buildClimateChartLabels(startMs, endMs, stepMs, timeZone, labelMode === 'live');
  const dataPointCount = opts.dataPointCount ?? labels.length;

  const palette = [
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
    '#1976D2',
  ];

  const alertIntervals = (alertTimeline || []).map((a) => {
    const breachTimestamps = a.breachTimestamps || [];
    return {
      breachTimestamps: breachTimestamps.map((bt) => ({
        timestamp: new Date(bt.timestamp).getTime(),
        actualValue: bt.actualValue,
        thresholdValue: bt.thresholdValue,
      })),
      direction: a.direction,
      metric: a.metric,
      thresholdValue: a.thresholdValue,
      actualValue: a.actualValue,
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  });

  const isTsAlertWithValue = (tsMs, value) => {
    if (!showAlerts || alertIntervals.length === 0 || value == null || typeof value !== 'number') return false;

    for (let i = 0; i < alertIntervals.length; i++) {
      const it = alertIntervals[i];
      if (it.metric !== seriesMetric) continue;

      const th = it.thresholdValue != null ? Number(it.thresholdValue) : null;
      if (th === null || typeof th !== 'number') continue;

      let tsMatches = false;
      if (it.breachTimestamps && it.breachTimestamps.length > 0) {
        const tolerance = 60 * 1000;
        for (const breach of it.breachTimestamps) {
          if (Math.abs(tsMs - breach.timestamp) <= tolerance) {
            tsMatches = true;
            break;
          }
        }
      } else {
        const start = new Date(it.firstSeenAt || it.createdAt).getTime();
        const end = new Date(it.lastSeenAt || it.updatedAt || it.createdAt).getTime();
        tsMatches = tsMs >= start && tsMs <= end;
      }

      if (!tsMatches) continue;

      const direction = (it.direction || '').toLowerCase();
      if (direction === 'high' && value > th) return true;
      if (direction === 'low' && value < th) return true;
    }
    return false;
  };

  const datasets =
    selectedSpot === 'average'
      ? []
      : bleList.map((ble, idx) => {
          const readings = (bleIdToReadings[ble._id] || []).slice().sort((a, b) => {
            return getReadingTimeMs(a) - getReadingTimeMs(b);
          });
          let rIdx = 0;
          const getMs = (r) => {
            const ms = getReadingTimeMs(r);
            return Number.isFinite(ms) ? ms : 0;
          };
          const temps = [];
          const metaAgg = [];
          const pointColors = [];
          const pointBorderColors = [];
          const color = palette[idx % palette.length];
          const useBucketAggregate = stepMs > 60 * 1000;

          for (let i = 0; i < dataPointCount; i++) {
            const bucketEnd = startMs + (i + 1) * stepMs;
            let value = null;
            let info = null;
            let isAlert = false;

            if (readings.length > 0) {
              if (useBucketAggregate) {
                const agg = aggregateBucketReading(readings, bucketEnd, stepMs, readValue, readMeta, getMs);
                value = agg.value;
                info = agg.info;
              } else {
                const t = bucketEnd;
                while (rIdx + 1 < readings.length && getMs(readings[rIdx + 1]) <= t) {
                  rIdx++;
                }
                const ts = getMs(readings[rIdx] || {});
                if (ts > 0 && ts <= t && ts > t - stepMs) {
                  const r = readings[rIdx];
                  value = readValue(r);
                  info = readMeta(r);
                }
              }

              if (showAlerts && seriesMetric === 'temperature') {
                const bucketBreach = hasBreachInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric);
                if (bucketBreach) {
                  isAlert = true;
                  if (value == null) {
                    const breachVal = breachValueInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric);
                    if (breachVal != null) value = breachVal;
                  }
                } else if (value != null) {
                  isAlert = isTsAlertWithValue(bucketEnd, value);
                }
              }
            } else if (showAlerts && seriesMetric === 'temperature') {
              isAlert = hasBreachInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric);
              if (isAlert && value == null) {
                const breachVal = breachValueInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric);
                if (breachVal != null) value = breachVal;
              }
            }

            temps.push(value);
            metaAgg.push(info);

            if (showAlerts && seriesMetric === 'temperature') {
              if (isAlert) {
                pointColors.push('#FF1744');
                pointBorderColors.push('#FF1744');
              } else {
                pointColors.push('#FFFFFF');
                pointBorderColors.push('#ebff9e');
              }
            } else {
              pointColors.push('#FFFFFF');
              pointBorderColors.push('#ebff9e');
            }
          }
          const mac = ble.macAddress || '';
          const macTail = mac ? mac.slice(-5) : '';
          const metricTag = seriesMetric === 'humidity' ? ' · RH%' : '';
          return {
            label: `${ble.name || 'BLE'}${macTail ? ` (${macTail})` : ''}${metricTag}`,
            data: valuesToTimeSeriesData(temps, startMs, stepMs, useLinearTimeX),
            borderColor: color,
            backgroundColor: `${color}1A`,
            tension: 0.3,
            fill: false,
            spanGaps: true,
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: pointColors,
            pointBorderColor: pointBorderColors,
            pointBorderWidth: 2,
            pointHitRadius: 8,
            pointStyle: 'circle',
            metaAgg,
          };
        });

  if (bleList.length > 1 || selectedSpot === 'average') {
    if (selectedSpot === 'average') {
      if (bleList.length > 0) {
        const roomAverage = calculateRoomAverage(
          bleList,
          bleIdToReadings,
          startMs,
          endMs,
          stepMs,
          timeZone,
          readValue,
          labels,
          dataPointCount,
        );
        const pointBgColors = roomAverage.data.map((v, idx) => {
          if (!showAlerts || seriesMetric !== 'temperature') return '#FFFFFF';
          const bucketEnd = startMs + (idx + 1) * stepMs;
          if (hasBreachInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric)) return '#FF1744';
          if (v == null) return '#FFFFFF';
          return isTsAlertWithValue(bucketEnd, v) ? '#FF1744' : '#FFFFFF';
        });
        const pointBorderColorsAvg = roomAverage.data.map((v, idx) => {
          if (!showAlerts || seriesMetric !== 'temperature') return '#FFC107';
          const bucketEnd = startMs + (idx + 1) * stepMs;
          if (hasBreachInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric)) return '#FF1744';
          if (v == null) return '#FFC107';
          return isTsAlertWithValue(bucketEnd, v) ? '#FF1744' : '#FFC107';
        });
        const roomAvgData = roomAverage.data.map((v, idx) => {
          if (v != null || !showAlerts || seriesMetric !== 'temperature') return v;
          const bucketEnd = startMs + (idx + 1) * stepMs;
          return breachValueInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric) ?? v;
        });

        datasets.push({
          label: seriesMetric === 'humidity' ? 'Room average · RH%' : 'Room Average',
          data: valuesToTimeSeriesData(roomAvgData, startMs, stepMs, useLinearTimeX),
          borderColor: '#FFC107',
          backgroundColor: '#FFC1071A',
          tension: 0.3,
          fill: false,
          spanGaps: true,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: pointBgColors,
          pointBorderColor: pointBorderColorsAvg,
          pointBorderWidth: 3,
          pointHitRadius: 8,
          pointStyle: 'rect',
          borderWidth: 3,
        });
      }
    } else {
      const roomGroups = {};
      bleList.forEach((ble) => {
        const roomId = ble.room?._id || ble.room;
        if (!roomId) return;

        if (!roomGroups[roomId]) {
          let roomName = 'Unknown Room';

          if (ble.room && typeof ble.room === 'object' && ble.room.name) {
            roomName = ble.room.name;
          } else if (warehouseStructure && warehouseStructure.rooms) {
            const room = warehouseStructure.rooms.find((r) => r._id === roomId);
            if (room && room.name) {
              roomName = room.name;
            } else {
              roomName = `Room ${roomId.slice(-4)}`;
            }
          } else if (typeof ble.room === 'string') {
            if (ble.room.length > 20) {
              roomName = `Room ${roomId.slice(-4)}`;
            } else {
              roomName = ble.room;
            }
          } else {
            roomName = `Room ${roomId.slice(-4)}`;
          }

          roomGroups[roomId] = {
            roomName,
            devices: [],
          };
        }
        roomGroups[roomId].devices.push(ble);
      });

      const roomColors = ['#FFC107', '#FFC107', '#FFC107', '#FFC107', '#FFC107'];
      let colorIndex = 0;

      Object.entries(roomGroups).forEach(([, roomData]) => {
        if (roomData.devices.length > 1) {
          const roomAverage = calculateRoomAverage(
            roomData.devices,
            bleIdToReadings,
            startMs,
            endMs,
            stepMs,
            timeZone,
            readValue,
            labels,
            dataPointCount,
          );
          const pointBgColors = roomAverage.data.map((v, idx) => {
            if (!showAlerts || seriesMetric !== 'temperature') return '#FFFFFF';
            const bucketEnd = startMs + (idx + 1) * stepMs;
            if (hasBreachInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric)) return '#FF1744';
            if (v == null) return '#FFFFFF';
            return isTsAlertWithValue(bucketEnd, v) ? '#FF1744' : '#FFFFFF';
          });
          const pointBorderColorsRm = roomAverage.data.map((v, idx) => {
            if (!showAlerts || seriesMetric !== 'temperature')
              return roomColors[colorIndex % roomColors.length];
            const bucketEnd = startMs + (idx + 1) * stepMs;
            if (hasBreachInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric)) return '#FF1744';
            if (v == null) return roomColors[colorIndex % roomColors.length];
            return isTsAlertWithValue(bucketEnd, v) ? '#FF1744' : roomColors[colorIndex % roomColors.length];
          });
          const roomAvgData = roomAverage.data.map((v, idx) => {
            if (v != null || !showAlerts || seriesMetric !== 'temperature') return v;
            const bucketEnd = startMs + (idx + 1) * stepMs;
            return breachValueInBucket(bucketEnd, stepMs, alertIntervals, seriesMetric) ?? v;
          });

          datasets.push({
            label: seriesMetric === 'humidity' ? `${roomData.roomName} avg · RH%` : `${roomData.roomName} Average`,
            data: valuesToTimeSeriesData(roomAvgData, startMs, stepMs, useLinearTimeX),
            borderColor: roomColors[colorIndex % roomColors.length],
            backgroundColor: `${roomColors[colorIndex % roomColors.length]}1A`,
            tension: 0.3,
            fill: false,
            spanGaps: true,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: pointBgColors,
            pointBorderColor: pointBorderColorsRm,
            pointBorderWidth: 3,
            pointHitRadius: 8,
            pointStyle: 'rect',
            borderWidth: 3,
          });

          colorIndex++;
        }
      });
    }
  }

  if (legendCollapseToFirst) {
    datasets.forEach((ds, i) => {
      ds.hidden = i !== 0;
    });
  }

  return { labels, datasets, useLinearTimeX };
}
