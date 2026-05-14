import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { axios, unwrap, setAuthToken } from '../api.js';
import { clearSession, getToken, getUser } from '../session.js';
import { latestFromReadings } from '../sensorHelpers.js';
import {
  getBrowserTimeZone,
  getCurrentHourUtcWindow,
  buildUtcRangeForDate,
  getCalendarYmdInTimeZone,
  addCalendarDaysToYmd,
} from '../timeWindow.js';
import { buildClimateChartLabels, buildMultiSeriesUniform } from '../climateChartMulti.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const LIVE_MS = 5 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const BLE_FETCH_CONCURRENCY = 6;
const CHART_STEP_MS = 60 * 1000;

function authHeaders() {
  const t = getToken();
  return t ? { 'x-auth-token': t } : {};
}

function companyIdFromUser(user) {
  if (!user) return '';
  if (user.company && typeof user.company === 'object' && user.company._id) return String(user.company._id);
  if (user.company) return String(user.company);
  return '';
}

function ageMs(ts) {
  if (!ts) return Infinity;
  const ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return Infinity;
  return Date.now() - ms;
}

function streamStatus(ts) {
  const age = ageMs(ts);
  if (age === Infinity) return 'dead';
  if (age <= LIVE_MS) return 'live';
  if (age <= STALE_MS) return 'stale';
  return 'dead';
}

function roomRollup(statuses) {
  if (!statuses.length) return 'dead';
  const lives = statuses.filter((s) => s === 'live').length;
  const stales = statuses.filter((s) => s === 'stale').length;
  if (lives === statuses.length) return 'live';
  if (lives > 0) return 'mixed';
  if (stales > 0) return 'stale';
  return 'dead';
}

function buildRoomIndex(warehouse) {
  const map = new Map();
  const floors = warehouse?.floors || [];
  for (const floor of floors) {
    for (const room of floor.rooms || []) {
      if (room?._id) {
        map.set(String(room._id), {
          name: room.name || 'Room',
          floor: floor.name || '',
          type: room.type || '',
        });
      }
    }
  }
  return map;
}

async function mapPool(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await mapper(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Smart °C axis from all plotted temperature values (matches web Dashboard). */
function computeTempYAxisRangeFromDatasets(multiTempSeries, roomConfiguration) {
  const allTemps = [];
  for (const ds of multiTempSeries?.datasets || []) {
    for (const value of ds.data || []) {
      if (typeof value === 'number' && !Number.isNaN(value)) allTemps.push(value);
    }
  }
  if (allTemps.length === 0) return null;

  const minTemp = Math.min(...allTemps);
  const maxTemp = Math.max(...allTemps);
  const range = maxTemp - minTemp;

  let spacing;
  if (range <= 10) {
    spacing = 5;
  } else if (range <= 25) {
    spacing = 5;
  } else if (range <= 50) {
    spacing = 10;
  } else {
    spacing = 20;
  }

  const paddingPercent = Math.max(0.1, Math.min(0.2, spacing / (range || 1)));
  const padding = Math.max(spacing, range * paddingPercent);

  let min = Math.max(0, Math.floor((minTemp - padding) / spacing) * spacing);
  let max = Math.ceil((maxTemp + padding) / spacing) * spacing;
  if (min < 0) min = 0;

  if (roomConfiguration && roomConfiguration.temperature) {
    const thresholdMin = roomConfiguration.temperature.min;
    const thresholdMax = roomConfiguration.temperature.max;

    if (typeof thresholdMin === 'number' && thresholdMin < min) {
      min = Math.floor((thresholdMin - padding) / spacing) * spacing;
      if (min < 0) min = 0;
    }
    if (typeof thresholdMax === 'number' && thresholdMax > max) {
      max = Math.ceil((thresholdMax + padding) / spacing) * spacing;
    }
  }

  return { min, max, spacing };
}

export default function DashboardPage({ onLogout }) {
  const user = getUser();
  const isSuperadmin = user?.role === 'superadmin';
  const defaultCompanyId = companyIdFromUser(user);

  const browserTimeZone = useMemo(() => getBrowserTimeZone(), []);

  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [warehouseDoc, setWarehouseDoc] = useState(null);
  const [bles, setBles] = useState([]);
  const [bleSnapshots, setBleSnapshots] = useState({});
  const [warehouseStructure, setWarehouseStructure] = useState(null);
  const [selectedRoom, setSelectedRoom] = useState('');
  const [selectedSpot, setSelectedSpot] = useState('average');
  const [bleReadingsMap, setBleReadingsMap] = useState({});
  const [roomConfiguration, setRoomConfiguration] = useState(null);
  const [chartMode, setChartMode] = useState('24h');
  const [chartDate, setChartDate] = useState(() => getCalendarYmdInTimeZone(new Date(), getBrowserTimeZone()));
  const [loading, setLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState(null);

  const roomIndex = useMemo(() => buildRoomIndex(warehouseDoc), [warehouseDoc]);

  const linkedRoomIdsForWarehouse = useMemo(() => {
    if (!warehouseId) return new Set();
    const set = new Set();
    for (const d of bles || []) {
      const wid = d?.warehouse?._id || d?.warehouse;
      if (String(wid || '') !== String(warehouseId)) continue;
      const rid = d?.room?._id || d?.room;
      if (rid) set.add(String(rid));
    }
    return set;
  }, [bles, warehouseId]);

  const structureRoomsList = warehouseStructure?.rooms || [];
  const spotsList = warehouseStructure?.spots || [];

  const roomsList = useMemo(() => {
    if (!warehouseId) return [];
    const linked = linkedRoomIdsForWarehouse;
    return (structureRoomsList || []).filter((r) => linked.has(String(r._id)));
  }, [structureRoomsList, linkedRoomIdsForWarehouse, warehouseId]);

  const roomIds = useMemo(() => new Set((roomsList || []).map((r) => String(r._id))), [roomsList]);
  const safeSelectedRoom =
    selectedRoom && roomIds.has(String(selectedRoom)) ? String(selectedRoom) : '';

  const spotIdsForRoom = useMemo(
    () =>
      new Set(
        (spotsList || []).filter((s) => String(s.roomId) === String(safeSelectedRoom)).map((s) => s._id),
      ),
    [spotsList, safeSelectedRoom],
  );
  const safeSelectedSpot =
    selectedSpot === 'average' || (selectedSpot && spotIdsForRoom.has(selectedSpot))
      ? selectedSpot
      : 'average';

  const visibleBleDevices = useMemo(() => {
    let arr = bles || [];
    if (warehouseId) {
      arr = arr.filter((d) => String(d?.warehouse?._id || d?.warehouse || '') === String(warehouseId));
    }
    if (!safeSelectedRoom) return [];
    arr = arr.filter((d) => {
      const r = d?.room;
      const rid = r && r._id ? r._id : r;
      return String(rid || '') === String(safeSelectedRoom);
    });
    if (safeSelectedSpot && safeSelectedSpot !== 'average') {
      arr = arr.filter((d) => {
        const s = d?.spot;
        const sid = s && s._id ? s._id : s;
        return sid === safeSelectedSpot;
      });
    }
    return arr;
  }, [bles, warehouseId, safeSelectedRoom, safeSelectedSpot]);

  const chartTimeWindow = useMemo(() => {
    if (chartMode === '24h') {
      const range = buildUtcRangeForDate(chartDate, browserTimeZone);
      return { startMs: range.startMs, endMs: range.endMs, startIso: range.startIso, endIso: range.endIso };
    }
    const w = getCurrentHourUtcWindow(browserTimeZone);
    return { startMs: w.startMs, endMs: w.endMs, startIso: w.startIso, endIso: w.endIso };
  }, [chartMode, chartDate, browserTimeZone]);

  useLayoutEffect(() => {
    if (chartMode !== 'live') return;
    const today = getCalendarYmdInTimeZone(new Date(), browserTimeZone);
    setChartDate((prev) => (prev === today ? prev : today));
  }, [chartMode, browserTimeZone]);

  const climateChartLabels = useMemo(
    () =>
      buildClimateChartLabels(
        chartTimeWindow.startMs,
        chartTimeWindow.endMs,
        CHART_STEP_MS,
        browserTimeZone,
        chartMode === 'live',
      ),
    [chartTimeWindow, browserTimeZone, chartMode],
  );

  const tempThresholds =
    roomConfiguration && roomConfiguration.temperature ? roomConfiguration.temperature : null;
  const humThresholds = roomConfiguration && roomConfiguration.humidity ? roomConfiguration.humidity : null;

  const multiTempSeries = useMemo(
    () =>
      buildMultiSeriesUniform(
        visibleBleDevices,
        bleReadingsMap,
        chartTimeWindow.startMs,
        chartTimeWindow.endMs,
        CHART_STEP_MS,
        [],
        false,
        tempThresholds,
        warehouseStructure,
        safeSelectedSpot,
        chartMode,
        browserTimeZone,
        'temperature',
        true,
        climateChartLabels,
      ),
    [
      visibleBleDevices,
      bleReadingsMap,
      chartTimeWindow,
      climateChartLabels,
      tempThresholds,
      warehouseStructure,
      safeSelectedSpot,
      browserTimeZone,
      chartMode,
    ],
  );

  const multiHumSeries = useMemo(
    () =>
      buildMultiSeriesUniform(
        visibleBleDevices,
        bleReadingsMap,
        chartTimeWindow.startMs,
        chartTimeWindow.endMs,
        CHART_STEP_MS,
        [],
        false,
        humThresholds,
        warehouseStructure,
        safeSelectedSpot,
        chartMode,
        browserTimeZone,
        'humidity',
        true,
        climateChartLabels,
      ),
    [
      visibleBleDevices,
      bleReadingsMap,
      chartTimeWindow,
      climateChartLabels,
      humThresholds,
      warehouseStructure,
      safeSelectedSpot,
      browserTimeZone,
      chartMode,
    ],
  );

  const combinedClimateChartData = useMemo(() => {
    const temp = multiTempSeries;
    const hum = multiHumSeries;
    if (!temp?.labels?.length) return { labels: [], datasets: [] };
    const tempDs = (temp.datasets || []).map((ds) => ({ ...ds, yAxisID: 'y' }));
    const humDs = (hum?.datasets || []).map((ds) => ({
      ...ds,
      yAxisID: 'y1',
      hidden: true,
    }));
    return { labels: temp.labels, datasets: [...tempDs, ...humDs] };
  }, [multiTempSeries, multiHumSeries]);

  const yAxisRangeTemp = useMemo(
    () => computeTempYAxisRangeFromDatasets(multiTempSeries, roomConfiguration),
    [multiTempSeries, roomConfiguration],
  );
  const yAxisRangeHum = useMemo(() => ({ min: 0, max: 100, spacing: 20 }), []);

  const chartData = combinedClimateChartData;

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true },
        title: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const ds = ctx.dataset;
              const idx = ctx.dataIndex;
              const value = ctx.parsed?.y;
              const info = Array.isArray(ds.metaAgg) ? ds.metaAgg[idx] : null;
              const isHum = ds.yAxisID === 'y1';
              const parts = [];
              const f = (v) => (typeof v === 'number' ? (isHum ? Number(v).toFixed(1) : Number(v).toFixed(2)) : '-');
              const uMin = isHum ? ' %RH' : ' °C';
              const uAvg = isHum ? ' %RH' : ' °C';
              if (info && typeof info === 'object') {
                const min = typeof info.min === 'number' ? info.min : undefined;
                const max = typeof info.max === 'number' ? info.max : undefined;
                const avg =
                  typeof info.avg === 'number' ? info.avg : typeof value === 'number' ? value : undefined;
                parts.push(`Min: ${f(min)}${uMin}`, `Max: ${f(max)}${uMin}`, `Avg: ${f(avg)}${uAvg}`);
              } else {
                parts.push(`Avg: ${f(value)}${uAvg}`);
              }
              return parts;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false, color: 'rgba(255,255,255,0.06)' },
          ticks: {
            autoSkip: false,
            maxRotation: 0,
            color: '#9ca3af',
            callback(value) {
              const label = this.getLabelForValue(value);
              if (chartMode === 'live') {
                const match = label.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
                if (match) {
                  const hour = parseInt(match[1], 10);
                  const minute = parseInt(match[2], 10);
                  const second = parseInt(match[3], 10);
                  if (minute % 15 === 0 && second === 0) {
                    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
                  }
                  return '';
                }
              } else if (chartMode === '24h') {
                const match = label.match(/^(\d{1,2}):(\d{2})/);
                if (match) {
                  const hour = parseInt(match[1], 10);
                  const minute = parseInt(match[2], 10);
                  if (minute === 0 && hour % 4 === 0) return label;
                  return '';
                }
              }
              return label;
            },
          },
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'Temperature (°C)', color: '#9ca3af' },
          grid: { color: 'rgba(200,200,200,0.12)' },
          ticks: { color: '#9ca3af' },
          ...(yAxisRangeTemp
            ? {
                min: yAxisRangeTemp.min,
                max: yAxisRangeTemp.max,
                ticks: {
                  color: '#9ca3af',
                  stepSize: yAxisRangeTemp.spacing,
                  callback: (v) => `${v}°C`,
                },
              }
            : {}),
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: 'Humidity (% RH)', color: '#9ca3af' },
          grid: { drawOnChartArea: false },
          ticks: { color: '#9ca3af' },
          ...(yAxisRangeHum
            ? {
                min: yAxisRangeHum.min,
                max: yAxisRangeHum.max,
                ticks: {
                  color: '#9ca3af',
                  stepSize: yAxisRangeHum.spacing,
                  callback: (v) => `${v}%`,
                },
              }
            : {}),
        },
      },
    }),
    [chartMode, yAxisRangeTemp, yAxisRangeHum],
  );

  const todayCalendarYmd = getCalendarYmdInTimeZone(new Date(), browserTimeZone);

  const logout = useCallback(async () => {
    const t = getToken();
    try {
      if (t) await axios.post('/api/auth/logout', {}, { headers: { 'x-auth-token': t }, timeout: 5000 });
    } catch {
      /* ignore */
    }
    clearSession();
    setAuthToken(null);
    onLogout();
  }, [onLogout]);

  useEffect(() => {
    if (!isSuperadmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get('/api/companies', { headers: authHeaders() });
        const list = Array.isArray(res.data) ? res.data : unwrap(res) || [];
        if (!cancelled) setCompanies(list);
      } catch {
        if (!cancelled) setCompanies([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperadmin]);

  const fetchWarehouses = useCallback(async () => {
    const cid = companyId || defaultCompanyId;
    if (!cid) {
      setWarehouses([]);
      return;
    }
    const res = await axios.get('/api/warehouses', {
      params: { company: cid },
      headers: authHeaders(),
    });
    const list = Array.isArray(res.data) ? res.data : [];
    setWarehouses(list);
    if (list.length && !list.find((w) => String(w._id) === String(warehouseId))) {
      setWarehouseId(String(list[0]._id));
    }
  }, [companyId, defaultCompanyId, warehouseId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetchWarehouses();
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.message || e.message || 'Failed to load warehouses');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchWarehouses]);

  useEffect(() => {
    if (!warehouseId) {
      setWarehouseDoc(null);
      return;
    }
    const wh = warehouses.find((w) => String(w._id) === String(warehouseId));
    setWarehouseDoc(wh || null);
  }, [warehouseId, warehouses]);

  useEffect(() => {
    let cancelled = false;
    async function fetchStructure() {
      if (!warehouseId) {
        setWarehouseStructure(null);
        return;
      }
      try {
        const res = await axios.get(`/api/warehouses/${warehouseId}/structure`, { headers: authHeaders() });
        if (!cancelled) setWarehouseStructure(res.data || null);
      } catch {
        if (!cancelled) setWarehouseStructure(null);
      }
    }
    fetchStructure();
    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  useEffect(() => {
    if (!warehouseId) return;
    if (roomsList.length > 0) {
      setSelectedRoom((prev) => {
        const p = prev ? String(prev) : '';
        const next = p && roomIds.has(p) ? p : String(roomsList[0]._id);
        if (next !== p) queueMicrotask(() => setSelectedSpot('average'));
        return next;
      });
    } else {
      setSelectedRoom('');
      setSelectedSpot('average');
    }
  }, [warehouseId, roomIds, roomsList]);

  useEffect(() => {
    let cancelled = false;
    async function fetchRoomConfiguration() {
      if (!safeSelectedRoom || !warehouseId) {
        setRoomConfiguration(null);
        return;
      }
      try {
        const res = await axios.get(`/api/warehouses/${warehouseId}`, { headers: authHeaders() });
        if (cancelled) return;
        const warehouse = res.data;
        let roomConfig = null;
        for (const floor of warehouse.floors || []) {
          for (const room of floor.rooms || []) {
            if (room._id === safeSelectedRoom) {
              roomConfig = {
                temperature: room.temperature || { min: null, max: null },
                humidity: room.humidity || { min: null, max: null },
              };
              break;
            }
          }
          if (roomConfig) break;
        }
        setRoomConfiguration(roomConfig);
      } catch {
        if (!cancelled) setRoomConfiguration(null);
      }
    }
    fetchRoomConfiguration();
    return () => {
      cancelled = true;
    };
  }, [safeSelectedRoom, warehouseId]);

  const loadBleHealth = useCallback(async () => {
    const cid = companyId || defaultCompanyId;
    if (!cid || !warehouseId) {
      setBles([]);
      setBleSnapshots({});
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await axios.get('/api/devices', {
        params: { type: 'ble', company: cid, warehouse: warehouseId },
        headers: authHeaders(),
      });
      const list = Array.isArray(res.data) ? res.data : [];
      setBles(list);

      const snaps = await mapPool(list, BLE_FETCH_CONCURRENCY, async (d) => {
        const id = d._id;
        try {
          const r = await axios.get(`/api/devices/${id}/sensor-data`, {
            params: { limit: 120 },
            headers: authHeaders(),
          });
          const readings = Array.isArray(r.data) ? r.data : [];
          const latest = latestFromReadings(readings);
          return [String(id), { ...latest, status: streamStatus(latest.timestamp) }];
        } catch {
          return [String(id), { temperature: null, humidity: null, timestamp: null, status: 'dead' }];
        }
      });
      const map = {};
      for (const [id, snap] of snaps) map[id] = snap;
      setBleSnapshots(map);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Failed to load devices');
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  }, [companyId, defaultCompanyId, warehouseId]);

  useEffect(() => {
    loadBleHealth();
  }, [loadBleHealth]);

  useEffect(() => {
    const id = setInterval(() => {
      loadBleHealth();
    }, 45000);
    return () => clearInterval(id);
  }, [loadBleHealth]);

  const loadChart = useCallback(async () => {
    const ids = visibleBleDevices.map((d) => d._id);
    if (!ids.length) {
      setBleReadingsMap({});
      setChartLoading(false);
      return;
    }
    setChartLoading(true);
    try {
      const { startIso, endIso } = chartTimeWindow;
      const results = await Promise.allSettled(
        ids.map((id) =>
          axios.get(`/api/devices/${id}/sensor-data`, {
            params: {
              start: startIso,
              end: endIso,
              limit: 5000,
            },
            headers: authHeaders(),
          }),
        ),
      );
      const nextMap = {};
      results.forEach((r, i) => {
        const id = ids[i];
        if (r.status === 'fulfilled') {
          const data = Array.isArray(r.value.data) ? r.value.data : [];
          nextMap[id] = data;
        } else {
          nextMap[id] = [];
        }
      });
      setBleReadingsMap(nextMap);
    } catch {
      setBleReadingsMap({});
    } finally {
      setChartLoading(false);
    }
  }, [visibleBleDevices, chartTimeWindow]);

  useEffect(() => {
    loadChart();
  }, [loadChart]);

  const handleModeChange = (next) => {
    if (next === chartMode) return;
    setChartMode(next);
    if (next === 'live') {
      setChartDate(getCalendarYmdInTimeZone(new Date(), browserTimeZone));
    }
  };

  const handleDateStep = (deltaDays) => {
    const next = addCalendarDaysToYmd(chartDate, deltaDays, browserTimeZone);
    const today = getCalendarYmdInTimeZone(new Date(), browserTimeZone);
    const clamped = next > today ? today : next;
    setChartDate(clamped);
    if (chartMode === 'live' && clamped !== today) {
      setChartMode('24h');
    }
  };

  const roomsGrouped = useMemo(() => {
    const groups = new Map();
    for (const d of bles) {
      const rid = d.room ? String(d.room) : '_unassigned';
      if (!groups.has(rid)) groups.set(rid, []);
      groups.get(rid).push(d);
    }
    return groups;
  }, [bles]);

  const roomCards = useMemo(() => {
    const out = [];
    for (const [roomKey, devices] of roomsGrouped.entries()) {
      const meta =
        roomKey === '_unassigned'
          ? { name: 'Unassigned', floor: '', type: '' }
          : roomIndex.get(roomKey) || { name: 'Room', floor: '', type: '' };
      const statuses = devices.map((d) => bleSnapshots[String(d._id)]?.status || 'dead');
      const rollup = roomRollup(statuses);
      out.push({
        roomKey,
        meta,
        devices,
        rollup,
        live: statuses.filter((s) => s === 'live').length,
        total: devices.length,
      });
    }
    out.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
    return out;
  }, [roomsGrouped, roomIndex, bleSnapshots]);

  const hasChartPoints = useMemo(() => {
    const check = (series) => {
      for (const ds of series?.datasets || []) {
        if (ds.data?.some((v) => typeof v === 'number' && !Number.isNaN(v))) return true;
      }
      return false;
    };
    return check(multiTempSeries) || check(multiHumSeries);
  }, [multiTempSeries, multiHumSeries]);

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <div className="dash-title">Monitor</div>
          <div className="dash-sub">
            {warehouseDoc?.warehouseName || 'Warehouse'} ·{' '}
            {lastRefresh ? lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
          </div>
        </div>
        <button type="button" className="btn-ghost" onClick={logout}>
          Log out
        </button>
      </header>

      {error ? <div className="banner-error">{error}</div> : null}

      <section className="filters">
        {isSuperadmin ? (
          <label className="select-wrap">
            <span>Company</span>
            <select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setWarehouseId('');
                setSelectedRoom('');
                setSelectedSpot('average');
              }}
            >
              <option value="">Select company</option>
              {companies.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name || c._id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="select-wrap grow">
          <span>Warehouse</span>
          <select
            value={warehouseId}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setSelectedRoom('');
              setSelectedSpot('average');
            }}
            disabled={!warehouses.length}
          >
            <option value="">{warehouses.length ? 'Select warehouse' : 'No warehouses'}</option>
            {warehouses.map((w) => (
              <option key={w._id} value={w._id}>
                {w.warehouseName || w._id}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="legend-row">
        <span className="pill live">Live ≤5m</span>
        <span className="pill stale">Stale</span>
        <span className="pill dead">No data / old</span>
      </section>

      <section className="rooms">
        {roomCards.map((card) => (
          <article key={card.roomKey} className={`room-card roll-${card.rollup}`}>
            <div className="room-head">
              <div>
                <div className="room-name">{card.meta.name}</div>
                {card.meta.floor ? <div className="room-floor">{card.meta.floor}</div> : null}
              </div>
              <div className={`room-badge roll-${card.rollup}`}>
                {card.rollup === 'live' && 'Healthy'}
                {card.rollup === 'mixed' && 'Partial'}
                {card.rollup === 'stale' && 'Check'}
                {card.rollup === 'dead' && 'Offline'}
              </div>
            </div>
            <div className="room-meta">
              {card.live}/{card.total} sensors live
            </div>
            <ul className="ble-list">
              {card.devices.map((d) => {
                const snap = bleSnapshots[String(d._id)] || {};
                const st = snap.status || 'dead';
                return (
                  <li key={d._id} className={`ble-row st-${st}`}>
                    <div className="ble-name">{d.name || d.macAddress || d._id}</div>
                    <div className="ble-val">
                      {snap.temperature != null ? `${Number(snap.temperature).toFixed(1)}°C` : '—'}
                      {snap.humidity != null ? ` · ${Number(snap.humidity).toFixed(0)}%` : ''}
                    </div>
                    <div className="ble-ts">{snap.timestamp ? new Date(snap.timestamp).toLocaleString() : 'No data'}</div>
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
        {!roomCards.length && !loading ? <p className="empty">No BLE devices linked to this warehouse.</p> : null}
      </section>

      <section className="chart-section">
        <div className="chart-head">
          <h2>Temperature &amp; humidity vs time</h2>
        </div>
        <div className="chart-room-row">
          <label className="select-wrap grow">
            <span>Room</span>
            <select
              value={safeSelectedRoom}
              onChange={(e) => {
                setSelectedRoom(e.target.value);
                setSelectedSpot('average');
              }}
              disabled={!roomsList.length}
            >
              <option value="">{roomsList.length ? 'Select room' : 'No mapped rooms'}</option>
              {roomsList.map((r) => (
                <option key={r._id} value={String(r._id)}>
                  {r.name || r._id}
                </option>
              ))}
            </select>
          </label>
          {safeSelectedRoom ? (
            <label className="select-wrap grow">
              <span>Spot</span>
              <select value={safeSelectedSpot} onChange={(e) => setSelectedSpot(e.target.value)}>
                <option value="average">Average</option>
                {(spotsList || [])
                  .filter((s) => String(s.roomId) === String(safeSelectedRoom))
                  .map((s) => (
                    <option key={s._id} value={String(s._id)}>
                      {s.type || s.name || 'Spot'}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="chart-controls">
          <div className="chart-date-row">
            <button
              type="button"
              className="btn-icon"
              aria-label="Previous day"
              onClick={() => handleDateStep(-1)}
              disabled={chartMode === 'live'}
            >
              ‹
            </button>
            <label className="date-wrap">
              <span>Date</span>
              <input
                type="date"
                value={chartDate}
                max={todayCalendarYmd}
                disabled={chartMode === 'live'}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const today = getCalendarYmdInTimeZone(new Date(), browserTimeZone);
                  setChartDate(v > today ? today : v);
                  if (chartMode === 'live') setChartMode('24h');
                }}
              />
            </label>
            <button
              type="button"
              className="btn-icon"
              aria-label="Next day"
              onClick={() => handleDateStep(1)}
              disabled={chartMode === 'live' || chartDate >= todayCalendarYmd}
            >
              ›
            </button>
          </div>
          <div className="chart-mode-row">
            <span className="mode-label">View</span>
            <button
              type="button"
              className={chartMode === 'live' ? 'btn-mode active' : 'btn-mode'}
              onClick={() => handleModeChange('live')}
            >
              Live
            </button>
            <button
              type="button"
              className={chartMode === '24h' ? 'btn-mode active' : 'btn-mode'}
              onClick={() => handleModeChange('24h')}
            >
              24h
            </button>
            <button type="button" className="btn-mode outline" onClick={() => loadChart()} disabled={chartLoading}>
              {chartLoading ? '…' : 'Reload chart'}
            </button>
          </div>
        </div>
        <p className="chart-hint">
          One chart: <strong>left</strong> axis = °C, <strong>right</strong> = % RH. Only the first temperature line is
          on by default; use the legend for other BLEs, room average, and humidity. X-axis: <strong>24h</strong> every 4
          hours; <strong>Live</strong> every 15 minutes.
        </p>
        <div className="chart-box">
          {chartLoading ? (
            <div className="chart-loading">Loading chart…</div>
          ) : visibleBleDevices.length > 0 && hasChartPoints ? (
            <Line data={chartData} options={chartOptions} />
          ) : (
            <div className="chart-loading">
              {!visibleBleDevices.length
                ? safeSelectedRoom
                  ? 'No BLE devices in this room/spot for the chart.'
                  : roomsList.length === 0
                    ? 'No rooms with linked BLEs in this warehouse.'
                    : 'Select a room to load the chart.'
                : 'No readings in this window.'}
            </div>
          )}
        </div>
      </section>

      <style>{`
        .dash {
          min-height: 100%;
          padding: 0.75rem 0.85rem 1.5rem;
          max-width: 720px;
          margin: 0 auto;
        }
        .dash-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 0.75rem;
        }
        .dash-title {
          font-size: 1.35rem;
          font-weight: 700;
          color: var(--cg-text);
        }
        .dash-sub {
          font-size: 0.8rem;
          color: var(--cg-muted);
          margin-top: 0.15rem;
        }
        .btn-ghost {
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: var(--cg-muted);
          padding: 0.45rem 0.75rem;
          border-radius: 10px;
          cursor: pointer;
        }
        .banner-error {
          background: rgba(239, 68, 68, 0.12);
          color: #fecaca;
          padding: 0.6rem 0.75rem;
          border-radius: 10px;
          font-size: 0.85rem;
          margin-bottom: 0.75rem;
        }
        .filters {
          display: flex;
          flex-wrap: wrap;
          gap: 0.65rem;
          margin-bottom: 0.65rem;
        }
        .select-wrap {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          font-size: 0.72rem;
          color: var(--cg-muted);
          min-width: 140px;
        }
        .select-wrap.grow {
          flex: 1;
          min-width: 180px;
        }
        .select-wrap select {
          padding: 0.55rem 0.65rem;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: var(--cg-surface);
          color: var(--cg-text);
        }
        .legend-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
          margin-bottom: 0.85rem;
        }
        .pill {
          font-size: 0.68rem;
          padding: 0.2rem 0.5rem;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .pill.live {
          border-color: rgba(34, 197, 94, 0.5);
          color: #86efac;
        }
        .pill.stale {
          border-color: rgba(245, 158, 11, 0.5);
          color: #fcd34d;
        }
        .pill.dead {
          border-color: rgba(239, 68, 68, 0.45);
          color: #fecaca;
        }
        .rooms {
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
        }
        .room-card {
          background: var(--cg-surface);
          border-radius: var(--cg-radius);
          padding: 0.85rem 1rem;
          border: 1px solid rgba(255, 255, 255, 0.06);
          box-shadow: var(--cg-shadow);
        }
        .room-card.roll-live {
          border-left: 4px solid var(--cg-success);
        }
        .room-card.roll-mixed {
          border-left: 4px solid var(--cg-warning);
        }
        .room-card.roll-stale {
          border-left: 4px solid var(--cg-warning);
        }
        .room-card.roll-dead {
          border-left: 4px solid var(--cg-danger);
        }
        .room-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 0.5rem;
        }
        .room-name {
          font-weight: 600;
          font-size: 1rem;
        }
        .room-floor {
          font-size: 0.75rem;
          color: var(--cg-muted);
        }
        .room-badge {
          font-size: 0.72rem;
          font-weight: 600;
          padding: 0.25rem 0.55rem;
          border-radius: 999px;
          white-space: nowrap;
        }
        .room-badge.roll-live {
          background: rgba(34, 197, 94, 0.15);
          color: #86efac;
        }
        .room-badge.roll-mixed,
        .room-badge.roll-stale {
          background: rgba(245, 158, 11, 0.15);
          color: #fcd34d;
        }
        .room-badge.roll-dead {
          background: rgba(239, 68, 68, 0.15);
          color: #fecaca;
        }
        .room-meta {
          font-size: 0.72rem;
          color: var(--cg-muted);
          margin: 0.35rem 0 0.5rem;
        }
        .ble-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
        }
        .ble-row {
          display: grid;
          grid-template-columns: 1fr auto;
          grid-template-rows: auto auto;
          gap: 0.1rem 0.5rem;
          padding: 0.45rem 0.55rem;
          border-radius: 12px;
          background: var(--cg-surface-2);
          font-size: 0.78rem;
        }
        .ble-row.st-live {
          outline: 1px solid rgba(34, 197, 94, 0.35);
        }
        .ble-row.st-stale {
          outline: 1px solid rgba(245, 158, 11, 0.35);
        }
        .ble-row.st-dead {
          outline: 1px solid rgba(239, 68, 68, 0.3);
        }
        .ble-name {
          font-weight: 600;
          grid-column: 1;
          grid-row: 1;
        }
        .ble-val {
          grid-column: 2;
          grid-row: 1;
          text-align: right;
          color: var(--cg-secondary);
          font-variant-numeric: tabular-nums;
        }
        .ble-ts {
          grid-column: 1 / -1;
          grid-row: 2;
          font-size: 0.68rem;
          color: var(--cg-muted);
        }
        .empty {
          color: var(--cg-muted);
          font-size: 0.85rem;
          text-align: center;
          padding: 1rem;
        }
        .chart-section {
          margin-top: 1rem;
          background: var(--cg-surface);
          border-radius: var(--cg-radius);
          padding: 0.85rem 1rem 1rem;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .chart-head {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .chart-head h2 {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 600;
        }
        .chart-room-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .chart-select {
          padding: 0.45rem 0.55rem;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: var(--cg-surface-2);
          color: var(--cg-text);
          max-width: 100%;
        }
        .chart-controls {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          margin-bottom: 0.35rem;
        }
        .chart-date-row {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-end;
          gap: 0.35rem;
        }
        .btn-icon {
          background: var(--cg-surface-2);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: var(--cg-text);
          width: 2rem;
          height: 2rem;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1.1rem;
          line-height: 1;
          padding: 0;
        }
        .btn-icon:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .date-wrap {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          font-size: 0.68rem;
          color: var(--cg-muted);
        }
        .date-wrap input[type='date'] {
          padding: 0.4rem 0.5rem;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: var(--cg-surface-2);
          color: var(--cg-text);
        }
        .date-wrap input:disabled {
          opacity: 0.45;
        }
        .chart-mode-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.35rem;
        }
        .mode-label {
          font-size: 0.72rem;
          color: var(--cg-muted);
          margin-right: 0.15rem;
        }
        .btn-mode {
          background: rgba(117, 81, 255, 0.15);
          border: 1px solid rgba(117, 81, 255, 0.35);
          color: #e9e7ff;
          padding: 0.35rem 0.65rem;
          border-radius: 8px;
          font-size: 0.75rem;
          cursor: pointer;
        }
        .btn-mode.active {
          background: rgba(117, 81, 255, 0.45);
          border-color: rgba(117, 81, 255, 0.7);
        }
        .btn-mode.outline {
          background: transparent;
        }
        .btn-mode:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .chart-hint {
          font-size: 0.68rem;
          color: var(--cg-muted);
          margin: 0 0 0.5rem;
          line-height: 1.35;
        }
        .chart-box {
          height: 280px;
          position: relative;
        }
        .chart-loading {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--cg-muted);
          font-size: 0.85rem;
        }
      `}</style>
    </div>
  );
}
