// src/text.js —— 不可信文本（agent / 身份持有人自己写的）的字符清洗与链接分类，economy 的 X4 与 ERC-8004 身份共用。
//
// 只做两件事，不做 HTML 转义（那是渲染层的事）：
//   1. 去掉能让文字「看起来和实际不一样」的字符：C0 / DEL / C1 控制字符、双向文字控制符（RLO 之类，
//      能把 "gpj.exe" 显示成 "exe.jpg"）、零宽空格 / 词连接符 / BOM；
//   2. 链接只认 https: / ipfs: / ar: 三种 scheme —— javascript:、data:、http:、裸字符串一律不当链接。
// ZWJ / ZWNJ（U+200C / U+200D）不去：波斯文、印地文和 emoji 序列要用它们，它们也不会改变文字方向。

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const LINE_CONTROL_RE = /[\t\n\v\f\r\u0085]/g;
/** 双向文字控制符：ALM、LRM、RLM、LRE / RLE / PDF / LRO / RLO、LRI / RLI / FSI / PDI。 */
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** 不可见的格式字符：零宽空格、词连接符、BOM。 */
const INVISIBLE_RE = /[\u200b\u2060\ufeff]/g;

/**
 * 去掉控制字符、双向控制符与不可见格式字符。
 * lineBreaksTo：制表 / 换行这类「空白型」控制字符换成什么（默认直接删掉，与 X4 的旧行为一致；
 * 长文本传 " "，免得两行字粘成一个词）。
 */
export function stripUnsafeChars(s, { lineBreaksTo = "" } = {}) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(LINE_CONTROL_RE, lineBreaksTo)
    .replace(CONTROL_RE, "")
    .replace(BIDI_RE, "")
    .replace(INVISIBLE_RE, "");
}

/** 按码点截断（不会把一个 emoji 劈成两半的代理对）。 */
export function capCodePoints(s, n) {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n).join("") : s;
}

/**
 * 自述文本字段：只收字符串 / 数字 / 布尔（对象、数组一律 null，不 String() 出 "[object Object]"），
 * 清洗、裁两端空白、按码点截断；清完是空串就是 null。
 */
export function cleanText(v, max, { lineBreaksTo = " " } = {}) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null;
  // 先粗截一刀再跑正则：自述字段可能有几 MB（data: URI 里什么都能塞）
  const raw = String(v).slice(0, max * 4 + 64);
  const s = stripUnsafeChars(raw, { lineBreaksTo }).trim();
  if (!s) return null;
  return capCodePoints(s, max);
}

/**
 * 链接 / 地址类字段（image、endpoint、tokenURI）：制表 / 换行直接删掉而不是换成空格 ——
 * 浏览器解析 URL 时也是删掉它们（"java\tscript:" 就是 "javascript:"），清洗后的样子要和浏览器看到的一致。
 */
export function cleanLink(v, max) {
  return cleanText(v, max, { lineBreaksTo: "" });
}

/** 当作链接给出去的 scheme 白名单（小写，含冒号）。 */
export const LINK_SCHEMES = ["https:", "ipfs:", "ar:"];

/** 字符串开头的 URI scheme（小写，含冒号）；没有 scheme 返回 null。先清洗再判，"java\tscript:" 也认得出。 */
export function schemeOf(v) {
  if (typeof v !== "string") return null;
  const s = stripUnsafeChars(v).trim();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  return m ? m[1].toLowerCase() + ":" : null;
}

/** 能不能当链接渲染：只有 https: / ipfs: / ar:。 */
export function isLinkable(v) {
  return LINK_SCHEMES.includes(schemeOf(v));
}

/** 会被浏览器执行或内嵌的 scheme：这种值连纯文本都不留。 */
export const DANGEROUS_SCHEMES = ["javascript:", "vbscript:", "data:", "file:", "blob:"];

export function isDangerous(v) {
  return DANGEROUS_SCHEMES.includes(schemeOf(v));
}
