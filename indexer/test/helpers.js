// test/helpers.js —— 测试夹具。
// 日志全部用 ethers 真实 ABI 编码生成，不是手写的十六进制 —— 手写夹具只能证明它自己。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, id as keccakId } from "ethers";
import { IFACES } from "../src/abi.js";
import { openDb } from "../src/db.js";

let tmpDirs = [];

/** 每个测试一个临时 sqlite 文件（任务要求：用临时 sqlite 文件跑）。 */
export function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "bac-indexer-"));
  tmpDirs.push(dir);
  const path = join(dir, "index.db");
  return { db: openDb(path), path, dir };
}

export function cleanupTempDbs() {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 上 WAL 文件偶尔还被占着，删不掉就算了，临时目录会被系统回收
    }
  }
  tmpDirs = [];
}

let seq = 0;
export function nextTxHash() {
  seq += 1;
  return "0x" + seq.toString(16).padStart(64, "0");
}

export const ADDR = {
  AgentRegistry: getAddress("0x1111111111111111111111111111111111111111"),
  BacBridge: getAddress("0x2222222222222222222222222222222222222222"),
  ChainAnchor: getAddress("0x3333333333333333333333333333333333333333"),
  ValidatorStaking: getAddress("0x4444444444444444444444444444444444444444"),
  BacNodeFund: getAddress("0x5555555555555555555555555555555555555555"),
  BacTreasuryVault: getAddress("0x6666666666666666666666666666666666666666"),
  BacVaultFactory: getAddress("0x7777777777777777777777777777777777777777"),
  FlapVaultPortal: getAddress("0x8888888888888888888888888888888888888888"),
  TaxProcessor: getAddress("0x9999999999999999999999999999999999999999"),
  L2Bridge: getAddress("0x0000000000000000000000000000000000000101"),
  L2Gate: getAddress("0x0000000000000000000000000000000000000102"),
  AgentBook: getAddress("0x0000000000000000000000000000000000000103"),
  agentWallet: getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"),
  controller: getAddress("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"),
  validator: getAddress("0xcccccccccccccccccccccccccccccccccccccccc"),
};

export const TEST_CFG = {
  bscChainId: 56,
  layerChainId: 56777,
  bscRpc: "https://bsc-rpc.publicnode.com",
  apiBase: "https://95-179-183-132.sslip.io",
  bscLogRangeMax: 5000,
  genesisPath: join(tmpdir(), "no-such-genesis.json"),
  addresses: {
    AgentRegistry: ADDR.AgentRegistry,
    BacBridge: ADDR.BacBridge,
    ChainAnchor: ADDR.ChainAnchor,
    ValidatorStaking: ADDR.ValidatorStaking,
    BacNodeFund: ADDR.BacNodeFund,
    BacTreasuryVault: ADDR.BacTreasuryVault,
    BacVaultFactory: ADDR.BacVaultFactory,
    FlapVaultPortal: ADDR.FlapVaultPortal,
    TaxProcessor: ADDR.TaxProcessor,
  },
};

export const TEST_BOOK = (() => {
  const b = {
    [ADDR.L2Bridge.toLowerCase()]: "L2Bridge",
    [ADDR.L2Gate.toLowerCase()]: "L2Gate",
    [ADDR.AgentBook.toLowerCase()]: "AgentBook",
  };
  for (const [k, v] of Object.entries(TEST_CFG.addresses)) b[v.toLowerCase()] = k;
  return b;
})();

/**
 * 用真实 ABI 编码造一条日志。
 * mkLog("BacBridge", "Locked", { depositId: 1n, ... }) —— 参数按事件声明顺序取。
 */
export function mkLog(contract, event, argsObj, { blockNumber = 100, logIndex = 0, txHash = null, address = null } = {}) {
  const iface = IFACES[contract];
  const frag = iface.getEvent(event);
  const values = frag.inputs.map((inp) => {
    if (!(inp.name in argsObj)) throw new Error(`夹具缺少参数 ${contract}.${event}.${inp.name}`);
    return argsObj[inp.name];
  });
  const { data, topics } = iface.encodeEventLog(frag, values);
  return {
    address: address || ADDR[contract] || ADDR.AgentBook,
    topics,
    data,
    blockNumber,
    transactionHash: txHash || nextTxHash(),
    logIndex,
  };
}

export const KIND = (k) => keccakId(k);

/** 造一个层内区块 + 收据（ingestLayerBlock 的输入形状）。 */
export function mkLayerBlock({ number = 1, ts = 1790000000, txs = [] } = {}) {
  return {
    block: {
      number,
      hash: "0x" + String(number).padStart(64, "b"),
      parentHash: "0x" + String(number - 1).padStart(64, "a"),
      timestamp: ts,
      gasUsed: 21000 * txs.length,
      gasLimit: 20000000,
      baseFeePerGas: 0n,
      transactions: txs.map((t, i) => ({
        hash: t.hash || nextTxHash(),
        from: t.from,
        to: t.to ?? null,
        value: t.value ?? 0n,
        gasPrice: t.gasPrice ?? 1000000000n,
        transactionIndex: i,
      })),
    },
    receipts: txs.map((t) => ({
      gasUsed: t.gasUsed ?? 21000,
      effectiveGasPrice: t.gasPrice ?? 1000000000n,
      contractAddress: t.created ?? null,
      status: t.status ?? 1,
      codeSize: t.codeSize ?? 0,
    })),
  };
}
