// 极小的 hex 工具。放在单独文件里是为了让工作线程不必 import ethers（省一次 30 ms 的模块加载）。

export function getBytesFromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("hex 长度必须是偶数");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
