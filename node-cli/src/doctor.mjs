// doctor：把我们（和探针）真实踩过的坑逐条查一遍。
// 每一项都是纯计算：runChecks(ctx) -> [{id, title, status, detail, fix}]，ctx 里的东西全部可注入，
// 所以测试可以伪造「时钟偏了 40 秒」「peers 是 0」「datadir 是 root 的」这些条件，不需要真环境。

import {
  CLOCK_SKEW_FAIL_SEC, CLOCK_SKEW_WARN_SEC, DISK_FREE_FAIL_BYTES, DISK_FREE_WARN_BYTES,
  GENESIS_SOURCES, LAYER_CHAIN_ID, MIN_STAKE,
} from './constants.mjs';
import { fmtDuration, fmtUnits } from './util.mjs';

const OK = 'ok', WARN = 'warn', FAIL = 'fail';

/**
 * @typedef {Object} DoctorCtx
 * @property {object} cfg                配置
 * @property {number} now                本机当前秒
 * @property {{ok:boolean, detail:string}|null} docker      docker compose 是否可用
 * @property {Array<{Service:string,State:string}>} psList  compose ps 的结果
 * @property {{chainId:number|null, head:number|null, headTs:number|null, genesisHash:string|null,
 *             peers:number|null, error:string|null}} layer  本地层内节点的观测
 * @property {{ok:boolean, error:string|null}} bsc          BSC RPC 的观测
 * @property {{ok:boolean, error:string|null}} bsc2
 * @property {{head:number|null, error:string|null}} official  官方 /api/health 的层内高度
 * @property {{exists:boolean, uid:number|null, mode:number|null}} datadir
 * @property {{exists:boolean, mode:number|null}} nodeKey
 * @property {{freeBytes:number|null, error:string|null}} disk
 * @property {number} processUid
 * @property {{staked:bigint|null, nodes:number|null, registered:boolean|null, active:boolean|null,
 *             strikes:number|null, error:string|null}} staking
 * @property {{errors:string[], warnings:string[]}} configCheck
 */

export function runChecks(ctx) {
  const out = [];
  const add = (id, title, status, detail, fix = '') => out.push({ id, title, status, detail, fix });
  const genesisWhere = '出处（三处必须是同一个值）：' + GENESIS_SOURCES.join(' / ');

  // 0) 配置本身
  if (ctx.configCheck) {
    if (ctx.configCheck.errors.length) {
      add('config', '配置校验', FAIL, ctx.configCheck.errors.join('；'), '改 bac-node.json 或重跑 bac-node init');
    } else if (ctx.configCheck.warnings.length) {
      add('config', '配置校验', WARN, ctx.configCheck.warnings.join('；'), '');
    } else {
      add('config', '配置校验', OK, '没有问题');
    }
  }

  // 1) docker 在不在
  if (ctx.docker) {
    if (ctx.docker.ok) add('docker', 'docker compose 可用', OK, ctx.docker.detail);
    else add('docker', 'docker compose 可用', FAIL, ctx.docker.detail || '调不起 docker compose',
      '装 Docker Engine + compose 插件；docker compose version 能打印版本才算好');
  }

  // 2) 容器在不在跑
  if (ctx.psList) {
    const besu = ctx.psList.find((s) => (s.Service || s.service) === 'besu');
    const state = besu && (besu.State || besu.state || '');
    if (!besu) add('containers', 'besu 容器', FAIL, 'compose 里没有在跑的 besu 服务', '跑 bac-node start');
    else if (/running|up/i.test(state)) add('containers', 'besu 容器', OK, `状态 ${state}`);
    else add('containers', 'besu 容器', FAIL, `状态 ${state}`, '用 docker compose logs besu 看它为什么起不来');
  }

  // 3) 层内 RPC 通不通
  if (ctx.layer && ctx.layer.error) {
    add('rpc_layer', '本地层内 RPC', FAIL, ctx.layer.error,
      '容器起了吗？RPC 只绑本机（127.0.0.1:8545），确认 layerRpc 配的是同一个地址');
  } else if (ctx.layer) {
    add('rpc_layer', '本地层内 RPC', OK, `head #${ctx.layer.head}`);

    // 4) chainId
    if (ctx.layer.chainId !== LAYER_CHAIN_ID) {
      add('chain_id', '链 ID', FAIL, `读到 ${ctx.layer.chainId}，应该是 ${LAYER_CHAIN_ID}`,
        '你连的不是这条链。检查 genesis.json 与 bootnodes');
    } else add('chain_id', '链 ID', OK, String(LAYER_CHAIN_ID));

    // 5) 创世哈希 —— 最重要的一条
    if (!ctx.cfg.genesisHash) {
      add('genesis', '创世哈希', FAIL, '配置里没有记录公布的创世哈希', `跑 bac-node init 抄一份。${genesisWhere}`);
    } else if (!ctx.layer.genesisHash) {
      add('genesis', '创世哈希', WARN, '读不到本地节点的创世区块', '等节点起来再查');
    } else if (ctx.layer.genesisHash.toLowerCase() !== ctx.cfg.genesisHash.toLowerCase()) {
      add('genesis', '创世哈希', FAIL,
        `本地 ${ctx.layer.genesisHash} != 公布的 ${ctx.cfg.genesisHash}`,
        `你在另一条链上。停掉节点、重新取 genesis.json 并逐字核对。${genesisWhere}`);
    } else add('genesis', '创世哈希', OK, ctx.cfg.genesisHash);

    // 6) peers
    if (ctx.layer.peers === null || ctx.layer.peers === undefined) {
      add('peers', '对端数', WARN, '读不到 net_peerCount');
    } else if (ctx.layer.peers === 0) {
      add('peers', '对端数', FAIL, '0 个对端：你在自说自话，高度不会涨',
        'bootnodes 填对了吗（/api/health 的 layer.enode）？30303 的 tcp 和 udp 都要能出去；'
        + 'nat-method=NONE 时 p2pHost 要是你的公网 IP');
    } else if (ctx.layer.peers < 2) {
      add('peers', '对端数', WARN, `只有 ${ctx.layer.peers} 个对端`, '官方节点挂了就没人给你数据，多连几个见证人');
    } else add('peers', '对端数', OK, String(ctx.layer.peers));

    // 7) 同步进度
    if (ctx.official && ctx.official.head !== null && ctx.official.head !== undefined
        && ctx.layer.head !== null && ctx.layer.head !== undefined) {
      const lag = ctx.official.head - ctx.layer.head;
      if (lag > 1200) {
        add('sync', '同步进度', FAIL, `落后官方 ${lag} 个块（约 ${fmtDuration(lag * 3)}）`,
          '还在追块就先别承诺；一直追不上先看 peers 和磁盘');
      } else if (lag > 100) add('sync', '同步进度', WARN, `落后官方 ${lag} 个块`);
      else add('sync', '同步进度', OK, `落后 ${Math.max(0, lag)} 个块`);
    } else if (ctx.official && ctx.official.error) {
      add('sync', '同步进度', WARN, `读不到官方高度：${ctx.official.error}`, '只是没法比对，不影响你自己出结论');
    }

    // 8) 时钟偏移 —— 承诺截止时间是按**你本机的钟**算的
    if (ctx.layer.headTs !== null && ctx.layer.headTs !== undefined) {
      const skew = ctx.now - ctx.layer.headTs;
      if (Math.abs(skew) >= CLOCK_SKEW_FAIL_SEC) {
        add('clock', '时钟偏移', FAIL,
          `本机时间与链上头部差 ${skew} 秒（头部时间戳 ${ctx.layer.headTs}）`,
          '开 NTP（timedatectl set-ntp true）。钟不准会让你在承诺窗口边缘发出必然 revert 的交易');
      } else if (Math.abs(skew) >= CLOCK_SKEW_WARN_SEC) {
        add('clock', '时钟偏移', WARN, `本机时间与链上头部差 ${skew} 秒`, '建议开 NTP');
      } else add('clock', '时钟偏移', OK, `${skew} 秒`);
    }
  }

  // 9) BSC RPC
  if (ctx.bsc) {
    if (!ctx.bsc.ok) add('rpc_bsc', 'BSC RPC', FAIL, ctx.bsc.error || '连不上',
      '承诺、揭示、领奖全在 BSC 上发，连不上就什么都做不了');
    else add('rpc_bsc', 'BSC RPC', OK, '可达');
  }
  if (ctx.bsc2) {
    if (!ctx.bsc2.ok) add('rpc_bsc2', '第二个 BSC RPC', WARN, ctx.bsc2.error || '连不上',
      '第二个 RPC 用来互相印证（03 §1.2），只有一个就没有印证');
    else add('rpc_bsc2', '第二个 BSC RPC', OK, '可达');
  }

  // 10) datadir 属主 —— 探针里真踩过：root 属主的 data-path，宿主上既不能备份也不能删
  if (ctx.posix === false) {
    add('datadir', 'data 目录属主', OK,
      '当前系统没有 posix 属主与权限，跳过（真正要长期跑节点的是 Linux，到那边再查一次）');
  } else if (ctx.datadir) {
    if (!ctx.datadir.exists) add('datadir', 'data 目录', WARN, '还不存在（第一次 start 会建）');
    else if (ctx.datadir.uid === 0 && ctx.processUid !== 0) {
      add('datadir', 'data 目录属主', FAIL, 'data 目录属于 root，但你不是 root',
        'compose 里必须写 user: "<id -u>:<id -g>"；已经错了就 sudo chown -R $(id -u):$(id -g) ./data');
    } else if (ctx.datadir.uid !== null && ctx.datadir.uid !== undefined
               && ctx.processUid !== null && ctx.datadir.uid !== ctx.processUid && ctx.processUid !== 0) {
      add('datadir', 'data 目录属主', WARN,
        `data 目录属主 uid=${ctx.datadir.uid}，当前用户 uid=${ctx.processUid}`,
        'compose 的 user: 和你现在的用户对不上，备份和删除都会卡住');
    } else add('datadir', 'data 目录属主', OK, `uid=${ctx.datadir.uid}`);
  }

  // 11) 节点密钥
  if (ctx.posix === false && ctx.nodeKey) {
    add('node_key', '节点密钥', ctx.nodeKey.exists ? OK : FAIL,
      ctx.nodeKey.exists ? '在（本平台查不了权限位）' : 'secrets/key 不存在',
      ctx.nodeKey.exists ? '' : 'bac-node init 会生成');
  } else if (ctx.nodeKey) {
    if (!ctx.nodeKey.exists) {
      add('node_key', '节点密钥', FAIL, 'secrets/key 不存在',
        'bac-node init 会生成。这把 key 同时是 enode 身份，丢了就换 enode');
    } else if (ctx.nodeKey.mode !== null && ctx.nodeKey.mode !== undefined
               && (ctx.nodeKey.mode & 0o077) !== 0) {
      add('node_key', '节点密钥权限', WARN, `权限是 ${(ctx.nodeKey.mode & 0o777).toString(8)}`, 'chmod 600 secrets/key');
    } else add('node_key', '节点密钥', OK, '在，且权限收紧');
  }

  // 12) 磁盘
  if (ctx.disk) {
    if (ctx.disk.freeBytes === null || ctx.disk.freeBytes === undefined) {
      add('disk', '磁盘余量', WARN, ctx.disk.error || '读不到');
    } else {
      const gb = (ctx.disk.freeBytes / 1024 ** 3).toFixed(1);
      if (ctx.disk.freeBytes < DISK_FREE_FAIL_BYTES) {
        add('disk', '磁盘余量', FAIL, `只剩 ${gb} GB`,
          '磁盘满会让 RocksDB 损坏。先清日志；trie log 涨疯了就停节点跑 besu storage x-trie-log prune');
      } else if (ctx.disk.freeBytes < DISK_FREE_WARN_BYTES) {
        add('disk', '磁盘余量', WARN, `剩 ${gb} GB`, '按每年 6–10 GB 的增长估算，提前规划');
      } else add('disk', '磁盘余量', OK, `剩 ${gb} GB`);
    }
  }

  // 13) 质押与节点注册（地址没配就只提醒）
  if (ctx.staking) {
    if (ctx.staking.error) add('staking', 'BSC 上的质押', WARN, ctx.staking.error);
    else if (ctx.staking.staked === null || ctx.staking.staked === undefined) {
      add('staking', 'BSC 上的质押', WARN, '没配 staking 地址，跳过');
    } else {
      const nodes = Math.max(1, ctx.staking.nodes ?? 1);
      const need = MIN_STAKE * BigInt(nodes);
      if (ctx.staking.staked < need) {
        add('staking', 'BSC 上的质押', FAIL,
          `质押 ${fmtUnits(ctx.staking.staked)} BAC < 需要 ${fmtUnits(need)} BAC（${nodes} 个节点）`,
          'bac-node stake --amount 2000000；每多一个节点就要多一份 MIN_STAKE');
      } else add('staking', 'BSC 上的质押', OK, `${fmtUnits(ctx.staking.staked)} BAC`);

      if (ctx.staking.registered === false) {
        add('node_reg', '节点注册', WARN, '这个 nodeId 还没在 ValidatorStaking 上注册',
          'bac-node register --node-id <名字> --payout 0x…');
      } else if (ctx.staking.registered) {
        if (ctx.staking.active === false) {
          add('node_reg', '节点注册', FAIL, '节点已注册但 active = false（领奖资格被取消）',
            '本金不受影响（v1 不罚没），但这个节点领不到奖。去问原因');
        } else if ((ctx.staking.strikes ?? 0) > 0) {
          add('node_reg', '节点注册', WARN, `已注册，strikes = ${ctx.staking.strikes}`,
            'strike 来自「揭示与承诺不符」。检查是不是多机同跑一把私钥');
        } else add('node_reg', '节点注册', OK, '已注册，active，没有 strike');
      }
    }
  }

  return out;
}

export function summarize(results) {
  const fails = results.filter((r) => r.status === FAIL).length;
  const warns = results.filter((r) => r.status === WARN).length;
  return { fails, warns, ok: fails === 0 };
}
