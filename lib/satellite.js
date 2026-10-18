// 国家卫星气象中心（NSMC）实况云图：与站点同源的 G6() 扫描逻辑。
// 站点用它在“模式报晴空但实况有云”时改判，并用更近的云边界修正 D。
import { createCanvas, loadImage } from '@napi-rs/canvas';

const NSMC_BASE = 'https://data.nsmc.org.cn';
const WMS_PATH = '/NSMCAPI/v1/nsmc/image/wms/compose';
const BBOX = '90,0,135,45'; // 站点固定取东亚范围
const SIZE = 512;
const MIN_BYTES = 20_000; // 小于此视为无效图
const GEO = { lonMin: 90, lonMax: 135, latMin: 0, latMax: 45 };
const AZ_HALF_WIDTH = 8; // ±8° 扇区内的像元平均
const SMALL_STRIP_KM = 10;
const SMALL_STRIP_PCT = 30;
const BIG_STRIP_KM = 25;
const BIG_STRIP_PCT = 35;
const BIG_STRIP_SAMPLE_KM = 60;
const BIG_STRIP_STEP_KM = 5;
const HIGH_DENSITY_PCT = 50;
const SCAN_RADII_KM = [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500, 600];

const LAYERS = {
  trueColor: { code: 'FY3H_MERSI', granularity: 'daily', maxBackstep: 5 },
  infrared: { code: 'GEOS_IRX', granularity: 'hourly', maxBackstep: 8 },
};

const pad2 = (n) => String(n).padStart(2, '0');

function stampFor(date, granularity) {
  const ymd = `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
  return granularity === 'daily' ? `${ymd}0000` : `${ymd}${pad2(date.getUTCHours())}00`;
}

function wmsUrl(layer, datetime) {
  const q = new URLSearchParams({
    layers: LAYERS[layer].code,
    datetime,
    request: 'GetMap',
    bbox: BBOX,
    width: String(SIZE),
    height: String(SIZE),
    version: '1.1.0',
    format: 'png',
  });
  return `${NSMC_BASE}${WMS_PATH}?${q.toString()}`;
}

async function fetchImage(layer, datetime) {
  try {
    const res = await fetch(wmsUrl(layer, datetime), {
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < MIN_BYTES) return null;
    const img = await loadImage(buf);
    return img;
  } catch {
    return null;
  }
}

/** 时间戳规则：从当前整点往前回溯，直到找到可用的云图 */
async function latestFrame(layer) {
  const cfg = LAYERS[layer];
  const stepMs = cfg.granularity === 'daily' ? 24 * 3600e3 : 3600e3;
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  if (cfg.granularity === 'daily') now.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i <= cfg.maxBackstep; i++) {
    const t = new Date(now.getTime() - i * stepMs);
    const stamp = stampFor(t, cfg.granularity);
    const img = await fetchImage(layer, stamp);
    if (img) return { img, timeUtc: t, stamp, layer };
  }
  return null;
}

/** 阈值：中高云较多时用 150，低云厚且无中高云时用 200，其余 170（并启用“均匀即剔除”） */
function pixelRule(model) {
  if (!model) return { minBright: 170, rejectUniform: false };
  const midHigh = model.mid + model.high;
  const low = model.low;
  if (midHigh >= 25) return { minBright: 150, rejectUniform: false };
  if (low >= 60 && midHigh < 15) return { minBright: 200, rejectUniform: false };
  return { minBright: 170, rejectUniform: true };
}

function lonLatToPixel(lat, lon, w, h) {
  const x = ((lon - GEO.lonMin) / (GEO.lonMax - GEO.lonMin)) * w;
  const y = ((GEO.latMax - lat) / (GEO.latMax - GEO.latMin)) * h;
  return [x, y];
}

/**
 * 扫描实况云图，返回与站点 G6() 同构的对象：
 *   { stamp, timeUtc, cloudAround(), toward(lat,lon,az), dirs16(lat,lon) }
 */
export async function scanSatellite({ layer = 'infrared', model } = {}) {
  const { minBright, rejectUniform } = pixelRule(model);
  const frame = await latestFrame(layer);
  if (!frame) return null;

  const { img } = frame;
  const w = img.width;
  const h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  const brightness = (x, y) => {
    const k = (y * w + x) * 4;
    return 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  };
  const isCloud = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    return brightness(x, y) >= minBright;
  };

  const kmPerPixel = ((GEO.latMax - GEO.latMin) / h) * 111;
  const kmPerDegLon = (lat) => 111 * Math.cos((lat * Math.PI) / 180);
  const stepKm = Math.max(6, kmPerPixel);
  const sectors = [-AZ_HALF_WIDTH, 0, AZ_HALF_WIDTH].map((d) => (d * Math.PI) / 180);

  /** 沿某方位采样：返回云量百分比与“首个成片云”的距离（单条射线） */
  const scanRay = (lat, lon, azDeg, maxKm) => {
    const az = (azDeg * Math.PI) / 180;
    const scale = kmPerDegLon(lat);
    let cloudHits = 0;
    let samples = 0;
    let firstGap = maxKm;
    for (let d = 0; d <= maxKm; d += stepKm) {
      let hitRay = false;
      for (const off of sectors) {
        const b = az + off;
        const dLat = (Math.cos(b) * d) / 111;
        const dLon = (Math.sin(b) * d) / scale;
        const [px, py] = lonLatToPixel(lat + dLat, lon + dLon, w, h);
        const ix = Math.round(px);
        const iy = Math.round(py);
        if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
        samples++;
        if (isCloud(ix, iy)) {
          cloudHits++;
          hitRay = true;
          if (firstGap === maxKm) firstGap = d;
        }
      }
      void hitRay;
    }
    const pct = samples ? (cloudHits / samples) * 100 : 0;
    return { pct, gapKm: firstGap };
  };

  /** 平滑后的“首个成片云”检测（与站点 toward() 一致） */
  const scanToward = (lat, lon, azDeg, maxKm = SCAN_RADII_KM[SCAN_RADII_KM.length - 1]) => {
    const az = (azDeg * Math.PI) / 180;
    const scale = kmPerDegLon(lat);
    const profile = [];
    let hits = 0;
    let samples = 0;
    for (let d = 0; d <= maxKm; d += stepKm) {
      let localHits = 0;
      let localSamples = 0;
      for (const off of sectors) {
        const b = az + off;
        const dLat = (Math.cos(b) * d) / 111;
        const dLon = (Math.sin(b) * d) / scale;
        const [px, py] = lonLatToPixel(lat + dLat, lon + dLon, w, h);
        const ix = Math.round(px);
        const iy = Math.round(py);
        if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
        localSamples++;
        if (isCloud(ix, iy)) localHits++;
      }
      profile.push({ d, pct: localSamples ? (localHits / localSamples) * 100 : 0 });
      hits += localHits;
      samples += localSamples;
    }
    const meanPct = samples ? (hits / samples) * 100 : 0;
    if (rejectUniform && meanPct > 85) return { pct: 0, gapKm: maxKm };
    if (profile.length === 0) return { pct: 0, gapKm: maxKm };

    // 滑动平均（窗口 ±12km）
    const half = Math.max(1, Math.round(12 / stepKm));
    const smooth = profile.map((p, i) => {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(profile.length - 1, i + half); k++) {
        sum += profile[k].pct;
        n++;
      }
      return { d: p.d, pct: n ? sum / n : 0 };
    });

    let segStart = null;
    let segEnd = null;
    for (const p of smooth) {
      if (segStart === null && p.pct >= HIGH_DENSITY_PCT) {
        segStart = p.d;
        segEnd = p.d;
      } else if (segStart !== null) {
        if (p.pct >= SMALL_STRIP_PCT) {
          if (p.d - (segEnd ?? p.d) >= BIG_STRIP_PCT) return { pct: Math.round(meanPct), gapKm: segStart };
        } else {
          segStart = null;
          segEnd = null;
        }
      }
    }
    return { pct: Math.round(meanPct), gapKm: maxKm };
  };

  /** 本地周边云量（半径 120km 内的平均） */
  const cloudAround = (lat, lon, radiusKm = 120) => {
    const [cx, cy] = lonLatToPixel(lat, lon, w, h);
    const r = Math.max(2, radiusKm / kmPerPixel);
    let hits = 0;
    let samples = 0;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dy * dy + dx * dx > r * r) continue;
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        samples++;
        if (isCloud(x, y)) hits++;
      }
    }
    return samples ? (hits / samples) * 100 : 0;
  };

  const DIRS16 = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5];

  return {
    layer,
    stamp: frame.stamp,
    timeUtc: frame.timeUtc,
    cloudAround,
    dirs16: (lat, lon) => DIRS16.map((az) => ({ az, ...scanRay(lat, lon, az, SCAN_RADII_KM[SCAN_RADII_KM.length - 1]) })),
    toward: (lat, lon, azDeg, maxKm = SCAN_RADII_KM[SCAN_RADII_KM.length - 1]) => scanToward(lat, lon, azDeg, maxKm),
  };
}
