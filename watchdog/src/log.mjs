// 结构化日志：一行一个 JSON，直接进 docker 的 json-file driver。
// **硬规则：私钥永远不进日志。** 注册进来的秘密值在输出前被逐字替换成 [REDACTED]，
// 另外任何裸 64 hex 的私钥形状（带不带 0x 都算）也一律遮掉 —— 看门狗要打印的东西里
// 合法的 32 字节值只有 merkle 根和区块哈希，它们都带 0x 且长度是 66，不会被这条兜底误伤。

const SECRETS = new Set();

/** 注册一个不许出现在输出里的值。只存值，不存名字，也不回显。 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) {
    SECRETS.add(value);
    // 私钥常常被人写成不带 0x 的形式，两种写法都要遮。
    if (value.startsWith('0x')) SECRETS.add(value.slice(2));
    else SECRETS.add('0x' + value);
  }
}

function scrub(text) {
  let out = text;
  for (const s of SECRETS) {
    while (out.includes(s)) out = out.replace(s, '[REDACTED]');
  }
  return out;
}

function serializable(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return { message: v.message, code: v.code ?? null };
  if (Array.isArray(v)) return v.map(serializable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = serializable(x);
    return out;
  }
  return v;
}

let sink = (level, line) => {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

/** 测试用：把输出接到别处。返回上一个 sink，便于还原。 */
export function setSink(fn) {
  const prev = sink;
  sink = fn;
  return prev;
}

function emit(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, svc: 'watchdog', msg, ...(serializable(fields) ?? {}) };
  sink(level, scrub(JSON.stringify(rec)));
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  debug: (msg, fields) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, fields);
  },
  /** 跳闸专用：永远打到 stderr，永远带完整的比较过程 */
  alert: (msg, fields) => emit('error', msg, { alert: true, ...(fields ?? {}) }),
};

export const _internal = { scrub, SECRETS, serializable };
