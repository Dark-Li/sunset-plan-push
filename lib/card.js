// 把评分结果组装成“预测图”入参（复刻站点页面里 on = useMemo(...) 那段分享图数据）。
import { classifyCloud } from './model.js';

/** HH:MM 加分钟偏移（原站 ai；分钟四舍五入后可能进位，需重新归一化） */
export function shiftTime(hm, offsetMin) {
  const m = hm.match(/T(\d{2}):(\d{2})/);
  if (!m) return hm;
  let total = Number(m[1]) * 60 + Number(m[2]) + offsetMin;
  total = ((Math.round(total) % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** ISO 时间 → HH:MM（原站 a0） */
export function hhmm(iso) {
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : String(iso);
}

/** YYYY-MM-DD → M月D日（原站 Mh） */
export function dateLabel(iso) {
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(iso);
}

/** 分钟 → x分钟 / x分y秒（原站 Ch） */
export function formatDuration(min) {
  const secTotal = Math.round(min * 60);
  const m = Math.floor(secTotal / 60);
  const s = secTotal % 60;
  if (m <= 0) return `${s}秒`;
  if (s === 0) return `${m}分钟`;
  return `${m}分${s}秒`;
}

/**
 * @param {object} p
 * @param {object} p.detail fetchDetail() 的返回值
 * @param {object} p.evaluation evaluate() 的返回值
 * @param {string} p.placeName 地点显示名
 * @param {'sunset'|'sunrise'} p.mode
 * @param {string} p.dateISO YYYY-MM-DD
 */
export function buildCard({ detail, evaluation, placeName, mode, dateISO }) {
  const r = evaluation.rating;
  const modeLabel = mode === 'sunset' ? '晚霞' : '朝霞';
  const event = hhmm(detail.eventTime);

  let timeRange;
  if (r.totalDurationMin > 0) {
    timeRange = `${shiftTime(detail.eventTime, r.startOffsetMin)} – ${shiftTime(detail.eventTime, r.endOffsetMin)}（持续 ${formatDuration(r.totalDurationMin)}）`;
  } else {
    timeRange = '本次无明显可见时段';
  }

  const cloud = classifyCloud(evaluation.cloudBaseKm, null, detail.cloudCoverLow, detail.cloudCoverMid, detail.cloudCoverHigh);

  return {
    placeName,
    dateLabel: dateLabel(dateISO),
    // 原站是两段标签拼接，直接拼会连成“10月17日晚霞”，中间补一个空格
    dateLabelText: `${dateLabel(dateISO)} ${modeLabel}`,
    modeLabel,
    eventTime: event,
    score: r.rating.score,
    ratingLabel: r.rating.label,
    colorHex: r.color.hex,
    colorName: r.color.name,
    colorDesc: r.color.description,
    timeRange,
    metrics: [
      { label: '云底高度 H', value: `${evaluation.cloudBaseKm.toFixed(1)} km` },
      { label: '云边界距离 D', value: `${Math.round(evaluation.boundaryKm)} km` },
      { label: '霞光深入距离', value: `${r.glowPenetrationKm.toFixed(0)} km` },
      { label: '大气通透度', value: `${Math.round(r.clarity * 100)}%` },
      { label: '气溶胶 AOD', value: evaluation.aod.toFixed(2) },
      { label: '持续时长', value: formatDuration(r.totalDurationMin) },
    ],
    // 供推送正文使用的附加信息（不进入图片）
    extra: {
      cloudName: cloud?.name ?? '—',
      cloudCode: cloud?.code ?? '—',
      cloudNote: cloud?.note ?? '',
      sunrise: hhmm(detail.sunrise),
      sunset: hhmm(detail.sunset),
      shotSchedule: r.shotSchedule,
      notes: r.notes,
      factors: r.factors,
      low: detail.cloudCoverLow,
      mid: detail.cloudCoverMid,
      high: detail.cloudCoverHigh,
    },
  };
}
