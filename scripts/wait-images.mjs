// GitHub Pages 是异步部署的：推送完 gh-pages 后，图片 URL 往往要等几十秒才可用。
// 这里先确认 Pages 是否已启用，再轮询图片地址；确认不可用的图片会从推送正文里摘掉，
// 避免微信里出现裂图。
import fs from 'node:fs';

const WAIT_MS = Number(process.env.IMAGE_WAIT_MS || 180_000);
const INTERVAL_MS = 10_000;
const MANIFEST = 'out/manifest.json';

/** 图片是否已经可以访问（Pages 可能不支持 Range，所以 200/206 都算成功） */
async function reachable(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return false;
    return res.ok;
  } catch {
    return false;
  }
}

/** 用 API 判断仓库是否启用了 Pages；未知时返回 null（不影响后续流程） */
async function pagesEnabled() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pages`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return false;
    return res.ok;
  } catch {
    return null;
  }
}

if (!fs.existsSync(MANIFEST)) {
  console.log('没有 manifest，跳过');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const targets = [...new Set(manifest.map((m) => m.imageUrl).filter(Boolean))];

if (!targets.length) {
  console.log('无需等待图片发布（未配置 IMAGE_BASE_URL）');
  process.exit(0);
}

const enabled = await pagesEnabled();
if (enabled === false) {
  console.log('::error::仓库没有启用 GitHub Pages，图片无法公网访问。');
  console.log('解决：仓库 Settings → Pages → Source 选 Deploy from a branch，分支选 gh-pages、目录 / (root)。');
  console.log('本次将只推送文字内容，图片可从 Actions 页面的 Artifact 下载。');
}

const deadline = Date.now() + (enabled === false ? 0 : WAIT_MS);
let pending = targets;

while (pending.length && Date.now() <= deadline) {
  const results = await Promise.all(pending.map(async (u) => [u, await reachable(u)]));
  const ready = results.filter(([, ok]) => ok).map(([u]) => u);
  pending = pending.filter((u) => !ready.includes(u));
  console.log(`图片可用 ${targets.length - pending.length}/${targets.length}`);
  if (!pending.length) break;
  if (Date.now() + INTERVAL_MS > deadline) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

if (!pending.length) {
  console.log('全部图片已可公网访问');
  process.exit(0);
}

console.log('::warning::部分图片暂时无法访问，已从推送正文中移除这些图片链接。');
for (const u of pending) console.log(' -', u);

// 把不可用图片从 manifest 里摘掉，避免微信里出现裂图
const norm = (u) => {
  try {
    return decodeURI(String(u)).trim();
  } catch {
    return String(u).trim();
  }
};
const badSet = new Set(pending.map(norm));
for (const item of manifest) {
  if (!item.imageUrl || !badSet.has(norm(item.imageUrl))) continue;
  item.imageUrl = null;
  item.imageUnavailable = true;
  item.desp = String(item.desp || '')
    .split('\n')
    .filter((line) => {
      const link = line.match(/!?\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
      if (!link) return true;
      // 只移除指向失败图片的那一行，其它链接（如“查看交互版”）保留
      return !badSet.has(norm(link[1]));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
