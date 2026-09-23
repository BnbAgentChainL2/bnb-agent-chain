// 部署帮手：**拿你自己的字节码去部署**，按这条链的 gas 规矩调好参数。
//
// 这里没有任何「官方 ERC-20」「官方 DEX」的字节码，一个字节都没有（决策 #19 / 03 §7.0 第 1 条）。
// 你传 `{ abi, bytecode }`，我们负责把它稳稳地送上链：
//   · zeroBaseFee: true（决策 #16）—— 这条链**没有 base fee**，所以一律发 legacy（type 0）交易并显式给 gasPrice。
//     发 EIP-1559 交易在 baseFee = 0 的链上会让 maxFeePerGas 算成 0，直接被 txpool 以低于下限丢掉。
//   · --min-gas-price = 1 gwei（02 §4.1）—— gasPrice 取「节点报价」与 1 gwei 的较大值。
//     关掉 basefee 之后这个固定下限是防刷链的三条防线之一，低于它的交易不进 txpool。
//   · gasLimit = eth_estimateGas × 1.25，上限 20,000,000（区块上限，02 §4.1）。
//     估算本身就超过区块上限时直接报错，而不是发一笔必然打不进块的交易。
//   · gas 费全额进当届提案者的 EOA（决策 #17），没有销毁 —— 账上它是别人的收入，不是凭空消失。

import {
  concat, getAddress, getCreateAddress, Interface, isHexString, keccak256, toUtf8Bytes,
  type Provider, type Signer,
} from "ethers";
import { LAYER_SYSTEM } from "../config.js";
import { BacError, BacUnknownStateError, withChainErrors } from "../errors.js";
import { create2Address } from "../agent.js";

/** 02 §4.1：`--min-gas-price=1000000000`，zeroBaseFee 下它是唯一的价格下限。 */
export const MIN_GAS_PRICE_WEI = 1_000_000_000n;
/** 02 §4.1：区块 gas 上限 20,000,000。 */
export const BLOCK_GAS_LIMIT = 20_000_000n;
/** 估算之上再加的余量，默认 25%（构造函数里带循环时估算经常偏低）。 */
export const DEFAULT_GAS_HEADROOM_BPS = 2500;
/** EIP-170：部署出来的运行时代码最多 24,576 字节。 */
export const MAX_CODE_SIZE = 24_576;
/** EIP-3860：initcode 最多 49,152 字节。 */
export const MAX_INITCODE_SIZE = 49_152;

export interface Artifact {
  /** 有构造参数时必须给（要拿它编码参数）；没有构造参数时可以省 */
  abi?: any[];
  /** 0x 开头的部署字节码（Foundry 的 bytecode.object、Hardhat 的 bytecode） */
  bytecode: string;
}

export interface GasPlan {
  gasLimit: bigint;
  gasPrice: bigint;
  /** 最坏情况下这笔交易花多少 wei（gasLimit × gasPrice），**全额进出块的验证者，不销毁** */
  maxFeeWei: bigint;
  /** eth_estimateGas 的原始返回；调用方自己给了 gasLimit 时是 0 */
  estimated: bigint;
}

export interface DeployOptions {
  /** 给了就走创世的 CREATE2 部署器，地址可以先算出来 */
  salt?: string;
  value?: bigint;
  /** 覆盖自动估算 */
  gasLimit?: bigint;
  gasPrice?: bigint;
  gasHeadroomBps?: number;
  /** 等几个确认，默认 1（层内 QBFT 即时最终性，不重组） */
  confirmations?: number;
}

export interface DeployResult {
  address: string;
  txHash: string;
  blockNumber: number | null;
  gasUsed: bigint;
  gasPrice: bigint;
  /** 实际花掉的 wei = gasUsed × effectiveGasPrice */
  feeWei: bigint;
  /** 部署后链上代码的字节数 */
  codeSize: number;
  /** ABI 的 keccak，与 Agent.deploy() 返回的那个同一口径，可以当「这是哪一版接口」的指纹 */
  abiHash: string;
  /** CREATE2 走创世部署器，CREATE 是普通 nonce 部署 */
  via: "create" | "create2";
}

function normalizeSalt(salt: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(salt)) return salt.toLowerCase();
  return keccak256(toUtf8Bytes(salt));
}

/** 把字节码和构造参数拼成 initcode。参数编码用你自己给的 abi，我们不替你猜类型。 */
export function encodeInitCode(artifact: Artifact, args: any[] = []): string {
  const raw = artifact?.bytecode ?? "";
  const code = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isHexString(code) || code.length < 4) {
    throw new BacError(
      "bad_bytecode",
      "bytecode 不是合法的 0x 十六进制串",
      "Foundry 取 artifact.bytecode.object，Hardhat 取 artifact.bytecode。别把 deployedBytecode 传进来：那是运行时代码，部署不了。",
    );
  }
  if (!args || args.length === 0) return code;
  if (!artifact.abi) {
    throw new BacError("no_abi", "带构造参数时必须提供 abi", "要用 abi 里的构造函数签名来编码参数，猜不出来。");
  }
  const iface = new Interface(artifact.abi);
  return concat([code, iface.encodeDeploy(args)]);
}

/** initcode 大小体检：EIP-3860 超了就没必要发交易；接近 EIP-170 只给提醒。 */
export function checkCodeSize(initCode: string): { initCodeSize: number; warning: string | null } {
  const initCodeSize = (initCode.length - 2) / 2;
  if (initCodeSize > MAX_INITCODE_SIZE) {
    throw new BacError(
      "initcode_too_big",
      `initcode ${initCodeSize} 字节，超过 EIP-3860 的 ${MAX_INITCODE_SIZE}`,
      "把合约拆小，或者把逻辑放进库里用 delegatecall。这笔交易发出去一定失败。",
    );
  }
  const warning = initCodeSize > MAX_CODE_SIZE
    ? `initcode ${initCodeSize} 字节；部署后的运行时代码若超过 EIP-170 的 ${MAX_CODE_SIZE} 字节会失败（构造参数不算在内，所以这只是提醒）。`
    : null;
  return { initCodeSize, warning };
}

/** 这条链的 gasPrice：节点报价与 1 gwei 下限取大。 */
export async function gasPriceFor(provider: Provider, override?: bigint): Promise<bigint> {
  if (override !== undefined) {
    if (override < MIN_GAS_PRICE_WEI) {
      throw new BacError(
        "gas_price_too_low",
        `gasPrice ${override} 低于节点下限 ${MIN_GAS_PRICE_WEI}（1 gwei）`,
        "02 §4.1 的 --min-gas-price 是 1 gwei，低于它的交易不进 txpool，会一直挂着不上链。",
      );
    }
    return override;
  }
  let reported = 0n;
  try {
    const fd = await provider.getFeeData();
    reported = fd.gasPrice ?? 0n;
  } catch {
    reported = 0n;
  }
  return reported > MIN_GAS_PRICE_WEI ? reported : MIN_GAS_PRICE_WEI;
}

/** 估 gas 并加余量，顺便挡住「估算就已经超过区块上限」的情况。 */
export async function planGas(
  provider: Provider,
  tx: { from?: string; to?: string; data: string; value?: bigint },
  opts: { gasLimit?: bigint; gasPrice?: bigint; gasHeadroomBps?: number } = {},
): Promise<GasPlan> {
  const gasPrice = await gasPriceFor(provider, opts.gasPrice);
  let estimated = 0n;
  if (opts.gasLimit === undefined) {
    estimated = await withChainErrors("估算 gas", async () => provider.estimateGas({
      from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? 0n,
    }));
    if (estimated > BLOCK_GAS_LIMIT) {
      throw new BacError(
        "gas_over_block_limit",
        `估算需要 ${estimated} gas，超过区块上限 ${BLOCK_GAS_LIMIT}`,
        "这笔交易任何时候都打不进块。把构造函数里的循环拆成多笔，或者把初始化挪到部署之后单独调。",
      );
    }
  }
  const headroom = BigInt(opts.gasHeadroomBps ?? DEFAULT_GAS_HEADROOM_BPS);
  let gasLimit = opts.gasLimit ?? (estimated * (10_000n + headroom)) / 10_000n;
  if (gasLimit > BLOCK_GAS_LIMIT) gasLimit = BLOCK_GAS_LIMIT;
  return { gasLimit, gasPrice, maxFeeWei: gasLimit * gasPrice, estimated };
}

function providerOf(signer: Signer): Provider {
  const p = signer.provider;
  if (!p) {
    throw new BacError(
      "no_provider", "signer 没有连 provider",
      "用 new Wallet(key, layerProvider(cfg)) 把钱包接到层内 RPC 上再来。",
    );
  }
  return p;
}

/**
 * 用**你自己的**字节码部署一个合约（普通 CREATE，地址由 from + nonce 决定）。
 * 部署完会读一次 eth_getCode 核对：代码为空就抛错，不假装成功。
 */
export async function deployContract(
  signer: Signer, artifact: Artifact, args: any[] = [], opts: DeployOptions = {},
): Promise<DeployResult> {
  if (opts.salt) return deployCreate2(signer, artifact, args, opts.salt, opts);
  const provider = providerOf(signer);
  const from = await signer.getAddress();
  const initCode = encodeInitCode(artifact, args);
  checkCodeSize(initCode);
  const abiHash = keccak256(toUtf8Bytes(JSON.stringify(artifact.abi ?? [])));

  return withChainErrors("部署合约", async () => {
    const plan = await planGas(provider, { from, data: initCode, value: opts.value }, opts);
    const nonce = await provider.getTransactionCount(from, "pending");
    const predicted = getCreateAddress({ from, nonce });
    const tx = await signer.sendTransaction({
      type: 0, data: initCode, value: opts.value ?? 0n,
      gasLimit: plan.gasLimit, gasPrice: plan.gasPrice, nonce,
    });
    const rc = await tx.wait(opts.confirmations ?? 1);
    if (rc && rc.status === 0) {
      throw new BacUnknownStateError(
        `部署交易 ${tx.hash} 上链了但 status = 0`,
        "构造函数 revert 了。用 eth_call 在同一高度重放这段 initcode 看 revert 原因。",
      );
    }
    const address = rc?.contractAddress ? getAddress(rc.contractAddress) : predicted;
    const code = await provider.getCode(address);
    if (code === "0x") {
      throw new BacUnknownStateError(
        `交易 ${tx.hash} 上链了，但 ${address} 上没有代码`,
        "构造函数可能自毁了，或者你传的是 deployedBytecode。检查 artifact 取的是哪个字段。",
      );
    }
    return {
      address, txHash: tx.hash, blockNumber: rc?.blockNumber ?? null,
      gasUsed: rc?.gasUsed ?? 0n, gasPrice: plan.gasPrice,
      feeWei: (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? plan.gasPrice),
      codeSize: (code.length - 2) / 2, abiHash, via: "create" as const,
    };
  });
}

/**
 * 走创世的 CREATE2 确定性部署器（0x4e59…4956C，02 §2 的中立工具之一）。
 * 地址只由 salt + initcode 决定，所以**可以先把地址写进另一个合约再部署**，互相引用不用等。
 * salt 可以是 32 字节 hex，也可以是任意字符串（会取 keccak256）。
 */
export async function deployCreate2(
  signer: Signer, artifact: Artifact, args: any[] = [], salt: string, opts: DeployOptions = {},
): Promise<DeployResult> {
  const provider = providerOf(signer);
  const from = await signer.getAddress();
  const initCode = encodeInitCode(artifact, args);
  checkCodeSize(initCode);
  const abiHash = keccak256(toUtf8Bytes(JSON.stringify(artifact.abi ?? [])));
  const s = normalizeSalt(salt);
  const address = create2Address(LAYER_SYSTEM.create2Deployer, s, keccak256(initCode));
  const data = concat([s, initCode]);

  return withChainErrors("部署合约(CREATE2)", async () => {
    const already = await provider.getCode(address);
    if (already !== "0x") {
      throw new BacError(
        "create2_taken",
        `${address} 上已经有代码了（同 salt + 同 initcode 部署过）`,
        "换一个 salt。CREATE2 地址是 salt 与 initcode 的函数，同样的输入永远是同一个地址。",
      );
    }
    const plan = await planGas(provider, { from, to: LAYER_SYSTEM.create2Deployer, data, value: opts.value }, opts);
    const tx = await signer.sendTransaction({
      type: 0, to: LAYER_SYSTEM.create2Deployer, data, value: opts.value ?? 0n,
      gasLimit: plan.gasLimit, gasPrice: plan.gasPrice,
    });
    const rc = await tx.wait(opts.confirmations ?? 1);
    const code = await provider.getCode(address);
    if (code === "0x") {
      throw new BacUnknownStateError(
        `CREATE2 交易 ${tx.hash} 上链了，但 ${address} 上没有代码`,
        "构造函数 revert 或者这个地址被抢了。换一个 salt 再来。",
      );
    }
    return {
      address, txHash: tx.hash, blockNumber: rc?.blockNumber ?? null,
      gasUsed: rc?.gasUsed ?? 0n, gasPrice: plan.gasPrice,
      feeWei: (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? plan.gasPrice),
      codeSize: (code.length - 2) / 2, abiHash, via: "create2" as const,
    };
  });
}

/** 不发交易就算出 CREATE2 地址。与 Agent.predictAddress() 同一个算法。 */
export function predictCreate2Address(
  artifact: Artifact, args: any[], salt: string, deployer: string = LAYER_SYSTEM.create2Deployer,
): string {
  const initCode = encodeInitCode(artifact, args ?? []);
  return create2Address(deployer, normalizeSalt(salt), keccak256(initCode));
}

/** 不发交易就算出普通 CREATE 地址（from + nonce）。 */
export function predictCreateAddress(from: string, nonce: number): string {
  return getCreateAddress({ from: getAddress(from), nonce });
}
