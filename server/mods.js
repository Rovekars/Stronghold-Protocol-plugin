// server/mods.js — 服务端 MOD 加载器 + 钩子注册表（「真·单文件 MOD」的服务端半边）。
//
// 客户端半边见 public/js/main.js：/mod/manifest.json → 动态 import → default.setup(clientApi)（纯 UI）。
// 本文件补齐服务端：启动时扫描 public/mod/（与 server/http/static.js scanPlugins 同规则：*.js 或 目录/index.js），
// 对每个含 `server` 导出的模块调用 mod.server(serverApi)——同一个 MOD 文件被两端加载，各自注册自己那一半。
//
// 服务端钩子全部收进本模块的全局注册表，引擎在固定挂点查询（每个挂点 ≤3 行、MOD 缺席时零开销）：
//   - api.registerMessage(name, schema)      → 注入 shared/protocol.js 的 C2S，validateC2S 即放行该 C2S 消息
//   - api.registerIntent(name, handler)      → match/match/intents.js _handle 顶端：handler(match, ps, msg)
//   - api.registerMatchInit(fn)              → Match 构造中 fn(match)（一般不必用：matchState 是惰性初始化的）
//   - api.registerPhaseHook(phase, fn)       → 阶段入口（现 'prep' = enterPrep）：fn(match)
//   - api.registerPrivateViewAugment(fn)     → privateView 组装完：fn(match, ps, view)（就地加字段）
//   - api.registerBountyFilter(fn)           → effectsView 悬赏遍历前：fn(match, ps, bounties) => bounties
//   - api.registerNextEnemiesAugment(fn)     → nextEnemiesFor 算完 base：fn(match, ps, base) => 替换列表 | null
//   - api.registerPriceHook(fn)              → priceOf（onPrice 之后）：fn(match, ps, slot) => 最终价 | null
//   - api.matchState(match, init?) / api.rng(match, name) / api.{PHASE,ERR,OK,fail,msg}
//
// 单个 MOD 的加载失败与每次钩子调用失败都被捕获隔离——一个坏 MOD 永远不会拖垮服务端或其它 MOD。
// loadMods() 幂等（进程内单例 Promise）：startServer 与测试 harness 各调一次也只加载一遍。

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './http/config.js';
import { discoverMods } from './modDiscovery.js';
import { C2S } from '../shared/protocol.js';
import { PHASE, ERR } from '../shared/constants.js';
import { msg } from '../shared/i18n.js';
import { OK, fail } from './match/match/common.js';
import { createRng, deriveSeed } from './sim/rng.js';

// ---- 全局注册表（引擎挂点读取）-----------------------------------------------------------------------------------

const intentHandlers = new Map(); // 'g.xxx' → (match, ps, msg) => result
const phaseHooks = new Map(); // phase 名（'prep' …）→ [fn(match)]
const matchInits = []; // [fn(match)]
const privateViewAugments = []; // [fn(match, ps, view)]
const bountyFilters = []; // [fn(match, ps, bounties) => bounties]
const nextEnemiesAugments = []; // [fn(match, ps, base) => list | null]
const priceHooks = []; // [fn(match, ps, slot) => number | null]

/** 受保护的调用：fn 抛错只记日志，永不向上传播（一个坏 MOD 不拖垮引擎）。返回 fn 的返回值（出错时 undefined）。 */
const run = (label, fn, ...args) => {
  try { return fn(...args); } catch (e) { console.error(`[mods] ${label} failed:`, e); }
};

/** MOD 自有 intent 的路由查询（intents.js _handle 顶端调用；无注册时 O(1) Map miss）。 */
export function lookupIntent(t) { return intentHandlers.get(t) || null; }
/** 阶段入口钩子（prep.js enterPrep 调用）。 */
export function runPhaseHooks(match, phase) {
  const list = phaseHooks.get(phase);
  if (list) for (const fn of list) run('phase hook', fn, match);
}
/** Match 构造钩子（Match.js 构造中调用）。 */
export function runMatchInits(match) { for (const fn of matchInits) run('match init', fn, match); }
/** 私有视图增强（player/views.js privateView 组装完调用）。 */
export function runPrivateViewAugments(match, ps, view) {
  for (const fn of privateViewAugments) run('private view augment', fn, match, ps, view);
}
/** 悬赏过滤（player/views.js effectsView 遍历前调用；过滤链依次收窄列表）。 */
export function applyBountyFilters(match, ps, list) {
  for (const fn of bountyFilters) {
    const r = run('bounty filter', fn, match, ps, list);
    if (Array.isArray(r)) list = r;
  }
  return list;
}
/** 敌情预览增强（match/views.js nextEnemiesFor 算完 base 后调用；返回 truthy 列表即替换并短路）。 */
export function applyNextEnemiesAugments(match, ps, base) {
  for (const fn of nextEnemiesAugments) {
    const r = run('nextEnemies augment', fn, match, ps, base);
    if (r) return r;
  }
  return base;
}
/** 价格钩子（player/economy.js priceOf 的 onPrice 之后调用；返回非 null 即短路采用）。 */
export function applyPriceHooks(match, ps, slot) {
  for (const fn of priceHooks) {
    const p = run('price hook', fn, match, ps, slot);
    if (p != null) return p;
  }
  return null;
}

// ---- per-match MOD 状态与随机源 ----------------------------------------------------------------------------------

/** MOD 的 per-match 状态：match.mods[modId]（惰性初始化；match.mods 由 Match 构造保证存在）。 */
export function modState(match, id, init) {
  if (!match.mods || typeof match.mods !== 'object') match.mods = {};
  if (!match.mods[id]) match.mods[id] = init ? init() : {};
  return match.mods[id];
}

/** MOD 专属随机流：createRng(deriveSeed(match.seed, 'mods/<modId>/<name>'))，每局每名稳定、与引擎流互不干扰。 */
function rngFor(match, id, name) {
  if (!match.__modRng || typeof match.__modRng !== 'object') match.__modRng = {};
  const k = `${id}/${name}`;
  if (!match.__modRng[k]) match.__modRng[k] = createRng(deriveSeed(match.seed, `mods/${k}`));
  return match.__modRng[k];
}

// ---- serverApi（每个 MOD 一份，带归属 id）-----------------------------------------------------------------------

function makeServerApi(id) {
  const pushPhase = (phase, fn) => {
    if (!phaseHooks.has(phase)) phaseHooks.set(phase, []);
    phaseHooks.get(phase).push(fn);
  };
  return {
    platform: 'server',
    id,
    PHASE, ERR, OK, fail, msg,
    /** 注册 C2S 消息 schema（注入 validateC2S 的 C2S 目录；S2C 无需注册）。 */
    registerMessage(name, schema) { if (typeof name === 'string' && name && schema && typeof schema === 'object') C2S[name] = schema; },
    /** 注册 C2S intent 处理器：handler(match, ps, msg) → { ok } | { error, detail? }（勿抛异常）。 */
    registerIntent(name, handler) { if (typeof name === 'string' && name && typeof handler === 'function') intentHandlers.set(name, handler); },
    /** 注册阶段钩子：fn(match)。现有挂点：'prep'（enterPrep，wave 已就绪）。 */
    registerPhaseHook(phase, fn) { if (typeof phase === 'string' && typeof fn === 'function') pushPhase(phase, fn); },
    /** 注册对局初始化：fn(match)（Match 构造中调用；matchState 惰性时通常不需要）。 */
    registerMatchInit(fn) { if (typeof fn === 'function') matchInits.push(fn); },
    /** 注册私有视图增强：fn(match, ps, view)（就地给 view 加字段）。 */
    registerPrivateViewAugment(fn) { if (typeof fn === 'function') privateViewAugments.push(fn); },
    /** 注册悬赏过滤：fn(match, ps, bounties) => bounties（返回数组即替换）。 */
    registerBountyFilter(fn) { if (typeof fn === 'function') bountyFilters.push(fn); },
    /** 注册敌情预览增强：fn(match, ps, base) => 替换列表 | null（null = 维持 base，继续后链）。 */
    registerNextEnemiesAugment(fn) { if (typeof fn === 'function') nextEnemiesAugments.push(fn); },
    /** 注册价格钩子：fn(match, ps, slot) => 最终价 | null（非 null 即采用）。 */
    registerPriceHook(fn) { if (typeof fn === 'function') priceHooks.push(fn); },
    /** 本 MOD 的 per-match 状态（惰性初始化）。 */
    matchState(match, init) { return modState(match, id, init); },
    /** 本 MOD 的确定性随机流（每局每名稳定）。 */
    rng(match, name) { return rngFor(match, id, name); },
  };
}

// ---- 加载器（幂等）----------------------------------------------------------------------------------------------

let loadPromise = null;

/** 加载 public/mod/ 下所有 MOD 的服务端半边（幂等；startServer 与测试 harness 调用）。 */
export function loadMods() {
  if (!loadPromise) loadPromise = doLoad();
  return loadPromise;
}

async function doLoad() {
  const { standalone, packs } = discoverMods();
  const files = [];
  for (const s of standalone) files.push({ id: s.id, full: s.full });
  // 整合包成员也要加载服务端半边（它们和 standalone 一样是普通 MOD，只是被 pack.json 分组）。
  for (const p of packs) for (const m of p.members) files.push({ id: m.id, full: m.full });
  files.sort((a, b) => a.id.localeCompare(b.id));
  const loaded = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(f.full).href);
      if (mod && typeof mod.server === 'function') {
        // 稳定 id：MOD 可用 `export const id = 'xxx'` 声明，缺省才回落文件名。
        // 这样把文件重命名成中文（方便辨认）不会改动 per-match 状态键 / 随机流种子。
        const id = (typeof mod.id === 'string' && mod.id) || f.id;
        mod.server(makeServerApi(id));
        loaded.push(id);
      }
    } catch (e) {
      console.error(`[mods] failed to load server side of "${f.id}":`, e);
    }
  }
  if (loaded.length) console.info(`[mods] server hooks registered: ${loaded.join(', ')}`);
  return loaded;
}
