// 自己复算 BSC 与层内的对账差额（03 §3.1），不依赖 /api/health 的结论。
//
// 公式必须是这一个，否则它结构上永远不为 0：
//   diff = (bscTotalIssued − bscTotalExited)
//        − (layerCirculating + balance(FeeSink) + balance(FeeSplitter) + Σ balance(everValidator))
//   layerCirculating = 1e27 − balance(L2Bridge) − balance(FeeSink) − balance(FeeSplitter)
//                          − Σ balance(everValidator)
//
// 决策 #17：归集进 FeeSplitter（0x…0104）但还没被领走的 gas 费停在合约名下，
// 漏减它 diff 会从第一笔归集起恒为正。
//
// 出块者：QBFT 下是当届 validator 集合（02 §2 那句「任何硬编码唯一签名者的代码都要改」），
// 用 qbft_getValidatorsByBlockNumber 现读；读不到就按空集合算 —— 注意 signer 的余额在公式里
// 正负相消，所以读不到不影响 diff，只影响展示的分项。

import { Contract } from "ethers";
import { BRIDGE_ABI } from "./abi.js";
import { bscProvider, layerProvider, loadAddresses, LAYER_SYSTEM, LAYER_TOTAL_SUPPLY, requireAddress } from "./config.js";
import { withChainErrors } from "./errors.js";
import type { BacConfig } from "./types.js";

export interface ReconcileResult {
  bscIssued: bigint;
  bscExited: bigint;
  layerCirculating: bigint;
  diff: bigint;
  ok: boolean;
  /** 分项，供人逐项核（03 §3.1 要求 feeSink 与 signer 单独列出来） */
  bridgeBalance: bigint;
  feeSinkBalance: bigint;
  feeSplitterBalance: bigint;
  /** 逐个验证者的余额，分项列出才能逐项核（03 §3.1） */
  validatorBalances: { addr: string; balance: bigint }[];
  /** 全部验证者余额之和，= Σ validatorBalances[].balance */
  signerBalance: bigint;
  signers: string[];
}

async function readSigners(layer: any): Promise<string[]> {
  try {
    const list = await layer.send("qbft_getValidatorsByBlockNumber", ["latest"]);
    return Array.isArray(list) ? list.map((x: string) => x) : [];
  } catch {
    return [];
  }
}

export async function check(cfg?: BacConfig): Promise<ReconcileResult> {
  const addrs = await loadAddresses(cfg);
  const bsc = bscProvider(cfg);
  const layer = layerProvider(cfg);
  const bridge = new Contract(requireAddress(addrs, "bridge"), BRIDGE_ABI as unknown as string[], bsc);

  return withChainErrors("对账复算", async () => {
    const [issued, exited] = await Promise.all([
      bridge.totalCreditsIssued() as Promise<bigint>,
      bridge.totalCreditsExited() as Promise<bigint>,
    ]);
    const signers = await readSigners(layer);
    const [bridgeBal, sinkBal, splitterBal, ...signerBals] = await Promise.all([
      layer.getBalance(LAYER_SYSTEM.l2Bridge),
      layer.getBalance(LAYER_SYSTEM.feeSink),
      layer.getBalance(LAYER_SYSTEM.feeSplitter),
      ...signers.map((s) => layer.getBalance(s)),
    ]);
    const validatorBalances = signers.map((addr: string, i: number) => ({
      addr,
      balance: signerBals[i] ?? 0n,
    }));
    const signerBalance = signerBals.reduce((a: bigint, b: bigint) => a + b, 0n);
    const layerCirculating = LAYER_TOTAL_SUPPLY - bridgeBal - sinkBal - splitterBal - signerBalance;
    const diff = (issued - exited) - (layerCirculating + sinkBal + splitterBal + signerBalance);
    return {
      bscIssued: issued,
      bscExited: exited,
      layerCirculating,
      diff,
      ok: diff === 0n,
      bridgeBalance: bridgeBal,
      feeSinkBalance: sinkBal,
      feeSplitterBalance: splitterBal,
      validatorBalances,
      signerBalance,
      signers,
    };
  });
}
