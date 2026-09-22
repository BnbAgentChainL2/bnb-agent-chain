// bac-node init：生成节点密钥、拉创世、核对哈希、写配置与 compose.yml、打印你的 enode。
// 私钥写进 secrets/key（0600）之后**永远不再出现在任何输出里**；打印的 enode 是公开信息。

import fsReal from 'node:fs';
import path from 'node:path';
import { SigningKey, Wallet, getAddress } from 'ethers';
import { defaultConfig, layout, readConfig, validateConfig, writeConfig, CONFIG_FILENAME } from '../config.mjs';
import { renderCompose } from '../compose-template.mjs';
import { sha256Hex, whereToVerify } from '../genesis-gate.mjs';
import { Api } from '../api.mjs';
import { BESU_IMAGE, DEFAULT_P2P_PORT } from '../constants.mjs';
import { BacError } from '../util.mjs';

/** 由节点私钥导出 enode id：未压缩公钥去掉 0x04 前缀的 128 个十六进制字符 */
export function enodeIdFrom(privateKey) {
  const pub = SigningKey.computePublicKey(privateKey, false); // 0x04 + 128 hex
  return pub.slice(4);
}

export function enodeUri(privateKey, host, port) {
  return `enode://${enodeIdFrom(privateKey)}@${host}:${port}`;
}

export async function run(args, deps = {}) {
  const fs = deps.fs || fsReal;
  const log = deps.log;
  const home = args.home;
  const lay = layout(home);

  // 1) 目录
  for (const d of [lay.config, lay.secrets, lay.besuData, lay.state]) fs.mkdirSync(d, { recursive: true });
  try { fs.chmodSync(lay.secrets, 0o700); } catch { /* Windows 忽略 */ }

  // 2) 已有配置就在它上面改，不覆盖别人填过的东西
  let cfg;
  try { cfg = readConfig(home, { fsImpl: fs }); }
  catch { cfg = defaultConfig(); }

  cfg.schema = 'bac/node-cli-config/1';
  if (args.nodeId) cfg.nodeId = args.nodeId;
  if (args.payout) cfg.payout = getAddress(args.payout);
  if (args.p2pHost) cfg.p2pHost = args.p2pHost;
  if (args.p2pPort) cfg.p2pPort = Number(args.p2pPort);
  if (args.apiBase) cfg.apiBase = args.apiBase;
  if (args.bscRpc) cfg.bscRpc = args.bscRpc;
  if (args.layerRpc) cfg.layerRpc = args.layerRpc;
  if (!cfg.besuImage) cfg.besuImage = BESU_IMAGE;
  if (!cfg.p2pPort) cfg.p2pPort = DEFAULT_P2P_PORT;
  cfg.uid = Number(args.uid ?? deps.uid ?? (process.getuid ? process.getuid() : 1000));
  cfg.gid = Number(args.gid ?? deps.gid ?? (process.getgid ? process.getgid() : 1000));
  if (cfg.uid === 0 || cfg.gid === 0) {
    throw new BacError('不要用 root 跑：root 属主的 data 目录你以后既备份不了也删不掉。换个普通用户再来', 'root');
  }

  // 3) 节点密钥：有就不动（它同时是 enode 身份和迁移时必须带走的东西）
  let key;
  if (fs.existsSync(lay.nodeKey)) {
    key = fs.readFileSync(lay.nodeKey, 'utf8').trim();
    log.info('secrets/key 已存在，保持不动（这把 key 同时是 enode 身份，换了就换 enode）');
  } else {
    key = (deps.makeKey ? deps.makeKey() : Wallet.createRandom().privateKey);
    fs.writeFileSync(lay.nodeKey, key + '\n', { mode: 0o600 });
    try { fs.chmodSync(lay.nodeKey, 0o600); } catch { /* Windows 忽略 */ }
    log.ok(`已生成节点密钥：${lay.nodeKey}（0600）`);
    log.warn('立刻离线备份这个文件两份。丢了它 = 换 enode；在官方节点上丢了它 = 整条链停止出块');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new BacError('secrets/key 不是 32 字节私钥（不打印内容）。删掉它重新 init，或者放回正确的备份', 'bad_key');
  }

  // 4) 创世：从官方 API 拉，核对 X-Genesis-Hash，再落盘
  const api = deps.api || new Api(cfg.apiBase, { fetchImpl: deps.fetchImpl });
  let health = null;
  try { health = await api.health(); }
  catch (e) { log.warn(`${e.message}（可以离线放好 genesis.json 再跑一次）`); }

  let genesisText = null;
  try {
    const g = await api.genesis();
    genesisText = g.text;
    const headerHash = g.headerHash;
    const published = (health && health.layer && health.layer.genesisHash) || headerHash || '';
    if (headerHash && published && headerHash.toLowerCase() !== published.toLowerCase()) {
      throw new BacError(
        `/api/genesis 的 X-Genesis-Hash (${headerHash}) 与 /api/health 的 layer.genesisHash (${published}) 不一致：`
        + `官方自己两处都对不上，停下来问，不要继续`, 'genesis_mismatch');
    }
    if (args.genesisHash && published && args.genesisHash.toLowerCase() !== published.toLowerCase()) {
      throw new BacError(
        `你用 --genesis-hash 给的 ${args.genesisHash} 与服务器给的 ${published} 不一致：拒绝写入。\n${whereToVerify()}`,
        'genesis_mismatch');
    }
    cfg.genesisHash = args.genesisHash || published || cfg.genesisHash;
  } catch (e) {
    if (e.code === 'genesis_mismatch') throw e;
    log.warn(`拉不到 /api/genesis：${e.message}`);
    if (fs.existsSync(lay.genesis)) {
      genesisText = fs.readFileSync(lay.genesis, 'utf8');
      log.info('用本地已有的 config/genesis.json 继续');
    }
    if (args.genesisHash) cfg.genesisHash = args.genesisHash;
  }

  if (genesisText) {
    fs.writeFileSync(lay.genesis, genesisText);
    cfg.genesisSha256 = sha256Hex(genesisText);
    log.ok(`已写入 ${lay.genesis}`);
    log.info(`  sha256 ${cfg.genesisSha256}`);
  } else {
    log.warn('没有 genesis.json：start 会拒绝启动。手动放一份到 config/genesis.json 再跑一次 init');
  }

  // 5) bootnodes：官方 enode
  if (health && health.layer && health.layer.enode) {
    cfg.bootnodes = [health.layer.enode];
    log.ok(`官方 enode：${health.layer.enode}`);
  } else if (args.bootnode) {
    cfg.bootnodes = [args.bootnode];
  }

  // 6) 写配置 + compose
  const v = validateConfig(cfg);
  const cfgPath = writeConfig(home, cfg, { fsImpl: fs });
  fs.writeFileSync(lay.compose, renderCompose(cfg));

  // 7) validator.env 模板（只写变量名，值留空）
  if (!fs.existsSync(lay.env)) {
    fs.writeFileSync(lay.env,
      '# 见证人在 BSC 上的签名私钥。只写变量名进任何文档，值只留在这里。\n'
      + '# chmod 600，不要进 git，不要贴进聊天窗口。\n'
      + 'VALIDATOR_PRIVATE_KEY=\n', { mode: 0o600 });
    try { fs.chmodSync(lay.env, 0o600); } catch { /* Windows 忽略 */ }
    log.ok(`已生成 ${lay.env}（0600）：把你的 BSC 私钥填进 VALIDATOR_PRIVATE_KEY`);
  }

  // 8) 打印 enode（公开信息）
  const host = cfg.p2pHost || '<你的公网 IP>';
  const myEnode = enodeUri(key, host, cfg.p2pPort);
  cfg.enode = cfg.p2pHost ? myEnode : '';
  writeConfig(home, cfg, { fsImpl: fs });

  log.head('你的 enode（注册节点时要填的就是这一行）：');
  log.line('  ' + myEnode);
  if (!cfg.p2pHost) log.warn('没给 --p2p-host，上面的 IP 是占位符。填好再 register，否则别人连不上你');

  log.head('写好的文件：');
  log.info(`  ${path.join(home, CONFIG_FILENAME)}`);
  log.info(`  ${lay.compose}`);
  log.info(`  ${lay.genesis}${genesisText ? '' : '（缺）'}`);
  log.info(`  ${lay.nodeKey}（0600，绝不外传）`);

  for (const w of v.warnings) log.warn(w);
  for (const e of v.errors) log.fail(e);

  log.head('下一步：');
  log.info('  1. 把 VALIDATOR_PRIVATE_KEY 填进 validator.env');
  log.info('  2. bac-node start     （启动前会逐字核对创世哈希，不一致就不给启动）');
  log.info('  3. bac-node doctor    （一次把常见坑全查一遍）');
  return { ok: v.errors.length === 0, cfg, enode: myEnode };
}
