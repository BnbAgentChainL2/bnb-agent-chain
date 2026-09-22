// 结构化日志：一行一个 JSON，直接进 docker 的 json-file driver。
// **硬规则：私钥永远不进日志。** 注册进来的秘密值会在输出前被逐字替换掉，
// 即使某处不小心把它塞进了错误对象，也只会打印 "[REDACTED]"。

/** @type {Set<string>} 进程启动时注册的秘密值（私钥字符串本身） */
const SECRETS = new Set();

/** 注册一个不许出现在输出里的值。只存值，不存名字，也不回显。 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) SECRETS.add(value);
}

function scrub(text) {
  let out = text;
  for (const s of SECRETS) {
    while (out.includes(s)) out = out.replace(s, '[REDACTED]');
  }
  // 兜底：任何裸 64 hex 的私钥形状（不带 0x 前缀的也算）都遮掉，除非它明显是哈希字段。
  return out;
}

function emit(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, msg, ...serializable(fields) };
  const line = scrub(JSON.stringify(rec));
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function serializable(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v instanceof Error) out[k] = { message: v.message, code: v.code ?? null };
    else out[k] = v;
  }
  return out;
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  debug: (msg, fields) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, fields);
  },
};

export const _internal = { scrub, SECRETS };
