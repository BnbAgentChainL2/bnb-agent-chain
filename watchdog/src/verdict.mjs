// 一条规则的输出形状。**每一条裁决都必须带上它比较过的每一个数**（`compared`），
// 否则运维在凌晨三点看到的就只是「不匹配」三个字，既不能判断是不是误报，也不能复算。
//
// 规则本身全部是**纯函数**：输入是已经读好的普通数据，输出是下面这个对象。
// 网络调用一律在 src/chains.mjs 里，于是每一条规则都能用离线的 fixture 测到底。

import { SEVERITY } from './constants.mjs';

/**
 * @param {string} rule    RULE.* 之一
 * @param {string} subject 开单的主体：纪元号 / 交易哈希 / 'global'
 * @param {string} severity SEVERITY.*
 * @param {string} summary 一句中文人话，进日志也进 webhook
 * @param {object} compared 逐项对照：`{ 名字: { mine, onchain } }` 或任何能说明问题的数
 */
export function verdict(rule, subject, severity, summary, compared = {}) {
  return { rule, subject: String(subject), severity, summary, compared: plain(compared) };
}

export const ok = (rule, subject, summary, compared) => verdict(rule, subject, SEVERITY.OK, summary, compared);
export const skip = (rule, subject, summary, compared) => verdict(rule, subject, SEVERITY.SKIP, summary, compared);
export const warn = (rule, subject, summary, compared) => verdict(rule, subject, SEVERITY.WARN, summary, compared);
export const critical = (rule, subject, summary, compared) =>
  verdict(rule, subject, SEVERITY.CRITICAL, summary, compared);

export function isTripworthy(v) {
  return v.severity === SEVERITY.CRITICAL;
}

/** bigint → 十进制字符串，让裁决可以原样 JSON.stringify 进 SQLite 和 webhook */
export function plain(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = plain(x);
    return out;
  }
  return v;
}
