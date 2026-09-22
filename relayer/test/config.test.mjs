// 配置：私钥只按变量名读、地址一律 EIP-55、两个 BSC RPC 必须独立、层侧不允许非 instant。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, redactedConfig } from '../src/config.mjs';

const BASE = {
  RELAYER_PRIVATE_KEY: '0x' + '11'.repeat(32),
  RELAYER_LAYER_PRIVATE_KEY: '0x' + '22'.repeat(32),
  BSC_RPC: 'https://a.example',
  BSC_RPC_2: 'https://b.example',
  LAYER_RPC: 'http://besu:8545',
  DB_PATH: '/var/bac/relayer.db',
  BAC_BRIDGE: '0x00000000000000000000000000000000000b4c01',
  AGENT_REGISTRY: '0x0000000000000000000000000000000000ae9001',
  CHAIN_ANCHOR: '0x0000000000000000000000000000000000a0c001',
  CLIQUE_SIGNER: '0x0000000000000000000000000000000000005164',
};

describe('loadConfig', () => {
  it('地址被规范成 EIP-55 校验和格式，系统合约有默认值', () => {
    const c = loadConfig(BASE);
    assert.equal(c.addresses.l2Bridge, '0x0000000000000000000000000000000000000101');
    assert.equal(c.addresses.feeSink, '0x000000000000000000000000000000000000dEaD');
    assert.equal(c.addresses.agentRegistry, '0x0000000000000000000000000000000000aE9001');
  });

  it('LAYER_SIGNER_ADDRESS 优先于历史名字 CLIQUE_SIGNER', () => {
    const c = loadConfig({ ...BASE, LAYER_SIGNER_ADDRESS: '0x0000000000000000000000000000000000009999' });
    assert.equal(c.addresses.layerSigner, '0x0000000000000000000000000000000000009999');
  });

  it('两个 BSC RPC 相同 → 直接拒绝启动（一致的 finalized 是确认条件之一）', () => {
    assert.throws(() => loadConfig({ ...BASE, BSC_RPC_2: BASE.BSC_RPC }), /独立/);
  });

  it('LAYER_FINALITY 不是 instant → 拒绝（层内是 QBFT 即时最终性）', () => {
    assert.throws(() => loadConfig({ ...BASE, LAYER_FINALITY: 'probabilistic' }), /instant/);
  });

  it('缺私钥 → 拒绝启动，且错误信息里只有变量名', () => {
    const { RELAYER_PRIVATE_KEY, ...rest } = BASE;
    assert.throws(() => loadConfig(rest), (e) => e.message.includes('RELAYER_PRIVATE_KEY') && !e.message.includes('0x11'));
  });

  it('redactedConfig 里没有任何私钥', () => {
    const r = redactedConfig(loadConfig(BASE));
    const s = JSON.stringify(r);
    assert.ok(!s.includes('11'.repeat(32)));
    assert.ok(!s.includes('22'.repeat(32)));
    assert.equal(r.keys.bsc, '[REDACTED]');
  });
});
