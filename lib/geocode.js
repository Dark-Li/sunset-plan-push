// 地点解析：只写名字（如“重庆”“大理”）也能定位，基于 Open-Meteo 官方地名检索接口
// （与站点城市搜索同源）。
//
// 支持的写法：
//   "重庆"                       → 城市名
//   "云南 大理" / "云南大理"      → 用省份消歧
//   { name: "大理", admin1: "云南" } → 用字段消歧
// 设计要点：
//  - 多个词时，对每个词都检索一次并合并候选，避免“云南 大理”按省名检索不到大理
//  - 结果按“疑似度”排序：常见地名（区县以上）优先；匹配到乡镇/机场/社区这类会明确警告
//  - 找不到可信结果时直接报错并给出候选，绝不悄悄用错坐标

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_CANDIDATES = 5;

/** 中文省名 → 可能的英文写法，便于跨语言匹配 */
const ADMIN_ALIASES = {
  云南: ['yunnan'], 四川: ['sichuan'], 重庆: ['chongqing'], 上海: ['shanghai'], 北京: ['beijing'],
  广东: ['guangdong'], 广西: ['guangxi'], 浙江: ['zhejiang'], 江苏: ['jiangsu'], 安徽: ['anhui'],
  福建: ['fujian'], 江西: ['jiangxi'], 湖南: ['hunan'], 湖北: ['hubei'], 河南: ['henan'],
  河北: ['hebei'], 山东: ['shandong'], 山西: ['shanxi'], 陕西: ['shaanxi'], 甘肃: ['gansu'],
  青海: ['qinghai'], 辽宁: ['liaoning'], 吉林: ['jilin'], 黑龙江: ['heilongjiang'], 内蒙古: ['inner mongolia'],
  新疆: ['xinjiang'], 西藏: ['tibet', 'xizang'], 宁夏: ['ningxia'], 海南: ['hainan'], 贵州: ['guizhou'],
  天津: ['tianjin'], 香港: ['hong kong'], 澳门: ['macau'], 台湾: ['taiwan'],
};

function stripSuffix(s) {
  return String(s).toLowerCase().replace(/(省|市|区|县|自治区|特别行政区|地区|盟|州)+$/u, '');
}

function variantsOf(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return [];
  const out = new Set([w, stripSuffix(w)]);
  for (const [cn, ens] of Object.entries(ADMIN_ALIASES)) {
    if (w.startsWith(cn) || stripSuffix(w) === cn) ens.forEach((e) => out.add(e));
  }
  return [...out].filter(Boolean);
}

/** 候选结果里可用于比对的字段 */
function fieldsOf(entry) {
  return [entry.name, entry.admin1, entry.admin2, entry.admin3, entry.admin4, entry.country, entry.country_code]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
}

/** 所有词都能在候选的字段里找到 → 算匹配 */
function matchesAll(entry, tokens) {
  const fields = fieldsOf(entry);
  const stripped = fields.map(stripSuffix);
  return tokens.every((tok) =>
    variantsOf(tok).some((v) => fields.some((f) => f.includes(v)) || stripped.some((f) => f.includes(stripSuffix(v)))),
  );
}

/** 名称相似度：完全相同 1000，包含 600，否则按公共前缀给分 */
function nameScore(entryName, token) {
  const n = String(entryName || '').toLowerCase();
  const t = String(token || '').toLowerCase();
  if (!n || !t) return 0;
  if (n === t || stripSuffix(n) === stripSuffix(t)) return 1000;
  // 「Chongqing Wushan Airport」这类：在用户输入的词后面又加了更多字的设施名，不是想要的行政地名
  if (n.length > t.length && n.startsWith(stripSuffix(t))) {
    if (/airport|机场|station|火车站|heliport|road|路|社区|村$/i.test(n)) return -500;
  }
  if (n.includes(t) || t.includes(n)) return 550;
  let common = 0;
  while (common < n.length && common < t.length && n[common] === t[common]) common++;
  return common >= 2 ? common * 60 : 0;
}

/** 地物类型：区县以上才可信，乡镇/机场/社区要提醒 */
function featureInfo(code) {
  const ft = String(code || '');
  if (ft === 'PPLC' || ft === 'PPLA') return { score: 150, trusted: true, label: '城市' };
  if (ft === 'PPLA2') return { score: 120, trusted: true, label: '地级市' };
  if (ft === 'PPLA3' || ft === 'PPLA4') return { score: 100, trusted: true, label: '区县' };
  if (ft.startsWith('ADM')) return { score: 40, trusted: false, label: '行政区' };
  if (ft === 'AIRP' || ft === 'AFLD' || ft === 'AIRH') return { score: -300, trusted: false, facility: true, label: '机场' };
  if (ft.startsWith('PPL')) return { score: 40, trusted: false, label: '村镇/社区' };
  return { score: 0, trusted: false, label: ft || '未知' };
}

async function searchRaw(name, language = 'zh') {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=20&language=${language}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`地名检索失败（HTTP ${res.status}）`);
  const json = await res.json();
  return Array.isArray(json.results) ? json.results : [];
}

/**
 * 第二检索源：OSM / Photon（站点城市搜索也在用）。
 * Open-Meteo 的中文地名库有缺漏（例如“大理”只返回四川泸州的一个村镇、“林芝”查不到），
 * 这里用 Photon 补足，并把结果转换成与 Open-Meteo 相同的结构。
 */
const PHOTON_URL = 'https://photon.komoot.io/api';
/** OSM 地物类型 → 模拟 feature_code，复用同一套可信度判断 */
const OSM_FEATURE = {
  'place:city': 'PPLA2',
  'place:town': 'PPLA3',
  'place:village': 'PPL',
  'place:township': 'PPLA4',
  'place:county': 'PPLA4',
  'place:district': 'PPLA4',
  'place:municipality': 'PPLA2',
  'place:state': 'ADM1',
  'place:region': 'ADM2',
  'place:suburb': 'PPLX',
  'place:hamlet': 'PPL',
};

async function searchPhoton(name) {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(name)}&limit=15`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sunset-plan-push/1.0 (github actions)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const features = Array.isArray(json.features) ? json.features : [];
  return features.map((f) => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates ?? [null, null];
    const key = `${p.osm_key}:${p.osm_value}`;
    return {
      name: p.name,
      admin1: p.state ?? null,
      admin2: p.county ?? null,
      country: p.country ?? null,
      latitude: lat,
      longitude: lon,
      population: null,
      // Photon 不返回时区，用坐标反查（结果缓存）
      timezone: null,
      feature_code: OSM_FEATURE[key] ?? (p.osm_key === 'aeroway' ? 'AIRP' : 'PPL'),
      _source: 'photon',
    };
  }).filter((e) => e.name && Number.isFinite(e.latitude));
}

/** 多轮检索：整个词、拆开后的每个词，Open-Meteo 中英文各来一次 + Photon 兜底，按坐标去重 */
async function collectCandidates(tokens) {
  const queries = new Set();
  queries.add(tokens.join(' '));
  for (const t of tokens) queries.add(t);
  // 中文的多种拼写/简称
  for (const t of tokens) {
    const stripped = stripSuffix(t);
    if (stripped !== t) queries.add(stripped);
    for (const [cn, ens] of Object.entries(ADMIN_ALIASES)) {
      if (stripSuffix(t) === cn) ens.forEach((e) => queries.add(e));
    }
  }

  const byKey = new Map();
  const add = (e) => {
    if (!Number.isFinite(Number(e.latitude)) || !Number.isFinite(Number(e.longitude))) return;
    const key = `${Number(e.latitude).toFixed(3)},${Number(e.longitude).toFixed(3)}`;
    const prev = byKey.get(key);
    // 同一地点两来源都有时，优先保留可信度更高的（城市/区县）
    if (!prev || (!featureInfo(prev.feature_code).trusted && featureInfo(e.feature_code).trusted)) byKey.set(key, e);
  };

  for (const q of queries) {
    for (const lang of ['zh', 'en']) {
      try {
        (await searchRaw(q, lang)).forEach(add);
      } catch {
        // 单个查询失败不影响整体
      }
    }
    try {
      (await searchPhoton(q)).forEach(add);
    } catch {
      // Photon 不可用时仅用 Open-Meteo
    }
  }
  return [...byKey.values()];
}

function toCandidate(e) {
  return {
    name: e.name,
    admin1: e.admin1 ?? null,
    admin2: e.admin2 ?? null,
    country: e.country ?? null,
    latitude: Number(e.latitude),
    longitude: Number(e.longitude),
    population: e.population ?? null,
    feature: featureInfo(e.feature_code).label,
  };
}

/**
 * 按名字解析地点。
 * @param {string} query 例如 "重庆"、"云南 大理"、"Chongqing"
 * @param {object} [opts] { admin1, country } 用于进一步限定
 * @returns {Promise<{name:string, latitude:number, longitude:number, timezone:string, resolved:object, candidates:object[]}>}
 */
export async function resolvePlaceByName(query, opts = {}) {
  const raw = String(query || '').trim();
  if (!raw) throw new Error('地点名称为空');

  const tokens = raw.split(/[\s,，]+/).filter(Boolean);
  if (!tokens.length) throw new Error(`地点名称无法解析：${query}`);

  const all = await collectCandidates(tokens);
  if (!all.length) throw new Error(`找不到地点「${query}」。可以尝试写得更完整（如「云南 大理」），或直接写 latitude/longitude。`);

  const narrowed = [];
  for (const e of all) {
    if (opts.country && !matchesAll(e, [opts.country])) continue;
    if (opts.admin1 && !matchesAll(e, [opts.admin1])) continue;
    const fi = featureInfo(e.feature_code);
    // 用非拉丁字母输入时，中文库里的结果是翻译过的（Chongqing → 重庆），此时跳过字面匹配
    const crossScript = /[a-z]/i.test(tokens.join('')) && /[\u4e00-\u9fa5]/.test(String(e.name || ''));
    if (!matchesAll(e, tokens) && !(crossScript && fi.trusted)) continue;
    // 机场/车站/社区这类“描述性设施”不能代表行政地名，直接排除（宁可报错也不给错坐标）
    if (fi.facility) continue;
    // 地名部分至少要与最后一个词（通常是具体地名）相似；
    // 若名字是按用户的词翻译来的（如 Chongqing → 重庆），也视为相符
    let nm = nameScore(e.name, tokens[tokens.length - 1]);
    if (nm <= 0 && fi.trusted) nm = 520;
    const popBonus = Math.min(90, Math.log10((e.population || 0) + 10) * 14);
    narrowed.push({ entry: e, score: nm + fi.score + popBonus, trusted: fi.trusted });
  }

  if (!narrowed.length) {
    const hint = all.slice(0, 5).map((c) => {
      const x = toCandidate(c);
      return `  · ${x.name}（${[x.admin1, x.admin2, x.country].filter(Boolean).join(' · ')}）${x.latitude},${x.longitude}`;
    }).join('\n');
    throw new Error(
      `找不到与「${query}」匹配的地点。近似候选：\n${hint}\n请写得更完整（如「云南 大理」），或在配置里直接写 latitude/longitude。`,
    );
  }

  narrowed.sort((a, b) => b.score - a.score);
  const best = narrowed[0];

  // 名字完全相同但有多个同名行政区时，优先可信地物类型（城市/区县）
  if (!best.trusted) {
    const better = narrowed.find((x) => x.trusted);
    if (better) {
      narrowed.splice(narrowed.indexOf(better), 1);
      narrowed.unshift(better);
    }
  }

  const chosen = narrowed[0];
  const chosenEntry = chosen.entry;
  const candidates = narrowed.slice(0, MAX_CANDIDATES).map((x) => toCandidate(x.entry));
  if (!candidates.some((c) => c.latitude === Number(chosenEntry.latitude) && c.longitude === Number(chosenEntry.longitude))) {
    candidates.unshift(toCandidate(chosenEntry));
  }

  const resolved = {
    name: chosenEntry.name,
    admin1: chosenEntry.admin1 ?? null,
    admin2: chosenEntry.admin2 ?? null,
    admin3: chosenEntry.admin3 ?? null,
    country: chosenEntry.country ?? null,
    population: chosenEntry.population ?? null,
    featureCode: chosenEntry.feature_code ?? null,
    feature: featureInfo(chosenEntry.feature_code).label,
    lat: Number(chosenEntry.latitude),
    lon: Number(chosenEntry.longitude),
    trusted: chosen.trusted,
  };

  if (!chosen.trusted) {
    console.warn(
      `[地点] ⚠ 「${query}」匹配到「${resolved.name}」（${[resolved.admin1, resolved.admin2, resolved.country].filter(Boolean).join(' · ')}，${resolved.feature}）` +
        ` ${resolved.lat},${resolved.lon}\n` +
        `       该结果不是城市/区县级别，可能不是你要的地点。建议写得更明确（如「云南 大理」）或直接指定经纬度。`,
    );
  }

  // Photon 不带时区：用 Open-Meteo 按坐标反查一次（timezone=auto 会返回该点所在时区）
  const timezone = chosenEntry.timezone ?? (await lookupTimezone(resolved.lat, resolved.lon));

  return {
    name: raw,
    latitude: resolved.lat,
    longitude: resolved.lon,
    timezone: timezone ?? undefined,
    resolved,
    candidates,
  };
}

/** 按坐标取时区：Open-Meteo 的 timezone=auto 会返回该点所在时区 */
async function lookupTimezone(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&hourly=temperature_2m`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json.timezone ?? null;
  } catch {
    return null;
  }
}

/** 批量解析，打印每个地点的解析结果 */
export async function resolvePlaces(entries) {
  const out = [];
  for (const e of entries) {
    if (Number.isFinite(e.latitude) && Number.isFinite(e.longitude)) {
      out.push({ ...e, resolved: { name: e.name, source: 'manual', lat: e.latitude, lon: e.longitude, trusted: true } });
      continue;
    }
    if (!e.name) throw new Error('locations 里有一项既没有 name 也没有经纬度');
    const loc = await resolvePlaceByName(e.name, { admin1: e.admin1, country: e.country });
    out.push({ ...e, ...loc, name: e.name });
  }
  return out;
}
