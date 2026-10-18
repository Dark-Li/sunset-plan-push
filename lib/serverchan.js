// Server酱（SCT / SC3）推送封装
// 文档：https://sct.ftqq.com（Turbo）/ https://sc3.ft07.com，图片需为 https 外链。

/**
 * 根据 SendKey 前缀选择端点。
 * - sctp… → Server酱³：https://<num>.push.ft07.com/send
 * - 其他   → Turbo：https://sctapi.ftqq.com/<key>.send
 */
export function resolveEndpoint(sendKey) {
  if (!sendKey) throw new Error('缺少 SERVERCHAN_SENDKEY');
  if (sendKey.startsWith('sctp')) {
    const m = sendKey.match(/^sctp(\d+)t/);
    if (!m) throw new Error('SendKey 形如 sctp<数字>t<token>，当前前缀格式不正确');
    return `https://${m[1]}.push.ft07.com/send`;
  }
  return `https://sctapi.ftqq.com/${sendKey}.send`;
}

/**
 * 发送消息
 * @param {object} p
 * @param {string} p.sendKey SendKey
 * @param {string} p.title 标题
 * @param {string} p.desp Markdown 正文（支持 https 图片外链）
 * @param {object} [p.options] 额外参数：tags / short / noip / channel / openid
 */
export async function pushMessage({ sendKey, title, desp, options = {} }) {
  const url = resolveEndpoint(sendKey);
  const body = new URLSearchParams({ title, desp, ...options });

  // 这些都是参数/鉴权问题，重试没有意义
  const FATAL_CODES = new Set([40001, 40002, 40003, 40004, 40005]);

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`返回内容无法解析（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      if (!res.ok || json.code !== 0) {
        const err = new Error(`推送失败 code=${json.code} message=${json.message ?? text.slice(0, 200)}`);
        if (FATAL_CODES.has(json.code)) err.fatal = true;
        throw err;
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt >= 2) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  // 避免把 SendKey 打进日志
  throw new Error(`Server酱推送失败：${lastErr?.message ?? lastErr}`);
}
