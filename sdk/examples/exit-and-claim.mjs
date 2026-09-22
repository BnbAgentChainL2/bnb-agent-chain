// 退出：烧积分 → 等锚点定案 → 在 BSC 上领 → 慢速 collect。
//
// 时间线（照抄 03 §5.5 第 3 条）：
//   烧积分 → 纪元结束 → 中继在承诺窗口（2 小时）之后发锚点 → 24 小时挑战窗口 → FINAL →
//   任何时候都可以 claimExit（**没有领取窗口**）→ settleEpoch → collect。
//   正常约 2 天拿到第一笔。单地址每纪元最多拿该纪元释放额的 10%，领不完的留在 unclaimed 里永不过期。
//   **退出按桥池份额兑付，不承诺任何金额，可能远低于投入价值。**
//
// 跑法：BAC_BSC_KEY=0x... BAC_LAYER_KEY=0x... node examples/exit-and-claim.mjs

import { BacAgent, ExitStore, loadAddresses, api, bscProvider, layerProvider } from "@bac/agent-sdk";
import { Wallet } from "ethers";

const addresses = await loadAddresses();
const bsc = bscProvider();
const layer = layerProvider();
const controller = new Wallet(process.env.BAC_BSC_KEY);
const layerWallet = new Wallet(process.env.BAC_LAYER_KEY);

// agentId 自己记着，或者用 registry.agentIdOfController(controller.address) 查。

const agent = new BacAgent({
  agentId: BigInt(process.env.BAC_AGENT_ID),
  controllerKey: process.env.BAC_BSC_KEY,
  layerKey: process.env.BAC_LAYER_KEY,
  walletAddress: layerWallet.address,
  card: { name: "退出示例", model: "claude-opus-5", endpoint: "https://example.com/agent-card.json" },
  addresses,
  apiBase: "https://95-179-183-132.sslip.io",
  bsc,
  layer,
  store: new ExitStore("./.bac-agent-state.json"),
});

// 0) 每次启动都先重放「退出后未领取」—— 这是 SDK 唯一不允许丢的持久化状态
for (const r of await agent.replayPendingExits()) {
  console.log("重放", r.exitId.toString(), r.result, r.tx ?? r.why ?? "");
}

// 1) 退出前先读兑付率。credits × weiPerCredit == 0 时 SDK 默认拒发：
//    积分会在 exit() 那一刻销毁，而 claimExit 在兑付率过低时会 revert。
const amount = 100n * 10n ** 18n;
const rate = await api.rate();
console.log("估算能换", (amount * rate.weiPerCredit) / 10n ** 18n, "wei（估算，不承诺任何金额）");

const { exitId, bornEpoch, layerTx } = await agent.exit(amount, controller.address);
console.log("已烧积分", { exitId, bornEpoch, layerTx });

// 2) 等锚点。没有领取期限，可以关机明天再来 —— 记录已经落盘了。
for (;;) {
  const st = await agent.exitStatus(exitId);
  console.log(st.anchorState, st.nextStep);
  if (st.claimable) break;
  await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
}

// 3) 领：证明由 SDK 从 /api/epoch/{n}/proof/{exitId} 取，用返回的 anchorEpoch 上链
console.log("claimExit", await agent.claimExit(exitId));

// 4) 慢速领钱：每地址每纪元一次，单次上限是当期释放额的 10%
const { paid, left } = await agent.collect(controller.address);
console.log("这次领到", paid, "还欠", left);
