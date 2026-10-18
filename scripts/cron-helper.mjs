// 辅助：给出某时区某天的日出/日落，并换算成 GitHub Actions cron（UTC）。
// 用法：node scripts/cron-helper.mjs [latitude] [longitude] [--date YYYY-MM-DD] [--lead 180]
//
// 例如：node scripts/cron-helper.mjs 31.23 121.47 --lead 180
import { fetchDetail } from '../lib/model.js';

const args = process.argv.slice(2);
const num = (i, d) => (args[i] !== undefined && !args[i].startsWith('--') ? Number(args[i]) : d);
const latitude = Number.isFinite(num(0, NaN)) ? num(0, 31.23) : 31.23;
const longitude = Number.isFinite(num(1, NaN)) ? num(1, 121.47) : 121.47;
const lead = Number(args[args.indexOf('--lead') + 1]) || 180;
const di = args.indexOf('--date');
const dateISO = di >= 0 ? args[di + 1] : new Date().toISOString().slice(0, 10);

const d = await fetchDetail({ latitude, longitude, dateISO, mode: 'sunset' });
const offsetHours = d.utcOffsetSeconds / 3600;

/** 本地 HH:MM → UTC cron 字段（向下取整到 5 分钟） */
function toCron(localHM) {
  const [h, m] = localHM.split(':').map(Number);
  const utc = Math.round(((h - offsetHours) * 60 + m) / 1440 * 1440);
  const total = ((utc % 1440) + 1440) % 1440;
  const um = total % 60;
  const uh = Math.floor(total / 60);
  return `"${um} ${uh} * * *"`;
}

function shift(hm, deltaMin) {
  const [h, m] = hm.split(':').map(Number);
  let t = ((h * 60 + m + deltaMin) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const sunrise = d.sunrise.slice(11);
const sunset = d.sunset.slice(11);
console.log(`时区：${d.timezone}（UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}）  日期：${dateISO}`);
console.log(`日出 ${sunrise}  日落 ${sunset}`);
console.log('');
console.log(`晚霞推送（日落前 ${lead} 分钟，本地 ${shift(sunset, -lead)}）→ cron ${toCron(shift(sunset, -lead))}`);
console.log(`朝霞推送（日出后 10 分钟，本地 ${shift(sunrise, 10)}）→ cron ${toCron(shift(sunrise, 10))}`);
console.log('');
console.log('注意：GitHub 定时任务在整点附近易排队延迟，晚霞建议留 15~30 分钟余量（用更大的 --lead）。');
