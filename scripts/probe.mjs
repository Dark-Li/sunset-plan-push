import { fetchDetail, evaluate, classifyCloud } from '../lib/model.js';

const place = { latitude: 31.23, longitude: 121.47 };
const dateISO = process.argv[3] || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const mode = process.argv[2] || 'sunset';

const detail = await fetchDetail({ ...place, dateISO, mode });
const ev = evaluate(detail, mode);
console.log({
  tz: detail.timezone,
  sunrise: detail.sunrise,
  sunset: detail.sunset,
  clouds: { low: detail.cloudCoverLow, mid: detail.cloudCoverMid, high: detail.cloudCoverHigh },
  aod: detail.aod,
  boundaryKm: detail.boundaryDistanceKm,
  cloudBaseKm: ev.cloudBaseKm,
  score: ev.rating.rating.score,
  label: ev.rating.rating.label,
  color: ev.rating.color,
  durationMin: Number(ev.rating.totalDurationMin.toFixed(1)),
  cloudType: classifyCloud(ev.cloudBaseKm, null, detail.cloudCoverLow, detail.cloudCoverMid, detail.cloudCoverHigh)?.name,
});
