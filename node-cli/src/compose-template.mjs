// 见证人真正要跑的那份 compose.yml 的生成器。
// 形状照抄 docs/02-CHAIN-SPEC.md §7.1，差别只有：uid/gid 与 bootnode 由 init 真填进去，
// 以及 attester 服务默认跑本地这份 @bac/node-cli（npm 发布方式未定，03 §[待定] 1）。

export function renderCompose(cfg) {
  const uid = cfg.uid, gid = cfg.gid;
  const boot = (cfg.bootnodes || []).join(',');
  const p2pHostLine = cfg.p2pHost ? `      - --p2p-host=${cfg.p2pHost}\n` : '';
  return `# 由 \`bac-node init\` 生成。改完记得 \`bac-node doctor\` 再 \`bac-node start\`。
# 见证人跑的是**只读全节点**，不出块、不投票、不影响共识（02 §0.5）。
name: bac-validator
services:
  besu:
    image: ${cfg.besuImage}          # 实测过的 tag，不许用 latest
    restart: unless-stopped
    user: "${uid}:${gid}"            # 你自己的 id -u:id -g。不写这一行会造出 root 属主的 data 目录
    stop_grace_period: 2m            # RocksDB 要时间干净关闭；被 SIGKILL 打断会留下要修复的 DB
    environment:
      BESU_OPTS: "${cfg.besuOpts}"
    command:
      - --data-path=/data
      - --genesis-file=/config/genesis.json
      - --node-private-key-file=/secrets/key
      - --data-storage-format=BONSAI
      - --bonsai-limit-trie-logs-enabled=true
      - --sync-mode=FULL
      - --bootnodes=${boot}
      - --p2p-port=${cfg.p2pPort}
${p2pHostLine}      - --nat-method=NONE
      - --max-peers=25
      - --discovery-enabled=true
      - --rpc-http-enabled=true
      - --rpc-http-host=0.0.0.0
      - --rpc-http-port=8545
      - --rpc-http-api=ETH,NET,WEB3,QBFT
      - --host-allowlist=besu,localhost,127.0.0.1
      - --revert-reason-enabled=true
      - --min-gas-price=0
      - --engine-rpc-enabled=false
      - --logging=INFO
    volumes:
      - ./data/besu:/data
      - ./config:/config:ro
      - ./secrets:/secrets:ro
    ports:
      - "${cfg.p2pPort}:${cfg.p2pPort}/tcp"
      - "${cfg.p2pPort}:${cfg.p2pPort}/udp"
      - "127.0.0.1:${cfg.rpcPort}:8545"   # RPC 只绑本机，不要对公网开
    mem_limit: ${cfg.memLimit}
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }

  attester:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    # 私钥只从 validator.env 按名字进环境变量，永远不写进 compose、不进日志
    command: [ "node", "src/cli.mjs", "attest", "--home", "/work" ]
    volumes:
      - ./node-cli:/app:ro           # 这份 @bac/node-cli 的目录（npm 发布方式未定，03 §[待定] 1）
      - .:/work
    environment:
      LAYER_RPC: http://besu:8545
      BSC_RPC: https://bsc-rpc.publicnode.com
      BSC_RPC_2: https://bsc-dataseed.bnbchain.org
    env_file: [ ./validator.env ]    # 里面只有一行 VALIDATOR_PRIVATE_KEY（chmod 600，不进 git）
    depends_on: [ besu ]
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }
`;
}
