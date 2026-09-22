// docker compose 的驱动。exec 可注入 —— 测试里不需要装 docker。

import { spawn } from 'node:child_process';
import { BacError } from './util.mjs';

/** 默认执行器：返回 {code, stdout, stderr} */
export function realExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, shell: false });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; if (opts.stream) process.stdout.write(d); });
    p.stderr.on('data', (d) => { stderr += d; if (opts.stream) process.stderr.write(d); });
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e.message) }));
    p.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export class Docker {
  constructor({ exec = realExec, cwd = '.' } = {}) { this.exec = exec; this.cwd = cwd; }

  compose(args, opts = {}) {
    return this.exec('docker', ['compose', ...args], { cwd: this.cwd, ...opts });
  }

  /** docker 在不在、compose 插件在不在 */
  async available() {
    const v = await this.exec('docker', ['compose', 'version'], { cwd: this.cwd });
    return { ok: v.code === 0, detail: (v.stdout || v.stderr || '').trim().split('\n')[0] || '' };
  }

  async up(services = []) {
    const r = await this.compose(['up', '-d', ...services], { stream: true });
    if (r.code !== 0) throw new BacError(`docker compose up 失败（退出码 ${r.code}）：${r.stderr.trim()}`, 'docker');
    return r;
  }

  async stop(services = []) {
    const r = await this.compose(['stop', ...services], { stream: true });
    if (r.code !== 0) throw new BacError(`docker compose stop 失败（退出码 ${r.code}）：${r.stderr.trim()}`, 'docker');
    return r;
  }

  async down() { return this.compose(['down'], { stream: true }); }

  /** 返回 [{Service, State, Health}]，compose 版本老的时候降级成空数组 */
  async ps() {
    const r = await this.compose(['ps', '--format', 'json']);
    if (r.code !== 0) return [];
    const out = [];
    for (const line of r.stdout.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const v = JSON.parse(s);
        if (Array.isArray(v)) out.push(...v); else out.push(v);
      } catch { /* 老版本 compose 输出不是 json，忽略 */ }
    }
    return out;
  }

  logs(service, follow = false) {
    return this.compose(['logs', ...(follow ? ['-f'] : ['--tail', '100']), service], { stream: true });
  }
}
