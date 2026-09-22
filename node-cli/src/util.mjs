// 通用小工具：输出、错误、格式化。这里不许出现任何私钥相关的打印。

export class BacError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; }
}

/** 宁可停，不可错：在无法确定的地方抛这个，调用方一律停下来告警，不许猜 */
export class NotDeterminedError extends BacError {
  constructor(message) { super(message, 'not_determined'); }
}

export function isHex(s, bytes) {
  if (typeof s !== 'string') return false;
  const re = bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/;
  return re.test(s);
}

export function isAddress(s) { return isHex(s, 20); }
export function isHash32(s) { return isHex(s, 32); }

export function toHexQuantity(n) { return '0x' + BigInt(n).toString(16); }
export function fromHexQuantity(h) { return BigInt(h); }

/** wei -> 带千分位的十进制展示，只用于打印，不用于任何计算 */
export function fmtUnits(wei, decimals = 18, frac = 4) {
  const v = BigInt(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const rem = abs % base;
  let f = rem.toString().padStart(decimals, '0').slice(0, frac).replace(/0+$/, '');
  const ints = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${ints}${f ? '.' + f : ''}`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

/** 秒级时间戳 -> 北京时间（UTC+8）字符串。03 §0：网站与 CLI 一律显示北京时间 */
export function fmtBeijing(ts) {
  const d = new Date((Number(ts) + 8 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} (北京时间)`;
}

export function epochOf(ts) { return Math.floor(Number(ts) / 86400); }
export function epochEndOf(epoch) { return (Number(epoch) + 1) * 86400; }

export function nowSec() { return Math.floor(Date.now() / 1000); }

/** 打印器：可注入，测试里换成收集数组 */
export function makeLogger(sink = console) {
  return {
    line: (s = '') => sink.log(s),
    ok: (s) => sink.log(`  [ok]   ${s}`),
    warn: (s) => sink.log(`  [warn] ${s}`),
    fail: (s) => sink.log(`  [FAIL] ${s}`),
    info: (s) => sink.log(`  ${s}`),
    head: (s) => { sink.log(''); sink.log(s); },
  };
}

/** 把任何值里看起来像私钥的东西挡住（防止误打印）。只用于日志层。 */
export function redact(s) {
  return String(s).replace(/0x[0-9a-fA-F]{64}\b/g, '0x<已隐藏>');
}
