// 创造模式「无限资金」：服务端经济学放行（economy.js 的 spend 在 infiniteFunds 下为 no-op）。
// 直接 import PlayerEconomy 类，用最小 this stub 验证扣减/放行逻辑，无需起整套 match。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayerEconomy } from '../server/match/player/economy.js';

const mk = (infiniteFunds) => {
  const p = Object.create(PlayerEconomy.prototype);
  p.funds = 100;
  p.m = { creative: { infiniteFunds } };
  p.stats = { gold: 0 };
  p.round = { spent: 0 };
  p.dirty = () => {};
  return p;
};

test('无限资金开启：spend 不扣减、不计入消耗、返回成功', () => {
  const p = mk(true);
  const ok = p.spend(50);
  assert.equal(ok, true, 'spend 应返回成功');
  assert.equal(p.funds, 100, '资金不变');
  assert.equal(p.stats.gold, 0, '消耗资金统计不变');
  assert.equal(p.round.spent, 0, '本轮消耗统计不变');
});

test('无限资金关闭且资金足够：spend 正常扣减', () => {
  const p = mk(false);
  const ok = p.spend(30);
  assert.equal(ok, true);
  assert.equal(p.funds, 70);
  assert.equal(p.stats.gold, 30);
  assert.equal(p.round.spent, 30);
});

test('无限资金关闭且资金不足：spend 拒绝、资金不变', () => {
  const p = mk(false);
  const ok = p.spend(200);
  assert.equal(ok, false);
  assert.equal(p.funds, 100);
});
