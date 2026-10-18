// 清洗 extract.mjs 生成的 model.raw.js：
// bundle 中存在若干同名函数的重复拷贝（不同 chunk 中相同源码），
// 以及被“色块画布”复用同名符号导致的重复声明。这里按函数名去重，保留首次出现。
import fs from 'node:fs';

const p = new URL('./model.raw.js', import.meta.url);
let src = fs.readFileSync(p, 'utf8');

// 1) 去掉 export 行，最后重新生成
src = src.replace(/\nexport const CLOUD_RAW[\s\S]*$/, '\n');

// 2) 删除重复的具名函数声明：找到 function NAME( 后，用花括号配对找到函数结尾
function findFunctionEnd(s, start) {
  let depth = 0;
  let seen = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') { depth++; seen = true; continue; }
    if (ch === '}') { depth--; if (seen && depth === 0) return i + 1; continue; }
    // 跳过字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
    }
  }
  return -1;
}

const fnNames = ['jf', 'ts', 'H6', 'Q6', 'Z6', 'W6', 'tX', 'cL', 'cL_CLOUD', 'Uw', 'Y2', 'NX', 'En', 'K2', 'CX',
  'jX', 'K6', 'RX', 'Y6', 'X6', 'PX', 'l5', '_X', 'AX', 'OX', 't0', 'u5', 'Oh', 'BX', 'Cc', 'es', 'bX',
  'nc', 'IX', 'qX', 'HX', 'VX', 'e0', 'yc', 'gc'];
for (const name of fnNames) {
  const re = new RegExp(`function ${name.replace('$', '\\$')}\\(`, 'g');
  const starts = [];
  let m;
  while ((m = re.exec(src))) starts.push(m.index);
  if (starts.length < 2) continue;
  // 保留第一次出现（首个定义才是站点实际使用的版本），从后往前删
  for (let k = starts.length - 1; k >= 1; k--) {
    let s = starts[k];
    const e = findFunctionEnd(src, s);
    if (e < 0) throw new Error(`unbalanced function ${name} at ${s}`);
    // 若重复定义是 `a=1,b=2;function name(...)` 这类一行的中间成员，
    // 连同本行的前导声明一起删掉，否则外层出现同名变量遮蔽。
    const lineStart = src.lastIndexOf('\n', s) + 1;
    const prefix = src.slice(lineStart, s);
    if (/^\s*(?:[A-Za-z_$][\w$]*\s*=[^;{}]*;\s*)+$/.test(prefix) && prefix.trim()) s = lineStart;
    src = src.slice(0, s) + src.slice(e);
    console.log(`removed duplicate function ${name} (${e - starts[k]} bytes)`);
  }
}

// 3) 删除重复的 const 简单声明（同名 const 只保留第一处）
const constNames = ['qc', 'Aa', 'EX', 'MX', 'Jv', 'pX', 'yX', 'gX', 'vX', 'pm', 'zr', 'Sh', 'ec', 'Yv',
  'LX', 'LX_CLOUD', 'ao', 'Wv', 'qw', 'QY', 'ZY', 'JY', 'J6', 'tL', 'eL', 'nL', 'rL', 'aL', 'iL', 'oL', 'sL', 'lL', 'uL'];
for (const name of constNames) {
  const re = new RegExp(`const ${name.replace('$', '\\$')}=`, 'g');
  const starts = [];
  let m;
  while ((m = re.exec(src))) starts.push(m.index);
  if (starts.length < 2) continue;
  for (let k = starts.length - 1; k >= 1; k--) {
    const s = starts[k];
    let e = src.indexOf(';', s);
    if (name === 'Yv') e = src.indexOf(']]|]];') >= 0 ? e : e;
    src = src.slice(0, s) + src.slice(e + 1);
    console.log(`removed duplicate const ${name}`);
  }
}

// 4) 云状分类符号改名，避免与画布变量冲突
src = src.replace('const LX={code:"—"', 'const LX_CLOUD={code:"—"');
src = src.replace('return LX;', 'return LX_CLOUD;');
src = src.replace('function cL(t,e,n,r,o)', 'function cL_CLOUD(t,e,n,r,o)');

const names = ['jf', 'ts', 'H6', 'pm', 'Q6', 'Z6', 'W6', 'tX', 'cL_CLOUD', 'Uw', 'Y2', 'NX', 'En', 'K2', 'CX',
  'jX', 'K6', 'RX', 'Y6', 'X6', 'PX', 'l5', '_X', 'AX', 'OX', 't0', 'u5', 'Oh', 'BX', 'zr'];
for (const n of names) {
  if (!new RegExp(`(function|const) ${n.replace('$', '\\$')}[=(]`).test(src)) throw new Error(`missing symbol ${n}`);
}
src = src.trimEnd() + `\n\nexport const CLOUD_RAW = { ${names.join(', ')} };\n`;
fs.writeFileSync(p, src);
console.log('written', src.length, 'bytes');
