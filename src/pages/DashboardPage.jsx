import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { getTemperature, getHumidity, getTimestamp, latestFromReadings } from '../sensorHelpers.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const LIVE_MS = 5 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const CHART_HOURS = 24;
const BLE_FETCH_CONCURRENCY = 6;

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

export default function DashboardPage({ onLogout }) {
  const user = getUser();
  const isSuperadmin = user?.role === 'superadmin';
  const defaultCompanyId = companyIdFromUser(user);

  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [warehouseDoc, setWarehouseDoc] = useState(null);
  const [bles, setBles] = useState([]);
  const [bleSnapshots, setBleSnapshots] = useState({});
  const [chartBleId, setChartBleId] = useState('');
  const [chartPoints, setChartPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState(null);

  const roomIndex = useMemo(() => buildRoomIndex(warehouseDoc), [warehouseDoc]);

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

      setChartBleId((prev) => {
        if (prev && map[prev]) return prev;
        const first = list[0]?._id;
        return first ? String(first) : '';
      });
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
    if (!chartBleId) {
      setChartPoints([]);
      return;
    }
    setChartLoading(true);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - CHART_HOURS * 60 * 60 * 1000);
      const res = await axios.get(`/api/devices/${chartBleId}/sensor-data`, {
        params: {
          start: start.toISOString(),
          end: end.toISOString(),
          limit: 500,
        },
        headers: authHeaders(),
      });
      const readings = Array.isArray(res.data) ? res.data : [];
      const sorted = readings
        .filter(Boolean)
        .slice()
        .sort((a, b) => {
          const ma = getTimestamp(a) ? new Date(getTimestamp(a)).getTime() : 0;
          const mb = getTimestamp(b) ? new Date(getTimestamp(b)).getTime() : 0;
          return ma - mb;
        });
      const maxPts = 200;
      const step = Math.max(1, Math.ceil(sorted.length / maxPts));
      const sampled = sorted.filter((_, i) => i % step === 0 || i === sorted.length - 1);
      setChartPoints(
        sampled.map((r) => ({
          t: getTimestamp(r),
          temp: getTemperature(r),
        }))
      );
    } catch {
      setChartPoints([]);
    } finally {
      setChartLoading(false);
    }
  }, [chartBleId]);

  useEffect(() => {
    loadChart();
  }, [loadChart]);

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
      const meta = roomKey === '_unassigned' ? { name: 'Unassigned', floor: '', type: '' } : roomIndex.get(roomKey) || { name: 'Room', floor: '', type: '' };
      const statuses = devices.map((d) => bleSnapshots[String(d._id)]?.status || 'dead');
      const rollup = roomRollup(statuses);
      out.push({ roomKey, meta, devices, rollup, live: statuses.filter((s) => s === 'live').length, total: devices.length });
    }
    out.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
    return out;
  }, [roomsGrouped, roomIndex, bleSnapshots]);

  const chartData = {
    labels: chartPoints.map((p) => (p.t ? new Date(p.t) : new Date())).map((d) =>
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    ),
    datasets: [
      {
        label: '°C',
        data: chartPoints.map((p) => (typeof p.temp === 'number' && !Number.isNaN(p.temp) ? p.temp : null)),
        borderColor: '#39B8FF',
        backgroundColor: 'rgba(57, 184, 255, 0.15)',
        tension: 0.25,
        fill: true,
        spanGaps: true,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: false },
    },
    scales: {
      x: {
        ticks: { maxTicksLimit: 8, color: '#9ca3af' },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
      y: {
        ticks: { color: '#9ca3af' },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
    },
  };

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
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={!warehouses.length}>
            <option value="">{warehouses.length ? 'Select warehouse' : 'No warehouses'}</option>
            {warehouses.map((w) => (
              <option key={w._id} value={w._id}>
                {w.warehouseName || w._id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => loadBleHealth()} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </button>
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
          <h2>Temperature ({CHART_HOURS}h)</h2>
          <select value={chartBleId} onChange={(e) => setChartBleId(e.target.value)} className="chart-select">
            <option value="">Select sensor</option>
            {bles.map((d) => (
              <option key={d._id} value={String(d._id)}>
                {d.name || d.macAddress || d._id}
              </option>
            ))}
          </select>
        </div>
        <div className="chart-box">
          {chartLoading ? (
            <div className="chart-loading">Loading chart…</div>
          ) : chartBleId && chartPoints.length ? (
            <Line data={chartData} options={chartOptions} />
          ) : (
            <div className="chart-loading">{chartBleId ? 'No readings in this window.' : 'Select a sensor.'}</div>
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
        .btn-secondary {
          background: rgba(117, 81, 255, 0.2);
          border: 1px solid rgba(117, 81, 255, 0.45);
          color: #e9e7ff;
          padding: 0.55rem 0.9rem;
          border-radius: 12px;
          cursor: pointer;
          align-self: flex-end;
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
        .chart-select {
          padding: 0.45rem 0.55rem;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: var(--cg-surface-2);
          color: var(--cg-text);
          max-width: 100%;
        }
        .chart-box {
          height: 220px;
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
