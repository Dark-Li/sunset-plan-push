// 预测图渲染 —— 1:1 复刻站点“分享预测图”的 Canvas 绘制（单城市卡）。
// 版式与配色全部取自 sunset-plan 前端 JX()，只做了少量健壮性处理（中文无衬线字体兜底）。
import { createCanvas } from '@napi-rs/canvas';

const W = 750; // 原站 Sr
const PAD = 44; // 原站 Le
const CARD_H = 152; // 原站 fL

// 原站字体串里的 system-ui 在 Linux（GitHub Actions）下会回退到无 CJK 的字体，
// 这里显式补上常见中文字体族，Windows / macOS / Linux 都能落到中文字体上。
const CJK = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Hiragino Sans GB", sans-serif';
const SANS = `system-ui, -apple-system, ${CJK}`;
const NUM = `system-ui, -apple-system, "Segoe UI", Arial, ${CJK}`;

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
  return out + '…';
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let cur = '';
  let overflow = false;
  for (const ch of text) {
    const next = cur + ch;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) {
        overflow = true; // 已占满 maxLines 行且仍有剩余文字
        break;
      }
    } else {
      cur = next;
    }
  }
  if (!overflow && cur) lines.push(cur);
  if (!overflow) return lines;

  // 只有真的被截断才加省略号，并去掉省略号前的标点，避免出现“。 …”
  let last = lines[maxLines - 1];
  while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
  last = last.replace(/[，。；、,.;\s]+$/, '');
  lines[maxLines - 1] = last + '…';
  return lines;
}

/** 原站 QX()：根据指标数量计算画布高度 */
export function cardHeight(metricCount) {
  let h = PAD + 6;
  h += 34;
  h += 56;
  h += CARD_H + 22;
  h += 22;
  h += 57;
  const rows = Math.ceil(metricCount / 2);
  h += rows * 62 + (rows - 1) * 12 + 30;
  h += 54 + PAD;
  return Math.round(h);
}

/**
 * 绘制单城市预测图。
 * @param {object} card 与原站分享图入参一致：
 *   { placeName, dateLabel, modeLabel, eventTime, score, ratingLabel, colorHex, colorName,
 *     colorDesc, timeRange, metrics: [{label, value}] }
 * @returns {Buffer} PNG 数据
 */
export function renderPredictionCard(card) {
  const scale = 2;
  const H = cardHeight(card.metrics.length);
  const canvas = createCanvas(W * scale, H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b1020');
  bg.addColorStop(0.55, '#141a2e');
  bg.addColorStop(1, '#0a0d18');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 顶部色条
  const bar = ctx.createLinearGradient(0, 0, W, 0);
  bar.addColorStop(0, `${card.colorHex}00`);
  bar.addColorStop(0.5, card.colorHex);
  bar.addColorStop(1, `${card.colorHex}00`);
  ctx.fillStyle = bar;
  ctx.globalAlpha = 0.75;
  ctx.fillRect(0, 0, W, 4);
  ctx.globalAlpha = 1;

  let y = PAD + 6;

  // 标题
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `600 15px ${SANS}`;
  ctx.textBaseline = 'top';
  ctx.fillText('Sunset Plan · 朝晚霞定量预报', PAD, y);
  y += 34;

  // 地点名 + 日期/霞别 + 时刻
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 34px ${SANS}`;
  ctx.fillText(ellipsize(ctx, card.placeName, W - PAD * 2 - 150), PAD, y);

  ctx.textAlign = 'right';
  ctx.font = `500 15px ${SANS}`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText(`${card.dateLabelText ?? `${card.dateLabel} ${card.modeLabel}`}`, W - PAD, PAD + 40, W / 2 - PAD);
  ctx.font = `500 14px ${NUM}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(`${card.modeLabel}时刻 ${card.eventTime}`, W - PAD, PAD + 64);
  ctx.textAlign = 'left';
  y += 56;

  // 评分卡
  const h = CARD_H;
  roundedRect(ctx, PAD, y, W - PAD * 2, h, 20);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 68px ${NUM}`;
  ctx.fillText(String(card.score), PAD + 26, y + 30);
  const scoreW = ctx.measureText(String(card.score)).width;
  ctx.font = `500 15px ${NUM}`;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('/100', PAD + 30 + scoreW, y + 72);
  ctx.font = `600 16px ${CJK}`;
  ctx.fillStyle = card.colorHex;
  ctx.fillText(card.ratingLabel, PAD + 26, y + 104);

  // 色彩方块
  const box = 96;
  const bx = W - PAD - 26 - box;
  const textRight = bx - 18;
  const descWidth = textRight - (PAD + 26 + 120); // 右侧留给色块文字的区域，避开左侧大分数
  roundedRect(ctx, bx, y + 28, box, box, 16);
  ctx.fillStyle = card.colorHex;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = 'right';
  ctx.font = `600 18px ${CJK}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(ellipsize(ctx, card.colorName, descWidth), textRight, y + 44);
  ctx.font = `400 13px ${CJK}`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  wrapLines(ctx, card.colorDesc, descWidth, 3).forEach((line, i) => {
    ctx.fillText(line, textRight, y + 74 + i * 20);
  });
  ctx.textAlign = 'left';
  y += h + 22;

  // 可见时段
  ctx.font = `500 14px ${CJK}`;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('可见时段', PAD, y);
  y += 22;
  ctx.font = `600 17px ${CJK}`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(ellipsize(ctx, card.timeRange, W - PAD * 2), PAD, y);
  y += 40;

  // 指标网格（两列）
  const cols = 2;
  const gap = 16;
  const cellW = (W - PAD * 2 - gap) / cols;
  const cellH = 62;
  const rowGap = 12;
  card.metrics.forEach((m, i) => {
    const x = PAD + (i % cols) * (cellW + gap);
    const cy = y + Math.floor(i / cols) * (cellH + rowGap);
    roundedRect(ctx, x, cy, cellW, cellH, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `400 12.5px ${CJK}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(ellipsize(ctx, m.label, cellW - 28), x + 14, cy + 13);
    ctx.font = `600 19px ${CJK}`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(ellipsize(ctx, m.value, cellW - 28), x + 14, cy + 32);
  });
  const rows = Math.ceil(card.metrics.length / cols);
  y += rows * cellH + (rows - 1) * rowGap + 30;

  // 页脚
  ctx.font = `400 12px ${CJK}`;
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.fillText('数据来源：Open-Meteo · 国家卫星气象中心（NSMC）', PAD, H - PAD - 16);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('sunset-plan.vercel.app', W - PAD, H - PAD - 4);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}
