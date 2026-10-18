#!/usr/bin/env node
// 主流程：读取 config.json → 抓取 Open-Meteo → 评分 → 渲染预测图 →（可选）推送 Server酱
//
// 一天两班，由 --slot / PUSH_SLOT 决定发哪几天（具体内容见 config.json 的 schedule）：
//   --slot afternoon  → 默认：当天晚霞 + 明天朝霞
//   --slot evening    → 默认：明天朝霞 + 明天晚霞
//
// 常用用法：
//   node scripts/push.mjs --slot evening --dry-run   # 只生成图片和正文，不推送
//   node scripts/push.mjs --slot afternoon           # 生成并推送（需要 SERVERCHAN_SENDKEY）
//   node scripts/push.mjs --add-image-urls           # 给已生成的 manifest 补上公网图片地址并推送
//   node scripts/push.mjs --slot evening --place 沈阳 --mode sunset
//
// 环境变量：SERVERCHAN_SENDKEY（推送必需）、IMAGE_BASE_URL（图片公网访问前缀）、PUSH_SLOT

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDetail, evaluate } from '../lib/model.js';
import { buildCard } from '../lib/card.js';
import { renderPredictionCard } from '../lib/render.js';
import { pushMessage } from '../lib/serverchan.js';
import { resolvePlaceByName } from '../lib/geocode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'out');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

// ---------- 参数 ----------
function parseArgs(argv) {
  const opts = { dryRun: false, mode: null, place: null, date: null, threshold: 0, addImageUrls: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--place') opts.place = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--score-threshold') opts.threshold = Number(argv[++i]) || 0;
    else if (a === '--slot') opts.slot = argv[++i];
    else if (a === '--add-image-urls') opts.addImageUrls = true;
  }
  return opts;
}

// ---------- 时间工具 ----------
function zonedNow(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    dateISO: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

function addDays(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function resolveDate(arg, tz) {
  const today = zonedNow(tz).dateISO;
  if (!arg || arg === 'today') return today;
  if (arg === 'tomorrow') return addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error(`日期格式应为 YYYY-MM-DD：${arg}`);
  return arg;
}

/** 判断某个日期相对“今天”是今天/明天/后天 */
function dayRelation(todayISO, dateISO) {
  const diff = Math.round((Date.parse(`${dateISO}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / 86400e3);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff < 0) return `过去${-diff}天`;
  return `${diff}天后`;
}

// ---------- 配置 ----------
/**
 * 读取配置。地点只需写 name（如“重庆”“云南 大理”），缺经纬度时自动按名字检索；
 * 也可以继续手写 latitude/longitude（两者同时存在时以手写坐标为准）。
 */
async function loadConfig() {
  const file = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const locations = (raw.locations || []).map((l) => ({ ...l }));
  if (!locations.length) throw new Error('config.json 里没有任何 location');

  for (const l of locations) {
    if (!l.name) throw new Error('locations 里每一项都必须有 name');
    if (Number.isFinite(l.latitude) && Number.isFinite(l.longitude)) continue;
    // 只写了名字 → 按名字定位
    const loc = await resolvePlaceByName(l.name, { admin1: l.admin1, country: l.country });
    const r = loc.resolved;
    console.log(`[地点] 「${l.name}」→ ${r.name}（${[r.admin1, r.admin2, r.country].filter(Boolean).join(' · ')}）${r.lat},${r.lon}`);
    l.latitude = loc.latitude;
    l.longitude = loc.longitude;
    if (!l.timezone) l.timezone = loc.timezone;
    l.resolved = r;
  }

  if (!locations.some((l) => l.resolved)) {
    console.log('[地点] 所有地点都使用手写坐标');
  }

  const pushes = Array.isArray(raw.pushes) && raw.pushes.length
    ? raw.pushes
    : locations.map((l) => ({ place: l.name, mode: 'sunset', timer: 'both' }));
  return { ...raw, locations, pushes };
}

/**
 * 推送计划（schedule）：把每次定时推送要发的内容写清楚。
 *
 * 默认两班：
 *   afternoon（13:00）→ 当天晚霞 + 第二天朝霞
 *   evening  （20:00）→ 第二天朝霞 + 第二天晚霞
 * 每一项写成 { location, mode, dayOffset }，dayOffset 相对“地点当地的今天”。
 *
 * 也可以在 config.json 里用 "schedule" 字段自定义：
 *   "schedule": {
 *     "affternoon": { "tasks": [
 *         { "place": "重庆", "mode": "sunset",  "day": "today" },
 *         { "place": "重庆", "mode": "sunrise", "day": "tomorrow" } ] }
 *   }
 */
const DAY_OFFSET = { today: 0, '0': 0, tomorrow: 1, '1': 1, dayafter: 2, '2': 2 };
function dayValueToOffset(day) {
  if (typeof day === 'number' && Number.isFinite(day)) return day;
  const key = String(day ?? 'today').toLowerCase();
  if (key in DAY_OFFSET) return DAY_OFFSET[key];
  throw new Error(`schedule 里的 day 只能是 today / tomorrow / dayafter 或数字，收到：${day}`);
}

const DEFAULT_SCHEDULE = {
  afternoon: {
    label: '午后',
    tasks: [
      { mode: 'sunset', day: 'today', dayOffset: 0 },
      { mode: 'sunrise', day: 'tomorrow', dayOffset: 1 },
    ],
  },
  evening: {
    label: '晚间',
    tasks: [
      { mode: 'sunrise', day: 'tomorrow', dayOffset: 1 },
      { mode: 'sunset', day: 'tomorrow', dayOffset: 1 },
    ],
  },
};

function scheduleOf(config) {
  const custom = config.schedule && typeof config.schedule === 'object' ? config.schedule : null;
  if (!custom) return DEFAULT_SCHEDULE;
  const out = {};
  for (const [key, val] of Object.entries(custom)) {
    if (!val || !Array.isArray(val.tasks) || !val.tasks.length) {
      throw new Error(`schedule.${key} 需要 tasks 数组`);
    }
    out[key] = {
      label: val.label || key,
      tasks: val.tasks.map((t) => {
        const day = String(t.day ?? 'today');
        return {
          place: t.place,
          mode: t.mode ?? 'both',
          day,
          dayOffset: dayValueToOffset(t.day),
        };
      }),
    };
  }
  return out;
}

/** 选择本次要跑的任务：{ location, mode, dateISO, slotLabel } */
function selectJobs(config, opts) {
  const schedule = scheduleOf(config);
  const slotKey = opts.slot || 'afternoon';
  const slot = schedule[slotKey];
  if (!slot) {
    throw new Error(`未知的推送时段「${slotKey}」，可选：${Object.keys(schedule).join(' / ')}`);
  }

  const byName = (name) => {
    const loc = config.locations.find((l) => l.name === name);
    if (!loc) throw new Error(`配置里没有这个地点：${name}`);
    return loc;
  };

  const jobs = [];
  const seen = new Set();
  for (const task of slot.tasks) {
    // schedule 里指定了 place → 只发该地点；否则按 pushes 规则对全部地点生效
    let targets;
    if (task.place) {
      targets = [{ location: byName(task.place) }];
    } else {
      targets = config.pushes
        // 地点自己的 mode 限制要尊重：规则只开 sunset 时，朝霞任务跳过它
        .filter((r) => task.mode === 'both' || !r.mode || r.mode === 'both' || r.mode === task.mode)
        .map((r) => ({ location: byName(r.place) }));
    }

    for (const { location } of targets) {
      const today = zonedNow(location.timezone).dateISO;
      const dateISO = addDays(today, task.dayOffset);
      // 同一个（地点 + 霞别 + 日期）只保留一次，避免多条规则叠出重复推送
      const key = `${location.name}|${task.mode}|${dateISO}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ location, mode: task.mode, dateISO, slotLabel: slot.label });
    }
  }

  let filtered = jobs;
  if (opts.place) filtered = filtered.filter((j) => j.location.name === opts.place);
  if (opts.mode) {
    const wanted = opts.mode === 'both' ? ['sunrise', 'sunset'] : [opts.mode];
    filtered = filtered.filter((j) => wanted.includes(j.mode));
  }
  if (!filtered.length) throw new Error('没有匹配到任何推送任务，请检查参数或 config.json');
  return filtered;
}

// ---------- 推送正文 ----------
function factorBar(factors) {
  const pick = ['云况', '云边界', '通透度', '色彩'];
  return pick
    .map((k) => {
      const f = factors.find((x) => x.label === k);
      return f ? `${k} ${f.score}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * 生成单条推送。
 * @param {object} card 预测图入参
 * @param {string|null} imageUrl 图片公网地址
 * @param {string} [relation] 今天 / 明天 / 后天，用于标题与正文里点明是哪一天
 */
function buildMessage(card, imageUrl, relation = '今天') {
  const e = card.extra;
  const rel = relation && relation !== '今天' ? relation : '';
  const dayText = rel ? `${rel}（${card.dateLabel}）` : card.dateLabel;
  const title = rel
    ? `${rel}${card.modeLabel} · ${card.placeName} ${card.score} 分 · ${card.ratingLabel}`
    : `${card.placeName} 今天${card.modeLabel} ${card.score} 分 · ${card.ratingLabel}`;
  const lines = [
    `## ${card.placeName} · ${dayText} ${card.modeLabel}预报`,
    '',
    `**评分 ${card.score}/100 · ${card.ratingLabel}**`,
    `- ${card.modeLabel}时刻：**${card.eventTime}**（日出 ${e.sunrise} / 日落 ${e.sunset}）`,
    `- 可见时段：${card.timeRange}`,
    `- 色彩：${card.colorName}（\`${card.colorHex}\`）`,
    `- 云状：${e.cloudName}（${e.cloudCode}）`,
    `- 云底 ${card.metrics[0].value} · 云边界 ${card.metrics[1].value} · 通透度 ${card.metrics[3].value} · AOD ${card.metrics[4].value}`,
    `- 多维评分：${factorBar(e.factors)}`,
  ];
  const tip = e.notes.find((n) => /云边界|霞光|透过率|晴空|阴天|降雨/.test(n));
  if (tip) lines.push('', `> ${tip}`);
  lines.push('', '[查看交互版](https://sunset-plan.vercel.app)');
  if (imageUrl) {
    lines.push('', `![${card.placeName}${card.modeLabel}预测图](${imageUrl})`, '', `[查看大图](${imageUrl})`);
  }
  return { title, desp: lines.join('\n') };
}

async function sendAll(manifest, opts) {
  const sendKey = process.env.SERVERCHAN_SENDKEY;
  if (!sendKey) throw new Error('未设置 SERVERCHAN_SENDKEY 环境变量（或使用 --dry-run 只生成图片）');
  const baseUrl = (process.env.IMAGE_BASE_URL || '').replace(/\/+$/, '');

  let ok = 0;
  let failed = 0;
  for (const item of manifest) {
    try {
      const imageUrl = item.imageUrl || (baseUrl ? `${baseUrl}/${item.file}` : null);
      if (baseUrl && imageUrl !== item.imageUrl) {
        item.imageUrl = imageUrl;
        const rebuilt = buildMessage(item.card, imageUrl, item.relation);
        item.title = rebuilt.title;
        item.desp = rebuilt.desp;
      }
      await pushMessage({
        sendKey,
        title: item.title,
        desp: item.desp,
        options: {
          tags: '晚霞预报|SunsetPlan',
          short: `${item.relation === '今天' ? '' : item.relation}${item.modeLabel} ${item.score} 分 · ${item.ratingLabel} · ${item.eventTime}`,
        },
      });
      ok++;
      console.log(`[${item.place} ${item.date} ${item.mode}] 推送成功`);
    } catch (err) {
      failed++;
      console.error(`[${item.place} ${item.date} ${item.mode}] 推送失败：${err.message}`);
    }
  }
  console.log(`推送完成：成功 ${ok}，失败 ${failed}`);
  if (failed) process.exitCode = 1;
}

// ---------- 主流程 ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // 时段：afternoon(13:00) / evening(20:00)，由工作流或 --slot 决定
  opts.slot = opts.slot || process.env.PUSH_SLOT || 'afternoon';
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 模式二：图片已发布，补上公网地址后统一推送
  if (opts.addImageUrls) {
    if (!fs.existsSync(MANIFEST)) throw new Error('找不到 out/manifest.json，请先生成图片');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (!manifest.length) {
      console.log('没有待推送的内容');
      return;
    }
    if (opts.dryRun) {
      for (const m of manifest) {
        console.log('\n----- 推送预览 -----');
        console.log('标题：', m.title);
        console.log(m.desp);
      }
      return;
    }
    await sendAll(manifest, opts);
    return;
  }

  const config = await loadConfig();
  const jobs = selectJobs(config, opts);
  const todayByPlace = new Map(jobs.map((j) => [j.location.name, zonedNow(j.location.timezone).dateISO]));
  const manifest = [];
  const baseUrl = (process.env.IMAGE_BASE_URL || '').replace(/\/+$/, '');
  let failed = 0;

  console.log(`[计划] 时段「${opts.slot}」，共 ${jobs.length} 条`);
  for (const job of jobs) {
    const { location, mode, dateISO } = job;
    const modeLabel = mode === 'sunset' ? '晚霞' : '朝霞';
    const rel = dayRelation(todayByPlace.get(location.name), dateISO); // 今天 / 明天 / 后天
    const relText = rel === '今天' ? '' : rel;
    const label = `[${location.name} ${relText}${modeLabel} ${dateISO}]`;
    try {
      console.log(`${label} 抓取数据...`);
      const detail = await fetchDetail({ latitude: location.latitude, longitude: location.longitude, dateISO, mode });
      const evaluation = evaluate(detail, mode);
      const card = buildCard({ detail, evaluation, placeName: location.name, mode, dateISO });

      if (card.score < opts.threshold) {
        console.log(`${label} 评分 ${card.score} 低于阈值 ${opts.threshold}，跳过`);
        continue;
      }

      const fileName = `${location.name}-${mode}-${dateISO}.png`;
      const png = renderPredictionCard(card);
      fs.writeFileSync(path.join(OUT_DIR, fileName), png);
      // 生成阶段就把图片公网地址写进 manifest：
      // 后续「等待图片可用」要靠它轮询，推送阶段也能直接复用，避免图裂。
      const imageUrl = baseUrl ? `${baseUrl}/${encodeURIComponent(fileName)}` : null;
      const { title, desp } = buildMessage(card, imageUrl, rel);
      console.log(`${label} 评分 ${card.score}（${card.ratingLabel}）→ out/${fileName}`);

      manifest.push({
        file: fileName,
        place: location.name,
        date: dateISO,
        mode,
        modeLabel,
        relation: rel,
        score: card.score,
        ratingLabel: evaluation.rating.rating.label,
        eventTime: card.eventTime,
        title,
        desp,
        imageUrl,
        card,
      });
    } catch (err) {
      failed++;
      console.error(`${label} 失败：${err.message}`);
    }
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  if (opts.dryRun) {
    for (const m of manifest) {
      console.log('\n----- 推送预览 -----');
      console.log('标题：', m.title);
      console.log(m.desp);
    }
  } else {
    await sendAll(manifest, opts);
  }

  if (failed && failed === jobs.length) process.exit(1);
}

main().catch((err) => {
  console.error('运行失败：', err.message);
  process.exit(1);
});
