// src/warnings.js —— 进程内告警集合，原样进 /api/health 的 warnings[]。
// 纪律：限速、对账不平、锚点根对不上这类事**不许静默**（00 §4.2 / 03 §3.1）。
const warnings = new Map(); // code -> { code, detail, firstAt, lastAt, count }

export function warn(code, detail = "") {
  const now = Math.floor(Date.now() / 1000);
  const w = warnings.get(code);
  if (w) {
    w.detail = detail || w.detail;
    w.lastAt = now;
    w.count += 1;
  } else {
    warnings.set(code, { code, detail, firstAt: now, lastAt: now, count: 1 });
  }
}

export function clearWarning(code) {
  warnings.delete(code);
}

/** /api/health 的 warnings 是字符串数组（03 §3.1 的形状）。 */
export function listWarnings() {
  return [...warnings.keys()].sort();
}

export function warningDetails() {
  return [...warnings.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function resetWarnings() {
  warnings.clear();
}
