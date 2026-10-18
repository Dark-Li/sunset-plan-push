// GitHub Pages 是异步部署的：推送完 gh-pages 后图片 URL 可能要等几十秒才可用。
// 这里轮询若干次，确保 Server酱 抓取时图片已经存在；全部失败则降级为纯文字推送。
import fs from 'node:fs';

const WAIT_MS = Number(process.env.IMAGE_WAIT_MS || 240_000);
const INTERVAL_MS = 15_000;

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15_000) });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

const manifest = JSON.parse(fs.readFileSync('out/manifest.json', 'utf8'));
const targets = [...new Set(manifest.map((m) => m.imageUrl).filter(Boolean))];

if (!targets.length) {
  console.log('无需等待图片发布');
  process.exit(0);
}

const deadline = Date.now() + WAIT_MS;
let pending = targets;
while (pending.length) {
  const results = await Promise.all(pending.map(async (u) => [u, await headOk(u)]));
  const ready = results.filter(([, ok]) => ok).map(([u]) => u);
  pending = pending.filter((u) => !ready.includes(u));
  console.log(`图片可用 ${targets.length - pending.length}/${targets.length}`);
  if (!pending.length) break;
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

if (pending.length) {
  console.warn('以下图片在等待时间内未上线，正文里的图片链接可能暂时打不开：');
  for (const u of pending) console.warn(' -', u);
  // 不阻塞推送：Server酱 可能稍后重试抓图；同时保留文字信息。
  fs.writeFileSync('out/unavailable-images.json', JSON.stringify(pending, null, 2));
}
