// 离线测试用的假 provider 与假 fetch。
// 没有网络、没有服务器、没有私钥余额：全部在本地内存里答 JSON-RPC。

import { JsonRpcProvider, Network, Interface, Transaction } from "ethers";

/**
 * 一个只认得我们喂给它的答案的 JsonRpcProvider。
 * 覆盖 _send 而不是 send：ethers v6 的 Contract 调用最终都会落到 _send(payload)。
 */
export class MockProvider extends JsonRpcProvider {
  constructor(chainId, handlers = {}) {
    super("http://mock.invalid", new Network("mock", chainId), {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: -1,
      pollingInterval: 10,
    });
    this.handlers = handlers;
    this.calls = [];
    this.sentRaw = [];
  }

  /** 把一个方法的答案换掉（或加上一个新方法）。 */
  on_(method, fn) {
    this.handlers[method] = fn;
    return this;
  }

  async _send(payload) {
    const reqs = Array.isArray(payload) ? payload : [payload];
    return reqs.map((r) => {
      this.calls.push({ method: r.method, params: r.params });
      const h = this.handlers[r.method];
      if (h === undefined) {
        return { id: r.id, error: { code: -32601, message: `mock 没有配 ${r.method}` } };
      }
      try {
        const result = typeof h === "function" ? h(r.params, this) : h;
        return { id: r.id, result };
      } catch (err) {
        return { id: r.id, error: { code: -32000, message: String(err?.message ?? err) } };
      }
    });
  }
}

const DEFAULT_BLOCK = {
  number: "0x64",
  hash: "0x" + "11".repeat(32),
  parentHash: "0x" + "22".repeat(32),
  timestamp: "0x" + (1790000000).toString(16),
  gasLimit: "0x1312d00",
  gasUsed: "0x0",
  miner: "0x0000000000000000000000000000000000000000",
  extraData: "0x",
  baseFeePerGas: "0x0",
  transactions: [],
  difficulty: "0x0",
  nonce: "0x0000000000000000",
};

/**
 * 一个能收写交易的链：eth_call 由 calls 表回答，写交易一律返回 status 1 的收据，
 * 收据里的 logs 由 logsFor(rawTx) 决定。
 */
export function chainMock(chainId, opts = {}) {
  const {
    calls = {},            // selector(0x…8 hex) -> 返回的 abi 编码数据，或 (params) => data
    logsFor = () => [],    // (decodedTx, hash) => logs[]
    balances = {},
    blockNumber = 100,
    blocks = {},
  } = opts;

  const receipts = new Map();
  const p = new MockProvider(chainId, {
    eth_chainId: () => "0x" + chainId.toString(16),
    eth_blockNumber: () => "0x" + blockNumber.toString(16),
    eth_gasPrice: () => "0x3b9aca00",
    eth_maxPriorityFeePerGas: () => "0x0",
    eth_estimateGas: () => "0x7a120",
    eth_getTransactionCount: () => "0x0",
    eth_getCode: () => "0x60006000",
    eth_getBalance: (params) => {
      const a = String(params[0]).toLowerCase();
      return "0x" + BigInt(balances[a] ?? 0n).toString(16);
    },
    eth_getBlockByNumber: (params) => {
      const tag = params[0];
      const n = tag === "latest" ? blockNumber : Number(BigInt(tag));
      const custom = blocks[n];
      if (custom === null) return null;
      return {
        ...DEFAULT_BLOCK,
        number: "0x" + n.toString(16),
        hash: "0x" + n.toString(16).padStart(64, "0"),
        timestamp: "0x" + BigInt(custom?.timestamp ?? DEFAULT_BLOCK.timestamp).toString(16),
      };
    },
    eth_getBlockByHash: () => DEFAULT_BLOCK,
    eth_call: (params) => {
      const data = params[0].data ?? "0x";
      const sel = data.slice(0, 10);
      const h = calls[sel];
      if (h === undefined) throw new Error(`eth_call 没有配这个选择器：${sel}`);
      return typeof h === "function" ? h(params, data) : h;
    },
    eth_getLogs: () => [],
    eth_sendRawTransaction: (params, self) => {
      const raw = params[0];
      const tx = Transaction.from(raw);
      self.sentRaw.push(tx);
      const hash = tx.hash;
      receipts.set(hash, {
        transactionHash: hash,
        blockHash: DEFAULT_BLOCK.hash,
        blockNumber: "0x" + blockNumber.toString(16),
        transactionIndex: "0x0",
        from: tx.from,
        to: tx.to,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        contractAddress: null,
        logsBloom: "0x" + "00".repeat(256),
        status: "0x1",
        type: "0x2",
        logs: logsFor(tx, hash).map((l, i) => ({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: "0x" + blockNumber.toString(16),
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash: DEFAULT_BLOCK.hash,
          logIndex: "0x" + i.toString(16),
          removed: false,
        })),
      });
      return hash;
    },
    eth_getTransactionReceipt: (params) => receipts.get(params[0]) ?? null,
    eth_getTransactionByHash: (params) => {
      const tx = p.sentRaw.find((t) => t.hash === params[0]);
      if (!tx) return null;
      return {
        hash: tx.hash, from: tx.from, to: tx.to, nonce: "0x0", gas: "0x7a120",
        gasPrice: "0x3b9aca00", value: "0x" + tx.value.toString(16), input: tx.data,
        blockHash: DEFAULT_BLOCK.hash, blockNumber: "0x" + blockNumber.toString(16),
        transactionIndex: "0x0", type: "0x2", chainId: "0x" + chainId.toString(16),
      };
    },
  });
  return p;
}

/** 用人类可读 ABI 造一条日志。 */
export function makeLog(abi, address, eventName, values) {
  const iface = new Interface(abi);
  const ev = iface.getEvent(eventName);
  const { data, topics } = iface.encodeEventLog(ev, values);
  return { address, topics, data };
}

/** 把 globalThis.fetch 换成一张 URL → 响应的表，返回还原函数。 */
export function stubFetch(routes) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    for (const [pattern, res] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        const body = typeof res === "function" ? res(u) : res;
        if (body && body.__status && body.__status >= 400) {
          return new Response(JSON.stringify(body.body ?? {}), {
            status: body.__status, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(body), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: `mock 没有这条路由：${u}` } }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  };
  return { restore: () => { globalThis.fetch = original; }, seen };
}

/**
 * 固定的测试私钥：Hardhat / Anvil 的公开默认账户，全世界都知道。
 * 只用于本地假链，**永远不要**在 BSC 主网或层内用它们。
 */
export const TEST_KEYS = {
  controller: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  layer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};
