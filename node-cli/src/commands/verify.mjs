// bac-node verify --epoch N：**任何人**都能跑的独立核验（不需要质押、不发交易）。
// 只用本地全节点 + 一次 BSC eth_call，打印 MATCH / MISMATCH（03 §6 逐字要求的那个输出）。

import fsReal from 'node:fs';
import { readConfig } from '../config.mjs';
import { Rpc } from '../rpc.mjs';
import { computeEpoch } from '../attest-compute.mjs';
import { getAnchor } from '../chain.mjs';
import { BacError } from '../util.mjs';

export async function run(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const log = deps.log;
  const cfg = readConfig(args.home, { fsImpl: fs });
  const layer = deps.layerRpc || new Rpc(cfg.layerRpc, { fetchImpl: deps.fetchImpl, label: '本地层内节点' });
  const bsc = deps.bscRpc || new Rpc(cfg.bscRpc, { fetchImpl: deps.fetchImpl, label: 'BSC' });
  const epoch = Number(args.epoch);
  if (!Number.isInteger(epoch)) throw new BacError('--epoch 必须给一个纪元号', 'bad_arg');
  if (!cfg.addresses.anchor) throw new BacError('addresses.anchor（ChainAnchor）没配，没法比对', 'bad_config');

  const local = await computeEpoch(layer, epoch, {
    bscBridge: cfg.addresses.bscBridge, l2Bridge: cfg.addresses.l2Bridge,
  });
  const onchain = await getAnchor(bsc, cfg.addresses.anchor, epoch);

  log.line(`epoch ${epoch}`);
  log.line(`  local   exitRoot ${local.exitRoot}  l2Block ${local.l2Block}  l2BlockHash ${local.l2BlockHash}`);
  log.line(`  onchain exitRoot ${onchain.exitRoot}  l2Block ${onchain.l2Block}  l2BlockHash ${onchain.l2BlockHash}`);
  log.line(`  state   ${onchain.state}   exitCount 链上 ${onchain.exitCount} / 本地 ${local.leaves.length}`);

  if (onchain.state === 'NONE') {
    log.line('  NO ANCHOR（这个纪元的锚点还没发，没有可比对的对象）');
    return { ok: false, match: null, exitCode: 2 };
  }

  const match = local.exitRoot.toLowerCase() === String(onchain.exitRoot).toLowerCase()
    && Number(local.l2Block) === Number(onchain.l2Block)
    && local.l2BlockHash.toLowerCase() === String(onchain.l2BlockHash).toLowerCase();

  log.line(match ? '  MATCH' : '  MISMATCH');
  if (!match) {
    log.line('  三元组 (exitRoot, l2BlockHash, l2Block) 只要有一项不同就算异议。');
    log.line('  QBFT 下层内不会重组，所以不一致不是「等一等就好了」，是真分歧 —— 该报就报。');
  }
  if (args.json) {
    log.line(JSON.stringify({
      epoch, match,
      local: { exitRoot: local.exitRoot, l2Block: local.l2Block, l2BlockHash: local.l2BlockHash,
               exitCount: local.leaves.length, from: local.from, to: local.to },
      onchain: { exitRoot: onchain.exitRoot, l2Block: onchain.l2Block, l2BlockHash: onchain.l2BlockHash,
                 exitCount: onchain.exitCount, state: onchain.state },
    }, null, 2));
  }
  return { ok: match, match, exitCode: match ? 0 : 1 };
}
