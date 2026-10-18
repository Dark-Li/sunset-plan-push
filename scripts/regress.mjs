// 全量回归：输出本地结果 + 站点等价展示值
import { fetchDetail, evaluate } from '../lib/model.js';
import { buildCard } from '../lib/card.js';
import { classifyCloud } from '../lib/model.js';

const PLACES = [
  ['重庆', 29.56, 106.55],
  ['北京', 39.9, 116.4],
  ['上海', 31.23, 121.47],
  ['成都', 30.57, 104.07],
];
const DATE = process.env.DATE || '2026-10-18';

console.log('城市 霞别 | 评分 评级 | 时长(分) | 云底(展示) | D(展示) | 关键维度');
for (const [name, lat, lon] of PLACES) {
  for (const mode of ['sunset', 'sunrise']) {
    const d = await fetchDetail({ latitude: lat, longitude: lon, dateISO: DATE, mode });
    const ev = evaluate(d, mode);
    const card = buildCard({ detail: d, evaluation: ev, placeName: name, mode, dateISO: DATE });
    const f = ev.rating.factors.map((x) => `${x.label.slice(0, 2)}${x.score}`).join(' ');
    console.log(
      `${name} ${mode === 'sunset' ? '晚' : '朝'} | ${String(ev.rating.rating.score).padStart(3)} ${ev.rating.rating.label.padEnd(3)} | ` +
        `${ev.rating.totalDurationMin.toFixed(1).padStart(5)} | ${String(card.metrics[0].value).padStart(8)} | ${String(card.metrics[1].value).padStart(7)} | ${f}`,
    );
  }
}
void classifyCloud;
