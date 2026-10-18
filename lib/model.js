// 移植自 https://sunset-plan.vercel.app 的朝霞/晚霞定量评分模型。
// 算法主体在 model.raw.js（由 lib/extract.mjs 从前端 bundle 原样切出），
// 本文件负责：把压缩变量映射到可读名字、把浏览器 fetch 换成 Node fetch、
// 并复刻站点 fetchDetail() 与评分入参组装逻辑。
import { CLOUD_RAW } from './model.raw.js';
import { scanSatellite } from './satellite.js';

const {
  jf: sunPosition,
  ts: localToUtc,
  H6: sunsetLinearVelocity,
  pm: PRESSURE_LEVELS,
  Q6: profileCloudBase,
  Z6: coverCloudBase,
  W6: dewpointCloudBase,
  cL_CLOUD: classifyCloud,
  tX: scanBoundaryKm,
  Y2: computeRating,
  NX: computeShotSchedule,
  En: clamp,
  K2: penetrationRadiusKm,
} = CLOUD_RAW;

export {
  sunPosition,
  localToUtc,
  sunsetLinearVelocity,
  profileCloudBase,
  coverCloudBase,
  dewpointCloudBase,
  classifyCloud,
  computeRating,
  computeShotSchedule,
  penetrationRadiusKm,
  PRESSURE_LEVELS,
};

const API = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  air: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
};
// 与原站 nX() 一致：主预报用 ECMWF，能见度回退 GFS，模型对比用 ICON
const MODEL_PRIMARY = 'ecmwf_ifs025';
const MODEL_GFS = 'gfs_seamless';
const MODEL_ICON = 'icon_seamless';
// 沿太阳方向扫描云的半径（km）
export const SCAN_RADII_KM = [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500, 600];

async function getJson(url, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'sunset-plan-push/1.0 (+github-actions)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 时间序列里找与目标时刻最近的索引（与原站 _h 等价） */
function nearestIndex(times, target) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]).getTime() - new Date(target).getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}
export { nearestIndex };

/** 大圆航向：从 (lat,lon) 朝方位角 azDeg 推进 distKm */
function destination(lat, lon, azDeg, distKm) {
  const rad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const φ1 = rad(lat);
  const λ1 = rad(lon);
  const δ = distKm / R;
  const θ = rad(azDeg);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
}
export { destination };

/** 沿各扫描点找第一段成片云的距离（与原站 tX 等价；命名避开外层同名符号） */
function firstCloudBoundaryKm(values) {
  return scanBoundaryKm(values);
}
export { firstCloudBoundaryKm };

/**
 * 复刻站点 rX/nX：一次抓取某个地点、某天、某种霞（sunset/sunrise）所需的全部数据。
 * @returns 与站点内部 `detail` 对象同构的数据
 */
export async function fetchDetail({ latitude, longitude, dateISO, mode }) {
  if (mode !== 'sunset' && mode !== 'sunrise') throw new Error('mode 必须是 sunset 或 sunrise');
  const base = `latitude=${latitude}&longitude=${longitude}&start_date=${dateISO}&end_date=${dateISO}&timezone=auto`;
  const levels = PRESSURE_LEVELS.map((p) => `relative_humidity_${p}hPa,geopotential_height_${p}hPa`).join(',');

  const urlPrimary = `${API.forecast}?${base}&models=${MODEL_PRIMARY}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,dew_point_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,precipitation_probability,weather_code,geopotential_height_850hPa,geopotential_height_700hPa,geopotential_height_500hPa,geopotential_height_250hPa,wind_speed_850hPa,wind_direction_850hPa,wind_speed_700hPa,wind_direction_700hPa,wind_speed_500hPa,wind_direction_500hPa&daily=sunrise,sunset`;
  const urlGfs = `${API.forecast}?${base}&models=${MODEL_GFS}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,dew_point_2m,relative_humidity_2m,visibility,boundary_layer_height,precipitation,precipitation_probability,weather_code,${levels}&daily=sunrise,sunset`;
  const urlIcon = `${API.forecast}?${base}&models=${MODEL_ICON}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high`;
  const urlAir = `${API.air}?${base}&hourly=aerosol_optical_depth`;

  const [p, m, v, w] = await Promise.all([urlPrimary, urlGfs, urlIcon, urlAir].map((u) => getJson(u).catch(() => null)));
  const A = p ?? m ?? v;
  if (!A) throw new Error('天气数据获取失败（Open-Meteo 主预报、GFS、ICON 均不可用）');
  const j = m ?? p ?? v; // 位势高度/湿度廓线优先取 GFS
  const R = m ?? p; // 能见度、边界层高度优先取 GFS

  const sunrise = A.daily.sunrise[0];
  const sunset = A.daily.sunset[0];
  const eventTime = mode === 'sunset' ? sunset : sunrise;
  const idx = nearestIndex(A.hourly.time, eventTime);

  // ---- 气溶胶光学厚度：缺失时用能见度反演 ----
  const aodSeries = w?.hourly?.aerosol_optical_depth;
  let aod = aodSeries ? aodSeries[idx] : NaN;
  const blSeries = R?.hourly?.boundary_layer_height;
  let bl = blSeries ? blSeries[idx] : NaN;
  if (bl == null || isNaN(bl)) bl = 1500;
  const blKmRaw = Math.max(0.3, Math.min(4, bl / 1000));
  if (aod == null || isNaN(aod)) {
    const vis = R?.hourly?.visibility;
    const visKm = vis ? (vis[idx] ?? NaN) / 1000 : NaN;
    aod = !isNaN(visKm) && visKm > 0 ? Math.min(1.2, Math.max(0.01, (3.912 / Math.max(visKm, 0.5)) * blKmRaw)) : 0.3;
  }

  const elevation = typeof j.elevation === 'number' ? j.elevation : 0;

  // ---- 湿度廓线 → 云底高度 ----
  const profile = [];
  for (const pr of PRESSURE_LEVELS) {
    const rh = j.hourly[`relative_humidity_${pr}hPa`];
    const gh = j.hourly[`geopotential_height_${pr}hPa`];
    if (!rh || !gh) continue;
    const r = rh[idx];
    const g = gh[idx];
    if (r == null || g == null || isNaN(r) || isNaN(g)) continue;
    profile.push({ pressure: pr, rh: r, heightAglM: Math.max(0, g - elevation) });
  }
  profile.sort((a, b) => a.heightAglM - b.heightAglM);

  const heightOf = (pr) => {
    const src = j.hourly[`geopotential_height_${pr}hPa`] ?? A.hourly[`geopotential_height_${pr}hPa`];
    const val = src ? src[idx] : undefined;
    return val != null && !isNaN(val) ? val : undefined;
  };
  const cloudHeightsKm = [
    Math.max(0.5, ((heightOf(850) ?? 2000) - elevation) / 1000),
    Math.max(3, ((heightOf(500) ?? 6000) - elevation) / 1000),
    Math.max(7, ((heightOf(250) ?? 10800) - elevation) / 1000),
  ];

  // ---- 沿太阳方位扫描：云边界距离 D、云隙、路径降雨 ----
  let boundaryDistanceKm = null;
  let boundaryFromScanData = false;
  let boundaryFromSatellite = false;
  let rainPath = [];
  let cloudScan = null;
  try {
    const sun = sunPosition(localToUtc(eventTime, A.utc_offset_seconds), latitude, longitude);
    const pts = SCAN_RADII_KM.map((km) => destination(latitude, longitude, sun.azimuth, km));
    const lats = pts.map((pt) => pt.lat.toFixed(3)).join(',');
    const lons = pts.map((pt) => pt.lon.toFixed(3)).join(',');
    const scanUrl = `${API.forecast}?latitude=${lats}&longitude=${lons}&start_date=${dateISO}&end_date=${dateISO}&timezone=auto&models=${MODEL_PRIMARY}&hourly=cloud_cover,cloud_cover_mid,cloud_cover_high,precipitation,weather_code`;
    const raw = await getJson(scanUrl);
    const list = Array.isArray(raw) ? raw : [raw];
    const pick = (t, field, i) => {
      const val = t.hourly?.[field]?.[i];
      return val == null || isNaN(val) ? 0 : val;
    };
    boundaryDistanceKm = firstCloudBoundaryKm(list.map((t) => pick(t, 'cloud_cover', nearestIndex(t.hourly.time, eventTime))));
    boundaryFromScanData = true;
    rainPath = list.map((t, i) => {
      const k = nearestIndex(t.hourly.time, eventTime);
      return { distanceKm: SCAN_RADII_KM[i] ?? 0, precipMm: pick(t, 'precipitation', k), weatherCode: pick(t, 'weather_code', k) };
    });
    cloudScan = list.map((t, i) => {
      const k = nearestIndex(t.hourly.time, eventTime);
      return {
        distanceKm: SCAN_RADII_KM[i] ?? 0,
        cloudCover: pick(t, 'cloud_cover', k),
        cloudMid: pick(t, 'cloud_cover_mid', k),
        cloudHigh: pick(t, 'cloud_cover_high', k),
      };
    });
  } catch (err) {
    console.warn('[sunset] 沿太阳方向扫描失败，回退云量估算边界:', err.message);
    boundaryFromScanData = false;
  }

  const pickCur = (obj, field) => {
    const arr = obj?.hourly?.[field];
    const val = arr ? arr[idx] : undefined;
    return val == null || isNaN(val) ? 0 : val;
  };
  const precipitationMm = pickCur(A, 'precipitation');
  const precipitationProbability = pickCur(A, 'precipitation_probability');
  const weatherCode = pickCur(A, 'weather_code');

  const modelPick = (obj, field) => {
    const arr = obj?.hourly?.[field];
    const val = arr ? arr[idx] : undefined;
    return val == null || isNaN(val) ? null : val;
  };
  const modelSnapshot = (obj, key) => {
    const low = modelPick(obj, 'cloud_cover_low');
    const mid = modelPick(obj, 'cloud_cover_mid');
    const high = modelPick(obj, 'cloud_cover_high');
    const total = modelPick(obj, 'cloud_cover');
    return {
      key,
      label: { ec: 'ECMWF IFS', gfs: 'GFS', icon: 'ICON' }[key],
      low: low ?? 0,
      mid: mid ?? 0,
      high: high ?? 0,
      total: total ?? (low != null || mid != null || high != null ? Math.max(low ?? 0, mid ?? 0, high ?? 0) : 0),
      available: low != null || mid != null || high != null,
    };
  };
  const modelClouds = [
    modelSnapshot(p, 'ec'),
    modelSnapshot(m, 'gfs'),
    modelSnapshot(v, 'icon'),
  ].filter((c) => c.available);

  // ---- 实况云图（NSMC）扫描：与站点一致 ----
  // 注意：boundaryDistanceKm 必须保持“数值预报”的原始 D，
  // 实况更近时通过 satelliteCloserBoundaryKm / satelliteRefutedNearKm 单独传入，
  // 由 Y2 内部决定生效。若提前把 boundaryDistanceKm 覆盖成实况值，评分会偏高（与站点不一致）。
  let satellite = null;
  try {
    const scan = await scanSatellite({
      layer: 'infrared',
      model: { low: A.hourly.cloud_cover_low[idx], mid: A.hourly.cloud_cover_mid[idx], high: A.hourly.cloud_cover_high[idx] },
    });
    if (scan) {
      const sunAz = sunPosition(localToUtc(eventTime, A.utc_offset_seconds), latitude, longitude).azimuth;
      const dirs = scan.dirs16(latitude, longitude).filter((d) => Math.abs(((d.az - sunAz + 540) % 360) - 180) <= 90);
      const brightest = dirs.reduce((a, b) => (b.pct > a.pct ? b : a), dirs[0] ?? { pct: 0, gapKm: null });
      const sunward = scan.toward(latitude, longitude, sunAz);
      // 与站点一致：三层云量之和 < 8 视为“模式报晴空”
      const skyClear =
        A.hourly.cloud_cover_low[idx] + A.hourly.cloud_cover_mid[idx] + A.hourly.cloud_cover_high[idx] < 8;
      const modelBoundaryKm = boundaryFromScanData ? boundaryDistanceKm ?? 600 : scanBoundaryKm(A.hourly.cloud_cover[idx]);
      const fix = satelliteCorrection({
        modelBoundaryKm,
        skyClear,
        dirPct: brightest.pct,
        dirGapKm: brightest.gapKm,
        sunPct: sunward.pct,
        sunGapKm: sunward.gapKm,
      });
      // 晴空分支：站点实际传入的是「正对太阳方向」的 toward 扫描结果
      if (skyClear && sunward.pct >= 10 && sunward.gapKm != null) {
        fix.cloudPct = sunward.pct;
        fix.boundaryKm = sunward.gapKm;
      }
      satellite = {
        stamp: scan.stamp,
        timeUtc: scan.timeUtc.toISOString(),
        modelBoundaryKm,
        dirPct: brightest.pct,
        dirGapKm: brightest.gapKm,
        sunwardPct: sunward.pct,
        sunwardGapKm: sunward.gapKm,
        ...fix,
      };
      // 仅供参考：Y2 内部实际生效的 D
      boundaryFromSatellite = fix.closerBoundaryKm != null || fix.refutedNearKm != null;
    }
  } catch (err) {
    console.warn('[sunset] 实况云图扫描失败，按纯数值预报计算:', err.message);
  }

  return {
    latitude,
    longitude,
    satellite,
    timezone: A.timezone,
    utcOffsetSeconds: A.utc_offset_seconds,
    elevationM: elevation,
    sunrise,
    sunset,
    eventTime,
    tempC: A.hourly.temperature_2m?.[idx],
    dewC: A.hourly.dew_point_2m?.[idx],
    humidity: A.hourly.relative_humidity_2m?.[idx],
    visibilityM: R?.hourly?.visibility?.[idx] ?? 15000,
    cloudCoverLow: A.hourly.cloud_cover_low[idx],
    cloudCoverMid: A.hourly.cloud_cover_mid[idx],
    cloudCoverHigh: A.hourly.cloud_cover_high[idx],
    cloudCoverTotal: A.hourly.cloud_cover[idx],
    aod,
    boundaryLayerHeightKm: blKmRaw,
    humidityProfile: profile,
    boundaryDistanceKm,
    boundaryFromScan: boundaryFromScanData,
    boundaryFromSatellite,
    precipitationMm,
    precipitationProbability,
    weatherCode,
    rainPath,
    cloudScan,
    cloudHeightsKm,
    modelClouds,
    cloudSource: p ? 'ECMWF IFS 0.25°' : m ? 'GFS' : 'ICON',
    modelCloudSum: A.hourly.cloud_cover_low[idx] + A.hourly.cloud_cover_mid[idx] + A.hourly.cloud_cover_high[idx],
  };
}

/**
 * 复刻站点的评分入参组装（页面里的 me）与 Y2。
 *
 * 关键：站点把「云底高度」分两路算：
 *  - 常规（已有云量覆盖）→ 取 ECMWF 850/500/250hPa 位势高度反演值
 *  - 模式报晴空（低/中/高云量之和 < 8）→ 用湿度廓线 / 分层云带 / 露点估算得到的默认高度
 * 这两路会显著影响「时长」「色彩」维度，必须照做。
 */
export function evaluate(detail, mode) {
  const q = detail;
  const cloudBaseFromProfile = profileCloudBase(q.humidityProfile, q.humidity);
  const cloudBaseFromCover = coverCloudBase(q.cloudCoverLow, q.cloudCoverMid, q.cloudCoverHigh);
  const midOrHighCovered = q.cloudCoverMid >= 12 || q.cloudCoverHigh >= 12; // Aa = 12
  let cloudBaseInfo;
  if (midOrHighCovered && cloudBaseFromCover.method !== 'none') cloudBaseInfo = { ...cloudBaseFromCover, maxRh: cloudBaseFromProfile.maxRh };
  else if (cloudBaseFromProfile.method !== 'none') cloudBaseInfo = cloudBaseFromProfile;
  else if (cloudBaseFromCover.method !== 'none') cloudBaseInfo = { ...cloudBaseFromCover, maxRh: cloudBaseFromProfile.maxRh };
  else cloudBaseInfo = { ...cloudBaseFromProfile, baseKm: dewpointCloudBase(q.tempC, q.dewC) };

  // 模式云量之和 < 8 → 按“晴空”处理（站点 r 参数）
  const skyClear = (q.modelCloudSum ?? q.cloudCoverLow + q.cloudCoverMid + q.cloudCoverHigh) < 8;

  let ecmwfBaseKm = null;
  if (q.cloudHeightsKm) {
    if (q.cloudCoverHigh >= 12) ecmwfBaseKm = q.cloudHeightsKm[2];
    else if (q.cloudCoverMid >= 12) ecmwfBaseKm = q.cloudHeightsKm[1];
    else if (q.cloudCoverLow >= 12) ecmwfBaseKm = q.cloudHeightsKm[0];
  }
  const fallbackBaseKm = cloudBaseInfo.baseKm;
  // 晴空时即使某个模式层非零，也不用位势反演值，改用默认估算高度
  const usedBaseKm = skyClear ? fallbackBaseKm : (ecmwfBaseKm ?? fallbackBaseKm);
  const boundaryKm = q.boundaryFromScan ? (q.boundaryDistanceKm ?? 600) : scanBoundaryKm(q.cloudCoverTotal);
  const cloudBaseKm = Number(Math.max(0.1, usedBaseKm).toFixed(1));
  const aod = Number(Number(q.aod).toFixed(2));

  const eventUtc = localToUtc(q.eventTime, q.utcOffsetSeconds);
  const sunAzimuthDeg = sunPosition(eventUtc, q.latitude, q.longitude).azimuth;
  const sunsetVelocity = sunsetLinearVelocity(q.latitude, new Date(`${q.eventTime.slice(0, 10)}T12:00:00`).getMonth());
  const blKm = Math.max(0.3, Math.min(4, q.boundaryLayerHeightKm));

  // ---- 实况云图（NSMC）：参数由 fetchDetail 计算好，这里只透传 ----
  const sat = q.satellite;

  const args = {
    mode,
    cloudBaseHeightKm: cloudBaseKm,
    cloudBoundaryDistanceKm: boundaryKm,
    aod,
    boundaryLayerHeightKm: blKm,
    sunsetLinearVelocityKmPerMin: sunsetVelocity,
    sunAzimuthDeg,
    cloudCoverLowPct: q.cloudCoverLow,
    cloudCoverMidPct: q.cloudCoverMid,
    cloudCoverHighPct: q.cloudCoverHigh,
    cloudHeightsKm: q.cloudHeightsKm,
    visibilityM: q.visibilityM,
    eventTimeUtc: eventUtc,
    latitude: q.latitude,
    longitude: q.longitude,
    satelliteCloudPct: sat ? sat.cloudPct : undefined,
    satelliteBoundaryKm: sat ? sat.boundaryKm : undefined,
    // 晴空分支：站点用「正对太阳方向」的 toward 扫描结果
    // （不是 dirs16 里最凸的那个方位），且不再叠加 closer 覆盖，否则时长/色彩会偏高。
    satelliteCloserBoundaryKm: skyClear ? undefined : sat ? sat.closerBoundaryKm : undefined,
    satelliteRefutedNearKm: sat ? sat.refutedNearKm : undefined,
    precipitationMm: q.precipitationMm,
    precipitationProbability: q.precipitationProbability,
    weatherCode: q.weatherCode,
    rainPath: q.rainPath,
  };

  const rating = computeRating(args);
  const shootSchedule = computeShotSchedule(args, cloudBaseKm, 0); // schedule 的 n 参数=overcast，Y2 内部才精确计算

  return {
    args,
    rating,
    shootSchedule,
    sunAzimuthDeg,
    sunsetVelocity,
    cloudBaseInfo,
    skyClear,
    boundaryKm,
    cloudBaseKm,
    aod,
    // 站点展示顺序：常规用评分 H；走了卫星分支时显示 max(H, 4.5)
    displayedCloudBaseKm: sat && sat.boundaryKm != null ? Number(Math.max(cloudBaseKm, 4.5).toFixed(1)) : cloudBaseKm,
    overcast: rating.overcast,
  };
}

/**
 * 复刻站点页面里对实况云图的三条修正（qe / be / C）：
 * - 模式报晴空，但实况在太阳方向拍到云 → 改判为有云（satelliteCloudPct + satelliteBoundaryKm）
 * - 实况比数值预报更近 → satelliteCloserBoundaryKm
 * - 数值预报近距云幕被实况证伪 → satelliteRefutedNearKm
 * @param {object} p
 * @param {number} p.modelBoundaryKm 数值预报给出的 D
 * @param {boolean} p.skyClear 模式是否报晴空
 * @param {{dirPct:number, gapKm:number|null}} p.toward 沿太阳方向（±90° 扇区内最凸）的实况
 * @param {{pct:number, gapKm:number|null}} p.sunward 正太阳方向的实况
 */
export function satelliteCorrection({ modelBoundaryKm, skyClear, dirPct, dirGapKm, sunPct, sunGapKm }) {
  const IO = 10;
  const MC = 400;
  const nearGap = dirGapKm != null && dirGapKm < MC ? dirGapKm : null;
  const closerOrRefuted =
    nearGap != null &&
    ((skyClear && dirPct >= IO) || (nearGap <= 30 && modelBoundaryKm >= 60) || (modelBoundaryKm - nearGap >= 50 && sunPct >= 15))
      ? nearGap
      : null;
  const refuted = !nearGap && sunPct < 10 && modelBoundaryKm < 100 ? MC : null;

  const result = {
    cloudPct: skyClear && dirPct >= IO ? dirPct : undefined,
    boundaryKm: skyClear && dirPct >= IO && closerOrRefuted != null ? closerOrRefuted : undefined,
    closerBoundaryKm: closerOrRefuted ?? undefined,
    refutedNearKm: refuted ?? undefined,
  };
  return result;
}
