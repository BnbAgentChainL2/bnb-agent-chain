// 配置文件的读写与校验。配置文件是 <home>/bac-node.json，里面**没有任何私钥**。
// 私钥只从环境变量按名字读（VALIDATOR_PRIVATE_KEY），节点密钥只落在 secrets/key（0600）。

import fs from 'node:fs';
import path from 'node:path';
import { getAddress, isAddress as ethIsAddress } from 'ethers';
import {
  BESU_IMAGE, DEFAULT_API_BASE, DEFAULT_BSC_RPC, DEFAULT_BSC_RPC_2, DEFAULT_LAYER_RPC,
  DEFAULT_P2P_PORT, DEFAULT_RPC_PORT, LAYER_CHAIN_ID, L2_BRIDGE,
} from './constants.mjs';
import { BacError, isHash32 } from './util.mjs';

export const CONFIG_FILENAME = 'bac-node.json';
export const CONFIG_SCHEMA = 'bac/node-cli-config/1';

export function defaultConfig(overrides = {}) {
  return {
    schema: CONFIG_SCHEMA,
    nodeId: '',                     // 人类起的名字，nodeIdHash = keccak256(nodeId)
    home: '.',
    layerRpc: DEFAULT_LAYER_RPC,
    bscRpc: DEFAULT_BSC_RPC,
    bscRpc2: DEFAULT_BSC_RPC_2,
    apiBase: DEFAULT_API_BASE,
    chainId: LAYER_CHAIN_ID,
    besuImage: BESU_IMAGE,
    uid: 1000,
    gid: 1000,
    p2pHost: '',                    // 你的公网 IP，写进 enode 给别人连
    p2pPort: DEFAULT_P2P_PORT,
    rpcPort: DEFAULT_RPC_PORT,
    bootnodes: [],                  // 官方 enode，来自 /api/health 的 layer.enode
    genesisHash: '',                // 链上创世区块哈希（公布值），start 必须逐字核对
    genesisSha256: '',              // 本地 config/genesis.json 的 sha256，防止文件被换掉
    enode: '',                      // init 之后本节点自己的 enode（公开信息，不是密钥）
    payout: '',                     // BSC 上的收款地址
    memLimit: '3g',
    besuOpts: '-Xmx2g -Xms512m',
    addresses: {
      staking: '',                  // ValidatorStaking (BSC)
      anchor: '',                   // ChainAnchor (BSC)
      bacToken: '',                 // BAC ERC20 (BSC)
      bscBridge: '',                // BacBridge (BSC) —— 叶子哈希里有它，必须填对
      l2Bridge: L2_BRIDGE,          // 层内创世地址，固定
    },
    ...overrides,
  };
}

function bad(msg) { return { ok: false, msg }; }

/**
 * 校验配置。返回 {ok, errors[], warnings[]}。
 * 硬失败的项目一律拦住，不给「先跑起来再说」的机会 —— 跑错链比不跑贵得多。
 */
export function validateConfig(cfg, { forStart = false } = {}) {
  const errors = [];
  const warnings = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  const warn = (cond, msg) => { if (!cond) warnings.push(msg); };

  req(cfg && typeof cfg === 'object', '配置为空');
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors, warnings };

  req(cfg.schema === CONFIG_SCHEMA, `schema 必须是 ${CONFIG_SCHEMA}，读到的是 ${cfg.schema}`);
  req(Number(cfg.chainId) === LAYER_CHAIN_ID, `chainId 必须是 ${LAYER_CHAIN_ID}，读到的是 ${cfg.chainId}`);

  // 镜像必须钉死 tag：latest 会在某天悄悄换掉共识客户端
  req(typeof cfg.besuImage === 'string' && /:[0-9]+\.[0-9]+\.[0-9]+$/.test(cfg.besuImage),
    `besuImage 必须钉死版本号（当前 ${cfg.besuImage}）。不许用 latest：02 §0 要求 tag 固定为 ${BESU_IMAGE}`);
  warn(cfg.besuImage === BESU_IMAGE,
    `besuImage 不是实测过的 ${BESU_IMAGE}，换版本前先在一次性容器里用同一份 genesis.json 验一遍`);

  // uid/gid：root 属主的 data 目录是我们在探针里踩过的真实故障
  req(Number.isInteger(cfg.uid) && cfg.uid > 0,
    'uid 必须是大于 0 的整数（用 `id -u`）。用 root 跑会造出 root 属主的 data 目录，宿主上既不能备份也不能删');
  req(Number.isInteger(cfg.gid) && cfg.gid > 0, 'gid 必须是大于 0 的整数（用 `id -g`）');

  req(typeof cfg.layerRpc === 'string' && /^https?:\/\//.test(cfg.layerRpc), 'layerRpc 必须是 http(s) 地址');
  req(typeof cfg.bscRpc === 'string' && /^https?:\/\//.test(cfg.bscRpc), 'bscRpc 必须是 http(s) 地址');
  warn(typeof cfg.bscRpc2 === 'string' && /^https?:\/\//.test(cfg.bscRpc2),
    'bscRpc2 没配：两个独立 BSC RPC 给出一致结果才算数（03 §1.2）');
  req(Number.isInteger(cfg.p2pPort) && cfg.p2pPort > 0 && cfg.p2pPort < 65536, 'p2pPort 不是合法端口');
  req(Number.isInteger(cfg.rpcPort) && cfg.rpcPort > 0 && cfg.rpcPort < 65536, 'rpcPort 不是合法端口');

  // 地址们
  const a = cfg.addresses || {};
  for (const [k, label] of [['staking', 'ValidatorStaking'], ['anchor', 'ChainAnchor'],
                            ['bacToken', 'BAC 代币'], ['bscBridge', 'BacBridge']]) {
    if (!a[k]) { warnings.push(`addresses.${k}（${label}）还没填，发射后从 /api/health 或网站抄进来`); continue; }
    if (!ethIsAddress(a[k])) errors.push(`addresses.${k} 不是合法地址：${a[k]}`);
    else if (getAddress(a[k]) !== a[k]) warnings.push(`addresses.${k} 不是 EIP-55 校验和格式，建议写成 ${getAddress(a[k])}`);
  }
  if (a.l2Bridge && ethIsAddress(a.l2Bridge)) {
    req(a.l2Bridge.toLowerCase() === L2_BRIDGE.toLowerCase(),
      `addresses.l2Bridge 必须是创世固定地址 ${L2_BRIDGE}`);
  }

  if (cfg.payout) {
    if (!ethIsAddress(cfg.payout)) errors.push(`payout 不是合法地址：${cfg.payout}`);
  } else warnings.push('payout（BSC 收款地址）还没填，register 之前必须填');

  if (cfg.nodeId) {
    req(/^[A-Za-z0-9._-]{1,64}$/.test(cfg.nodeId), 'nodeId 只能是字母数字和 . _ -，最长 64');
  } else warnings.push('nodeId 还没起名字');

  // 创世：start 时是硬门槛
  if (cfg.genesisHash) {
    req(isHash32(cfg.genesisHash), `genesisHash 不是 32 字节哈希：${cfg.genesisHash}`);
  } else if (forStart) {
    errors.push('没有记录 genesisHash：拒绝启动。先跑 `bac-node init` 把公布的创世哈希抄进来');
  } else warnings.push('genesisHash 还没记录，start 会拒绝启动');

  if (forStart) {
    req(Array.isArray(cfg.bootnodes) && cfg.bootnodes.length > 0,
      'bootnodes 为空：没有官方 enode 就连不上这条链，先跑 `bac-node init`');
  }
  for (const e of cfg.bootnodes || []) {
    req(/^enode:\/\/[0-9a-fA-F]{128}@[^:]+:\d+$/.test(e), `bootnode 格式不对：${e}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function configPath(home) { return path.join(home, CONFIG_FILENAME); }

export function readConfig(home, { fsImpl = fs } = {}) {
  const p = configPath(home);
  let raw;
  try { raw = fsImpl.readFileSync(p, 'utf8'); }
  catch { throw new BacError(`读不到配置 ${p}，先跑 \`bac-node init\``, 'no_config'); }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new BacError(`配置 ${p} 不是合法 JSON：${e.message}`, 'bad_config'); }
  cfg.home = home;
  return cfg;
}

export function writeConfig(home, cfg, { fsImpl = fs } = {}) {
  const p = configPath(home);
  const out = { ...cfg };
  delete out.home;                     // home 由命令行给，不落盘，换目录时不会自相矛盾
  fsImpl.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', { mode: 0o644 });
  return p;
}

export function layout(home) {
  return {
    home,
    config: path.join(home, 'config'),
    genesis: path.join(home, 'config', 'genesis.json'),
    secrets: path.join(home, 'secrets'),
    nodeKey: path.join(home, 'secrets', 'key'),
    data: path.join(home, 'data'),
    besuData: path.join(home, 'data', 'besu'),
    state: path.join(home, 'state'),
    compose: path.join(home, 'compose.yml'),
    env: path.join(home, 'validator.env'),
  };
}
