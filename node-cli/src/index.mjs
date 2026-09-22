// 库入口：把「任何人都该能独立复算」的那几块导出去。
// 中继、@bac/agent-sdk 与本包对 l2Block / exitRoot 的实现必须字节级一致，这三处共用同一套定义。

export * as anchorMath from './anchor-math.mjs';
export * as exitTree from './exit-tree.mjs';
export * as attestState from './attest-state.mjs';
export * as doctor from './doctor.mjs';
export { computeEpoch } from './attest-compute.mjs';
export { commitmentHash, SaltStore } from './salt-store.mjs';
export { checkGenesisChain, checkGenesisFile, sha256Hex } from './genesis-gate.mjs';
export { validateConfig, defaultConfig, layout } from './config.mjs';
export { renderCompose } from './compose-template.mjs';
export { Rpc } from './rpc.mjs';
export { Api } from './api.mjs';
export { Docker } from './docker.mjs';
export * from './constants.mjs';
