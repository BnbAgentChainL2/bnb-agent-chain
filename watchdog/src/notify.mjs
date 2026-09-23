// 告警外发。**可插拔**：只认一个 webhook URL（从环境变量读），不绑任何一家服务。
//
// 两条纪律：
//   ① **先刹车，后喊人。** `pause()` 是唯一能止损的动作，webhook 只是让人知道；
//      所以 trip.mjs 里的顺序永远是「发 pause → 写日志 → 发 webhook」，
//      webhook 超时、404、打不通，都不许影响刹车。
//   ② **绝不把私钥或完整配置塞进 payload。** 告警里只有规则、主体、结论和被比较的数。
//
// 两种 body 形状，靠 WATCHDOG_WEBHOOK_FORMAT 选：
//   json  —— 原样 POST 结构化告警对象（自建接收端、PagerDuty Events API 前置转换器等）
//   text  —— POST {"text": "..."}，Slack / 飞书 / 企业微信 / Discord(content) 的最小公分母

import { log } from './log.mjs';

/**
 * @param {object} cfgNotify cfg.notify
 * @param {object} alert { rule, subject, severity, summary, compared, action, txHash, at }
 * @param {typeof fetch} [fetchImpl] 测试注入
 */
export async function notify(cfgNotify, alert, fetchImpl = globalThis.fetch) {
  if (!cfgNotify?.url) {
    log.warn('未配置 WATCHDOG_WEBHOOK_URL，告警只进日志', { rule: alert.rule, subject: alert.subject });
    return { sent: false, reason: 'no_url' };
  }
  const body =
    cfgNotify.format === 'text' ? JSON.stringify({ text: toText(alert) }) : JSON.stringify(sanitize(alert));

  const retries = Number(cfgNotify.retries ?? 0);
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(cfgNotify.timeoutMs ?? 5000));
    try {
      const res = await fetchImpl(cfgNotify.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res && res.ok) {
        log.info('告警已发出', { rule: alert.rule, subject: alert.subject, attempt });
        return { sent: true, attempt };
      }
      lastErr = `HTTP ${res ? res.status : '无响应'}`;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e && e.message ? e.message : String(e);
    }
    log.warn('告警外发失败，准备重试', { rule: alert.rule, attempt, err: lastErr });
  }
  // 发不出去不是致命错误：非零退出码与 stderr 上的 alert 行才是运维真正依赖的信号。
  log.error('告警外发最终失败（不影响已经发出的 pause）', { rule: alert.rule, subject: alert.subject, err: lastErr });
  return { sent: false, reason: lastErr };
}

/** 一行人话，给 IM 用 */
export function toText(a) {
  const head = a.action === 'paused' ? '【已暂停】' : a.action === 'pause_failed' ? '【暂停失败】' : '【告警】';
  const tx = a.txHash ? ` tx=${a.txHash}` : '';
  return `${head} BNB Agent Chain watchdog · 规则 ${a.rule} · 主体 ${a.subject} · ${a.severity}\n${a.summary}${tx}`;
}

/** 只放该放的字段，顺序固定，方便接收端做 diff */
export function sanitize(a) {
  return {
    source: 'bac-watchdog',
    at: a.at ?? Math.floor(Date.now() / 1000),
    rule: a.rule,
    subject: a.subject,
    severity: a.severity,
    action: a.action ?? 'none',
    summary: a.summary,
    txHash: a.txHash ?? null,
    compared: a.compared ?? {},
  };
}
