// 「退出后未领取」是 SDK **唯一不允许丢**的持久化状态（03 §5.5 第 4 条）。
//
// 层内积分在 exit() 那一刻就销毁了，这份记录是它在 BSC 上的唯一凭据。
// 落盘用最笨的办法：一个 JSON 文件，先写临时文件再 rename（同目录内的原子替换）。
// 不引入数据库，不引入依赖。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PendingExit {
  exitId: string;      // 十进制字符串，避免 JSON 丢 bigint 精度
  to: string;
  credits: string;
  bornEpoch: number;
  layerTx: string;
  createdAt: number;
  claimedTx?: string | null;
}

interface StateFile {
  schema: "bac/sdk-state/1";
  pendingExits: PendingExit[];
}

/** 每次都新造一个：共享同一个数组会让所有空 store 互相污染。 */
function emptyState(): StateFile {
  return { schema: "bac/sdk-state/1", pendingExits: [] };
}

export const DEFAULT_STATE_PATH = "./.bac-agent-state.json";

export class ExitStore {
  readonly path: string;

  constructor(path: string = DEFAULT_STATE_PATH) {
    this.path = resolve(path);
  }

  private read(): StateFile {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as StateFile;
      if (!parsed || !Array.isArray(parsed.pendingExits)) return emptyState();
      return parsed;
    } catch {
      return emptyState();
    }
  }

  private write(st: StateFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  /** 记一笔刚烧掉的积分。同 exitId 覆盖写，幂等。 */
  put(e: PendingExit): void {
    const st = this.read();
    const i = st.pendingExits.findIndex((x) => x.exitId === e.exitId);
    if (i >= 0) st.pendingExits[i] = { ...st.pendingExits[i], ...e };
    else st.pendingExits.push(e);
    this.write(st);
  }

  /** 标记已在 BSC 上领取（claimExit 成功）。记录不删除：它同时是历史凭据。 */
  markClaimed(exitId: bigint, tx: string): void {
    const st = this.read();
    const i = st.pendingExits.findIndex((x) => x.exitId === exitId.toString());
    if (i >= 0) {
      st.pendingExits[i].claimedTx = tx;
      this.write(st);
    }
  }

  list(): PendingExit[] {
    return this.read().pendingExits;
  }

  /** 还没在 BSC 上领的那些，启动时要逐条重放。 */
  unclaimed(): PendingExit[] {
    return this.read().pendingExits.filter((x) => !x.claimedTx);
  }

  get(exitId: bigint): PendingExit | undefined {
    return this.read().pendingExits.find((x) => x.exitId === exitId.toString());
  }
}
