// 盲盒模式 · Blind box (user MOD)
//
// 三种模式（大厅四选一，默认「关闭」）：
//   shop  — 休整期商店每个格子变盲盒：看不到内容/稀有度，价格统一为「盲盒底价 + 等级 - 1」（底价 2：1 级 2 资金，每升一级 +1）。
//   enemy — 敌人情报盲盒：普通波在休整期隐藏敌人情报（「？？？」），可花资金侦察出「类型 + 总数量」（永不透露具体是谁）。
//   all   — 以上两者同时生效。
//   jar   — 砸罐子：休整期没有商店（底栏只剩「升级 + 资金」），战场每个可部署格子上放一个罐子（常驻、不可收起）。
//            点一下砸开，内容服务端权威：干员（免费获得，立刻就能部署）/ 道具（进整备区，两件相同自动合成金色）/
//            敌人（立刻破罐出战：先开一场只有罐中敌人的遭遇战——休整期照常布阵砸罐，点「准备」后本波大部队
//            注入同一场战斗继续打；漏怪 / 击杀连续结算）。三单选一，风险自担。
//            敌人池取「本波 + 本模式所有普通波次」的敌人并轮流分配，种类丰富不重复。单播揭示，队友看不到你开了什么。
//   off   — 关闭，恢复正常游戏。
//
// 价格是服务器权威的：插件只发 g.blindBoxSet { mode }，真正的定价在 mod/盲盒模式.js 的 server(api)（经
// server/mods.js 的 registerPriceHook 注入 priceOf）。客户端卡片显示的 slot.price 由服务端算好后下发
// （player/views.js），所以界面价格与实际扣费永远一致，队友代购（peershop）看到的也是盲盒价。
// 敌人情报的隐藏/侦察同样服务端权威：盲盒 server(api) 的 registerNextEnemiesAugment 在 enemy/all 模式下把
// nextEnemies 标 redacted / partial，客户端 drawer（敌方情报）与战场 pen 据此渲染（pen 自动跳过无 enemyKey 的
// 条目 → 休整期战场看不到敌人）。
//
// 本文件是「双端单文件 MOD」：
//   - 浏览器（public/js/main.js）：default.setup(clientApi) —— 大厅卡片 / 商店覆盖 / overlay 全套 UI。
//   - Node 服务端（server/mods.js loadMods）：server(serverApi) —— 协议注册、intent、阶段钩子、视图/价格钩子，
//     盲盒全部服务端权威逻辑；核心引擎只留通用挂点（registerIntent / registerPhaseHook / …）。
//   - 浏览器依赖（preact hooks、本体 UI 模块）在下方用环境守卫 + 顶层 await 懒加载：Node 端 window 不存在 →
//     整块跳过 → 服务端可以安全 import 本文件。
//
// 本体扩展点：
//   - api.registerShopOverride({ id, Component })（ui/shopBar.js）——Component 收到本体 ShopBar 的全部 props，
//     外加 props.next（链上的下一个渲染器：另一个 MOD 的覆盖，链尾是官方商店栏）。本插件在不接管时渲染
//     <${props.next} …/> 让位，因此与「创造模式」共存：创造模式开启时由它接管，否则由盲盒接管。
//   - api.registerLobbyEntry({ id, Component })——主界面「模拟方式」下的模式卡片（本地持久化，进模拟自动应用）。
//   - api.registerOverlay({ Component })——无 UI 的「大脑」组件：同步服务端状态、进局自动应用偏好、侦听侦察事件、揭示特效。
//   - 音效：audio.sfx（../js/audio.js），与本体按钮同一套。
//   - 注意：MOD 可能以 Blob URL 加载（本地添加）；对本体模块的 '/js/…' 绝对路径与 '../js/…' 相对导入均可解析
//     （与 creativemode / operatorskin 等既有 MOD 一致）。

// ---- 浏览器专用依赖（环境守卫 + 顶层 await 懒加载）--------------------------------------------------------------
let useState, useEffect, useRef, useMemo;
let preactRender; // 罐子层 / 敌人标记层 portal 进游戏屏 .gm 用（第二棵 preact 根）
let PreactComponent; // preact.Component：错误边界基类（overlay 抛错不再连坐全局渲染 → 修"加插件丢头像"）
let ShopBar, SoldCard, RewardCards, useTwoTap, armKey;
let RewardOverlay; // 升级奖励（原生 rewardOverlay.js）：jar 底栏复用，「稍后」收起为 pill
let TierChip, HexBadge, Icon, Modal, Button;
let Img;
let chessPortraitUrl, itemIconUrl, enemyIconUrl;
let actions; // 原生意图通道（gameActions.act）：统一 toast 错误 + 音效（晋升奖励领取用它，不再静默吞错）
let audio, modsOffMap, MODS_EVENT;
if (typeof window !== 'undefined') {
  ({ useState, useEffect, useRef, useMemo } = await import('preact/hooks'));
  ({ render: preactRender, Component: PreactComponent } = await import('preact'));
  ({ ShopBar, SoldCard, RewardCards, useTwoTap, armKey } = await import('/js/ui/shopBar.js'));
  ({ TierChip, HexBadge, Icon, Modal, Button } = await import('/js/ui/components.js'));
  ({ Img } = await import('/js/ui/gameComponents.js'));
  ({ chessPortraitUrl, itemIconUrl, enemyIconUrl } = await import('/js/ui/assetUrls.js'));
  ({ RewardOverlay } = await import('/js/ui/rewardOverlay.js'));
  ({ actions } = await import('/js/ui/gameActions.js'));
  ({ audio } = await import('../js/audio.js'));
  ({ modsOffMap, MODS_EVENT } = await import('../js/ui/mods.js'));
}

// 障碍物投影到「待部署区」空格用：GEO.HAND_ROW / HAND_SIZE（shared/constants.js）。浏览器懒加载，失败回退硬编码（布局常量，极稳定）。
let JAR_HAND_ROW = 7, JAR_HAND_SIZE = 10, JAR_ROWS = 19, JAR_COLS = 21;
if (typeof window !== 'undefined') {
  try { const c = await import('/shared/constants.js'); if (c && c.GEO) { JAR_HAND_ROW = c.GEO.HAND_ROW; JAR_HAND_SIZE = c.GEO.HAND_SIZE; JAR_ROWS = c.GEO.ROWS; JAR_COLS = c.GEO.COLS; } } catch { /* 用默认值 */ }
}

// 屏幕(client)坐标是否落在 tileScreen 返回的多边形(poly, client 坐标)内——拖拽落点反查「屏幕→战场格子」用。
function jarPointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const PREF_KEY = 'sp.blindbox.pref'; // { mode: 'off'|'all'|'jar' } —— 大厅选择的本地持久化（默认关闭：不开启就完全不影响游戏）
// 2026-10-16：按用户要求下掉「仅商店变盲盒（shop）」与「敌人情报隐藏（enemy）」两个单开模式——
// 它们的合并效果由「迷雾（all）」提供，故不再单列卡片（服务端仍接受旧值，见 loadPref 的迁移）。
const BB_MODES = [
  { id: 'off', label: '关闭', desc: '恢复正常游戏' },
  { id: 'all', label: '普通', desc: '干员和道具由盲盒开出，敌人处于迷雾状态' },
  { id: 'jar', label: '砸罐子', wide: true, desc: '无商店 · 敌人全部来自罐子 · 砸开即出战' },
];
const JAR_SFX_URL = '/assets/audio/sfx/enemy/e_imp/e_imp_mirror.mp3'; // 砸罐音效：原生 Arknights 镜面/玻璃受击声，0.42s，贴合花瓶砸碎
const shopOn = (mode) => mode === 'shop' || mode === 'all';
const enemyOn = (mode) => mode === 'enemy' || mode === 'all';
const jarOn = (mode) => mode === 'jar';

// ── jar 商店·复活充能（双端共用）────────────────────────────────────────────────────────────────
// 「复活一次」的战斗侧：每场战斗开始时，服务端把持有充能的玩家授予进 jarReviveGrants（battleId → Map(playerId → 充能数)，
// 客户端模拟再经 b.jarReviveGrant 同步给浏览器副本）；createBattleFromSpec 包装器给每场战斗挂一个 kill 钩子——
// 己方干员被击倒（kill 钩子里的官方复活机制：处理器把 victim.hp 写回正数，kill() 就不退场）且其玩家还有充能时，
// 扣 1 点充能、原地满血复活。消耗记账：服务端模拟直接回调 ctx.consume（match 状态扣减 + toast）；
// 客户端模拟发 g.jarReviveUsed {battleId, playerId, n}（n 累计，服务端按增量去重扣减）。
// 只在 jar 商店买过充能的战斗有非空授予表 → 其他模式 / 原生 / 其他 MOD 的战斗完全不受影响。
const jarReviveGrants = new Map();   // battleId → Map(playerId → 剩余充能)
const jarReviveCtx = new Map();      // battleId → { consume(playerId) }（仅服务端；客户端缺省 → 发 g.jarReviveUsed）
const jarObstacleCtx = new Map();    // battleId → { lost(playerId, tier, r, c) }（仅服务端；客户端缺省 → 发 g.jarObstacleLost）
const jarReviveUsedCount = new Map(); // 客户端：`${battleId}|${playerId}` → 已上报累计次数
let jarClientNet = null;             // setup(api) 时注入（客户端消耗上报用）
const jarIsClient = typeof window !== 'undefined';
// 障碍物在战场上的落点用的是引擎原生的「阻隔工事」箱子（会挡路、被敌人拆毁），key 与 devices.js 的 CRATE_KEY 一致。
const JAR_CRATE_KEY = 'trap_1105_accrate';
// jar 障碍物：玩家手动部署（g.jarDeployDevice → battle.spawnDevice）；「持久模型」——部署记入 st.jarObstacles（跨回合保留），
// 每波战斗建立后重铺（jarRespawnObstacles）；被敌人拆毁才从列表移除并释放拥有数（可再买）。拥有数(obsBasic/obsAdvanced)=已放+待放，每种上限 3。
// 测试专用：server(api) 内定义的部署函数挂到这里，供 __jarObstacleTest 导出（该函数定义在 server 作用域内）。
let __jarDeployDeviceFn = null;
// 测试专用：server(api) 内 jarApplyLoad/jarLoadSave 挂载点，供 __jarSaveTest 导出。
let __jarSaveTestFn = null;
// 测试专用：server(api) 内 jarEnemyTier/enemyPool 挂载点，供 __jarEnemyTest 导出（强度分档 / 回合敌池）。
let __jarEnemyTestFn = null;
// 测试专用：setup(api) 内 jarReservedSlots/jarWrapPlayerHand 挂载点，供 __jarReservedTest 导出（障碍物待部署区独占格）。
let __jarReservedTestFn = null;

/** 给一场战斗挂「复活一次」kill 钩子（读取 jarReviveGrants；没有授予的战斗零开销直通）。 */
function jarAttachReviveHook(battle) {
  if (!battle || typeof battle.on !== 'function') return;
  battle.on('kill', (c) => {
    const u = c && c.victim;
    if (!u || u.side !== 'ally' || u.kind !== 'op' || !u.alive || u.bossPool) return;
    const bid = battle.battleId;
    if (!bid) return;
    const grants = jarReviveGrants.get(bid);
    const left = grants && grants.get(u.ownerId);
    if (!(left > 0)) return;
    grants.set(u.ownerId, left - 1);
    // kill()（deploy.js）：钩子处理器把 hp 写回正数 = 复活（不退场、不倒地、不占再部署）
    u.hp = u.s && Number.isFinite(u.s.maxHp) ? u.s.maxHp : 1;
    const ctx = jarReviveCtx.get(bid);
    if (ctx && typeof ctx.consume === 'function') ctx.consume(u.ownerId);
    else if (jarIsClient) jarReportReviveUsed(bid, u.ownerId);
  }, { owner: 'jar-revive' });
}

/** 给一场战斗挂「障碍物被摧毁」kill 钩子：带 jarObsOwner/jarObsTier 标签的箱子被敌人拆毁时，按归属移除持久记录并释放拥有数。
 *  服务端模拟直接回调 ctx.lost；客户端模拟发 g.jarObstacleLost 上报（服务端据此更新 match 状态，幂等）。 */
function jarAttachObstacleHook(battle) {
  if (!battle || typeof battle.on !== 'function') return;
  battle.on('kill', (c) => {
    const u = c && c.victim;
    if (!u || u.side !== 'ally' || !u.jarObsOwner || !u.jarObsTier) return; // 只处理打过标签的 jar 障碍物
    const ctx = jarObstacleCtx.get(battle.battleId);
    if (ctx && typeof ctx.lost === 'function') ctx.lost(u.jarObsOwner, u.jarObsTier, u.tileR, u.tileC);
    else if (jarIsClient) jarReportObstacleLost(u.jarObsTier, u.tileR, u.tileC);
  }, { owner: 'jar-obstacle' });
}

  /** 包装 createBattleFromSpec（双端各一次）：每场新建战斗都挂上复活钩子 + 障碍物摧毁钩子。 */
  function jarWrapSpecMod(specMod) {
    if (!specMod || specMod.__jarReviveWrapped || typeof specMod.createBattleFromSpec !== 'function') return;
    specMod.__jarReviveWrapped = true;
    const orig = specMod.createBattleFromSpec;
    specMod.createBattleFromSpec = function (spec, ds, opts) {
      const battle = orig.call(this, spec, ds, opts);
      try { jarAttachReviveHook(battle); } catch { /* ignore */ }
      try { jarAttachObstacleHook(battle); } catch { /* ignore */ }
      return battle;
    };
  }
if (jarIsClient) import('/sim/spec.js').then(jarWrapSpecMod).catch(() => {});
else import('../../server/sim/spec.js').then(jarWrapSpecMod).catch(() => {});

/** 客户端模拟下的消耗上报：n 为该 (battleId, playerId) 的累计次数（服务端按增量去重，重发安全）。 */
function jarReportReviveUsed(bid, pid) {
  if (!jarClientNet) return;
  const key = `${bid}|${pid}`;
  const n = (jarReviveUsedCount.get(key) || 0) + 1;
  jarReviveUsedCount.set(key, n);
  try { jarClientNet.request('g.jarReviveUsed', { battleId: bid, playerId: pid, n }).catch(() => {}); } catch { /* ignore */ }
}
/** 客户端：障碍物被摧毁 → 上报服务端移除持久记录 + 释放拥有数（服务端幂等：找不到记录则不扣）。 */
function jarReportObstacleLost(tier, r, c) {
  if (!jarClientNet) return;
  try { jarClientNet.request('g.jarObstacleLost', { item: tier === 'advanced' ? 'obstacleAdvanced' : 'obstacleBasic', row: r, col: c }).catch(() => {}); } catch { /* ignore */ }
}
/** 客户端：b.jarReviveGrant {battleId, playerId} —— 战斗开始 / 战斗中购入时的充能同步。 */
function jarOnReviveGrant(msg) {
  if (!msg || typeof msg.battleId !== 'string' || !msg.battleId || typeof msg.playerId !== 'string') return;
  let g = jarReviveGrants.get(msg.battleId);
  if (!g) jarReviveGrants.set(msg.battleId, (g = new Map()));
  g.set(msg.playerId, Math.max(g.get(msg.playerId) || 0, 1));
}

// 砸罐子：每个可部署格子一个罐子。罐子位置由服务端根据当前战场（normal / bossL / bossR）的可部署格子生成，
// 客户端把每个罐子投影到对应地图格子的屏幕坐标上。

/** Local pref of the lobby selection (survives reloads; applied to the server at every match start). */
function loadPref() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY);
    const v = raw ? JSON.parse(raw) : null;
    // 'shop' / 'enemy' 两个单开模式已于 2026-10-16 从大厅下掉（合并效果由 'all' 提供）：
    // 旧存档里存着它们 → 迁移回 'off'，否则会出现「没有任何卡片选中、模式却暗中生效」的幽灵状态。
    const mode = v && (v.mode === 'all' || v.mode === 'jar') ? v.mode : 'off';
    if (v && v.mode && v.mode !== mode) savePref({ mode });
    return { mode };
  } catch { return { mode: 'off' }; }
}
function savePref(pref) {
  try { globalThis.localStorage && globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
}

const THEME = {
  bg: 'var(--bg-0)',
  panel: 'var(--bg-2)',
  panel2: 'var(--bg-3)',
  text: 'var(--text-hi)',
  md: 'var(--text-md)',
  dim: 'var(--text-lo)',
  dim2: 'var(--text-dim)',
  accent: 'var(--mint-500)',
  accentA10: 'var(--mint-a10)',
  border: 'var(--line)',
  border2: 'var(--line-2)',
  onAccent: 'var(--text-on-mint)',
  display: 'var(--font-display)',
  danger: 'var(--red-premium)',
  gold: 'var(--gold-400, #f8c842)',
};
const cx = (...p) => p.flat().filter(Boolean).join(' ');

// ── module-level shared state (the overlay "brain" keeps it in sync; every consumer reads it) ──
const state = {
  mode: 'off',    // 盲盒：服务端状态（m.blindBoxState）—— 'off' | 'shop' | 'enemy' | 'all'
  creative: false, // 创造模式是否开启（m.creativeState）——开启时本插件让位（商店由它接管）
  reveal: null,    // { kind, id } — 刚开出的东西（开箱浮层）
};
const listeners = new Set();
function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((f) => f());
}
/** Hook: subscribe to the shared state. */
function useShared() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    return () => listeners.delete(f);
  }, []);
  return state;
}

export default {
  id: 'blindbox',
  name: '盲盒模式',
  version: '1.4.2',
  author: 'mod',
  // 与「创造模式」互斥：两者都接管休整期商店栏与对局 UI，同时启用会互相打架。启用本插件会自动卸下创造模式（反之亦然）。
  conflicts: ['creativemode'],
  description: '在主界面「模拟方式」处选择盲盒模式后，对局自动生效：商店盲盒（格子变盲盒、价格 = 底价 2 + 等级 - 1，即 1 级 2 资金、每升一级 +1）、敌人盲盒（普通波隐藏敌人情报、可花资金侦察出类型与数量）、砸罐子（休整期去掉商店，战场每个可部署格子上放一个罐子，砸开随机是干员（立刻可部署）/ 道具（立刻可用）/ 敌人（立刻破罐出战——休整期照常，敌人先于大部队进攻；点「准备」后本波敌人和罐中敌人合流）），或两者全开。服务端权威，全队一致。',

  setup(api) {
    const { store, net, data, html, toast, registerOverlay, registerShopOverride, registerLobbyEntry } = api;
    // 把本 MOD 的 C2S schema 也注册进浏览器那份 C2S 目录：net.request 会先用它本地校验，
    // 否则 g.blindBoxSet / g.scoutWave / g.smashJar 会在出门前就被拒（本地「无效的请求」）。
    if (typeof api.registerMessage === 'function') {
      for (const [name, schema] of Object.entries(C2S_MSGS)) api.registerMessage(name, schema);
    }
    // jar 商店·复活充能：客户端模拟下的授予同步 + 消耗上报通道（见文件顶部的双端机制）
    jarClientNet = net;
    net.on('b.jarReviveGrant', jarOnReviveGrant);

    // 预加载砸罐音效，避免首次点击时网络/解码延迟
    try { audio.preload([JAR_SFX_URL]); } catch { /* ignore */ }

    // ---- 大厅「开始独立模拟」先弹 jar 存档选择页（读取直接开战，新开才进准备页）----
    let jarStartSaveCtl = null; // { open, difficulty, onCreate, onDone, busy }
    const jarStartSaveSubs = new Set();
    const notifyJarStartSave = () => { for (const cb of jarStartSaveSubs) cb(); };
    const readJarPref = () => {
      try { const raw = localStorage.getItem(PREF_KEY); const p = raw ? JSON.parse(raw) : null; return p && p.mode ? p : { mode: 'off' }; } catch { return { mode: 'off' }; }
    };
    globalThis.__SP_JAR_START_SAVE__ = {
      isJarMode: () => readJarPref().mode === 'jar',
      open: ({ difficulty, onCreate, onDone }) => {
        jarStartSaveCtl = { open: true, difficulty, onCreate, onDone, busy: false };
        notifyJarStartSave();
      },
      close: () => { if (jarStartSaveCtl) { jarStartSaveCtl.open = false; notifyJarStartSave(); } }
    };

    const snapshot = () => {
      const s = store.get();
      const pub = s.match && s.match.public;
      const phase = pub && pub.phase;
      return { inMatch: !!(phase && phase !== 'LOBBY'), phase, me: s.me && s.me.playerId };
    };

    /** Headless brain: keeps the shared switch state in sync and auto-applies the lobby pref at match start. */
    function BlindBoxBrain() {
      const [, force] = useState(0);
      const s0 = snapshot();

      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);

      useEffect(() => {
        const onBox = (m) => {
          setState({ mode: m.mode || 'off' });
          // 让简化视图（fallbackField）在 enterBattle 时也能判断 jar 无休整期：game.js 调 enterBattle 可能早于 MOD 的 React effect。
          globalThis.__SP_JAR_COMBAT__ = (m.mode === 'jar');
        };
        // 创造模式开启时本插件让位（它的目录商店优先）
        const onCreative = (m) => setState({ creative: !!m.on });
        // 砸罐子：揭示单播内容（队友不可见），交给开箱浮层渲染
        const onJar = (m) => setState({ reveal: { kind: 'jar', jar: { id: m.id, kind: m.kind, opId: m.opId, enemyKey: m.enemyKey, itemId: m.itemId, buff: m.buff, amt: m.amt } } });
        net.on('m.blindBoxState', onBox);
        net.on('m.creativeState', onCreative);
        net.on('m.jarSmashed', onJar);
        return () => { net.off('m.blindBoxState', onBox); net.off('m.creativeState', onCreative); net.off('m.jarSmashed', onJar); };
      }, []);

      // entering a match: pull the current state once (page reload / late join)
      useEffect(() => {
        if (s0.inMatch) net.request('g.blindBoxGet', {}).catch(() => {});
      }, [s0.inMatch]);

      // 战斗挂载镜头接管（game.js 的 __SP_BATTLE_CAM__ 扩展点）：jar 模式保持全局布局视角、不拉近镜头；
      // 其它模式 / 卸下插件时恢复引擎默认。
      useEffect(() => {
        const jar = state.mode === 'jar';
        globalThis.__SP_BATTLE_CAM__ = jar ? () => ({ keep: true }) : null;
        return () => { if (globalThis.__SP_BATTLE_CAM__ && jar) globalThis.__SP_BATTLE_CAM__ = null; };
      }, [state.mode]);

      // jar 战斗中，原生拖拽的道具穿装发的是核心 g.equip（服务端 _gate() 只放行休整期）——这里在 net 层
      // 改写成插件自己的 g.jarEquip（ps.equip 记账 + battle.equipItem 立即生效）。仅战斗阶段改写，
      // 休整期照走核心路径（保留替换对话框的 replaceUid 语义）。卸下插件时还原。
      useEffect(() => {
        if (state.mode !== 'jar') return undefined;
        const orig = net.request.bind(net);
        net.request = (type, payload) => {
          if (type === 'g.equip') {
            const phase = store && store.get ? store.get().match?.public?.phase : null;
            if (phase === 'COMBAT') {
              const ru = payload && Number.isInteger(payload.replaceUid) ? payload.replaceUid : undefined;
              return orig('g.jarEquip', { itemUid: payload && payload.itemUid, targetUid: payload && payload.targetUid, replaceUid: ru });
            }
          }
          // jar 战斗中，原生的 g.sell（核心 _gate 只放行休整期）改写为 g.jarSell——战斗中售卖是本模式的正常玩法
          if (type === 'g.sell') {
            const phase = store && store.get ? store.get().match?.public?.phase : null;
            if (phase === 'COMBAT') return orig('g.jarSell', { uid: payload && payload.uid });
          }
          return orig(type, payload);
        };
        return () => { net.request = orig; };
      }, [state.mode]);

      // the lobby selection: apply the local pref at every match start (inMatch false → true)
      const wasInMatch = useRef(false);
      useEffect(() => {
        if (s0.inMatch && !wasInMatch.current) {
          const pref = loadPref();
          if (pref.mode && pref.mode !== 'off') net.request('g.blindBoxSet', { mode: pref.mode }).catch(() => {});
        }
        wasInMatch.current = s0.inMatch;
      }, [s0.inMatch]);

      // 卸下插件：把服务器上的模式也关掉，避免商店仍是盲盒价 / 敌人情报仍隐藏而界面已恢复官方栏
      useEffect(() => {
        const onMods = () => {
          if (modsOffMap()['blindbox'] && state.mode !== 'off') {
            setState({ mode: 'off' });
            net.request('g.blindBoxSet', { mode: 'off' }).catch(() => {});
          }
        };
        window.addEventListener(MODS_EVENT, onMods);
        return () => window.removeEventListener(MODS_EVENT, onMods);
      }, []);

      return null; // no UI of its own — the shop override / drawer (core) / reveal effect render everything
    }

    /** 侦听抽屉里「侦察」按钮派发的事件，向服务端请求侦察当前波次。 */
    function BlindScoutListener() {
      useEffect(() => {
        const onScout = () => {
          const s = store.get();
          const pub = s.match && s.match.public;
          const round = pub && pub.round;
          audio.sfx('click', { volume: 0.4 });
          net.request('g.scoutWave', { round }).catch(() => {});
        };
        window.addEventListener('sp:blind-scout', onScout);
        return () => window.removeEventListener('sp:blind-scout', onScout);
      }, []);
      return null;
    }

    /** 敌人盲盒的揭示特效：PREP → COMBAT 切换时闪一下「敌人来袭 · 揭示！」（敌人本就在战斗中自然出现）。 */
    function BlindRevealEnemy() {
      const [show, setShow] = useState(false);
      const prev = useRef(null);
      useEffect(() => store.subscribe(() => {
        const s = store.get();
        const phase = s.match && s.match.public && s.match.public.phase;
        if (prev.current && prev.current !== 'COMBAT' && phase === 'COMBAT' && enemyOn(state.mode)) {
          setShow(true);
          audio.sfx('levelup', { volume: 0.5 });
          setTimeout(() => setShow(false), 950);
        }
        prev.current = phase;
      }), []);
      if (!show) return null;
      return html`<div style=${{ position: 'fixed', inset: 0, zIndex: 88, display: 'grid', placeItems: 'center',
        pointerEvents: 'none', background: 'rgba(6, 8, 7, .35)' }}>
        <div style=${{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: '.5rem', letterSpacing: '.3em',
          color: 'var(--mint-300)', textShadow: '0 0 .3rem rgba(35, 249, 183, .5)', opacity: .92 }}>敌人来袭 · 揭示！</div>
      </div>`;
    }

    /** 无尽模式·小型首领登场横幅（#62，用户选「原生立绘横幅」）：顶部滑入一条横幅，显示小型首领的本地原生
     *  Arknights 立绘 + 名字 + 高血量威胁提示，数秒后淡出。优先加载 public/assets/blindbox-boss-<key>.png 覆盖位
     *  （用户日后手放 prts.wiki 立绘即自动生效）；该文件不存在时 onError 回退到引擎原生敌人图标（enemyIconUrl）。
     *  立绘资源：prts.wiki 图片 CDN 反爬（带 UA+Referer 仍 403），故不自动爬，改用引擎本地原生立绘。 */
    function JarMiniBossBanner() {
      const [info, setInfo] = useState(null); // { key, name, round }
      const [shown, setShown] = useState(false);
      const assets = data && data.get ? data.get('assets') : null;
      useEffect(() => {
        const onMini = (msg) => {
          if (state.mode !== 'jar' || !msg || !msg.key) return;
          setInfo({ key: msg.key, name: msg.name || msg.key, round: msg.round });
          setShown(false);
          audio.sfx('levelup', { volume: 0.55 });
        };
        net.on('m.jarMiniBoss', onMini);
        return () => net.off('m.jarMiniBoss', onMini);
      }, []);
      useEffect(() => {
        if (!info) return undefined;
        const raf = requestAnimationFrame(() => setShown(true)); // 下一帧切到「显示态」触发滑入过渡
        const hide = setTimeout(() => setShown(false), 3000);
        const clear = setTimeout(() => setInfo(null), 3400);
        return () => { cancelAnimationFrame(raf); clearTimeout(hide); clearTimeout(clear); };
      }, [info]);
      if (!info) return null;
      const override = `/assets/blindbox-boss-${info.key}.png`;
      const native = enemyIconUrl(assets, info.key);
      const onErr = (e) => { if (native && e.currentTarget.src !== native) e.currentTarget.src = native; };
      return html`
        <div data-test="jar-miniboss-banner" style=${{ position: 'fixed', left: '50%', top: '.16rem',
          transform: `translateX(-50%) translateY(${shown ? '0' : '-.32rem'})`,
          opacity: shown ? 1 : 0, pointerEvents: 'none',
          transition: 'opacity .38s var(--ease-out), transform .42s var(--ease-out)', zIndex: 92 }}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '.16rem', padding: '.13rem .26rem',
            background: 'linear-gradient(180deg, rgba(30,16,18,.97), rgba(18,10,12,.98))',
            border: '1px solid var(--red-premium)', borderRadius: '.1rem',
            boxShadow: '0 0 .5rem rgba(232, 64, 64, .35)' }}>
            <img src=${override} alt=${info.name} onError=${onErr}
              style=${{ width: '1.08rem', height: '1.08rem', objectFit: 'contain', flex: '0 0 auto' }} />
            <div style=${{ display: 'flex', flexDirection: 'column', gap: '.03rem' }}>
              <span style=${{ fontFamily: THEME.display, fontSize: '.12rem', letterSpacing: '.2em', color: 'var(--red-premium)' }}>小型首领登场</span>
              <span style=${{ fontFamily: THEME.display, fontSize: '.22rem', fontWeight: 900, color: THEME.text }}>${info.name}</span>
              <span style=${{ fontSize: '.12rem', color: THEME.dim }}>高血量 · 漏过进点 −5 生命 · 每 10 回合出现</span>
            </div>
          </div>
        </div>`;
    }

    /** 一张盲盒卡：看不到里面是什么，只有价格。两段点击（第一次确认，第二次买下）。
     *  尺寸与官方 scard（1.56rem × 2.24rem）完全一致，并复用 is-armed / is-frozen / is-disabled 行为。 */
    function BlindCard({ slot, idx, armed, poor, frozen, onTap }) {
      const price = Number(slot?.price) || 0;
      const boxStyle = {
        position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '.04rem', textAlign: 'center', cursor: poor ? 'not-allowed' : 'pointer',
        background: armed
          ? 'linear-gradient(180deg, rgba(35, 46, 41, .96), rgba(15, 22, 19, .98))'
          : 'linear-gradient(180deg, rgba(28, 34, 31, .92), rgba(13, 16, 15, .94))',
        border: `1px solid ${armed ? THEME.accent : THEME.border2}`,
        boxShadow: armed ? '0 0 0 1px rgba(78, 216, 175, .22), inset 0 0 .7rem rgba(23, 249, 183, .06)' : 'none',
        opacity: poor ? 0.55 : 1,
      };
      return html`
        <button type="button" class=${`scard scard--blind ${armed ? 'is-armed' : ''} ${frozen ? 'is-frozen' : ''} ${poor ? 'is-disabled' : ''}`}
          onClick=${() => !poor && onTap(idx)}
          aria-pressed=${String(!!armed)} aria-label=${`盲盒 ${idx + 1}，价格 ${price}`}
          style=${{ ...boxStyle, padding: 0, color: 'inherit' }}>
          <span aria-hidden="true" style=${{ width: '.5rem', height: '.5rem', display: 'grid', placeItems: 'center',
            background: armed ? THEME.accentA10 : '#0c0f0e', border: `1px solid ${armed ? THEME.accent : THEME.border2}`,
            color: armed ? THEME.accent : THEME.dim2,
            clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)' }}>
            <svg viewBox="0 0 24 24" style=${{ width: '.26rem', height: '.26rem' }} aria-hidden="true">
              <path d="M3 8l9-5 9 5v9l-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="1.6" />
              <path d="M12 3v18M3 8l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.1" />
            </svg>
          </span>
          <span style=${{ fontFamily: THEME.display, fontSize: '.15rem', letterSpacing: '.1em',
            color: armed ? THEME.accent : THEME.dim }}>${armed ? '确认开启' : '盲盒'}</span>
          <span style=${{ fontFamily: THEME.display, fontSize: '.13rem', color: poor ? THEME.danger : THEME.gold }}>
            ${price} 资金
          </span>
        </button>`;
    }

    /** 盲盒商店栏：官方布局（工具行 + 等级卡 + 卡片 + 资金），只把卡片换成盲盒。 */
    function BlindBar(props) {
      const { priv, editable, onBuy, onLevel, onRefresh, onFreeze, onCollapse, barRef } = props;
      const shop = priv?.shop || {};
      const slots = Array.isArray(shop.slots) ? shop.slots : [];
      const funds = Number(priv?.funds) || 0;
      const remaining = Math.max(0, (priv?.deployCap ?? 8) - (priv?.deployCount ?? 0));
      const frozen = !!shop.frozen;
      const lv = shop.level ?? 1;
      // 单价不在这里算：盲盒价是服务端权威的，直接取服务端下发的第一格价格（每格同价）。
      const boxPriceShown = Number((slots.find((s) => s && !s.sold) || slots[0])?.price) || 0;
      const maxLevel = shop.maxLevel ?? 6;
      const max = lv >= maxLevel;
      const upPrice = Number(shop.upgradePrice) || 0;
      const refPrice = Number(shop.refreshPrice) || 1;
      const free = Number(shop.freeRefreshes) || 0;
      const [armed, setArmed] = useState(null); // two-tap: armed slot index
      const [, forceRender] = useState(0);
      useEffect(() => store.subscribe(() => forceRender((n) => n + 1)), []);

      // a shop change (reroll, sale, level up) invalidates the armed card
      const sig = slots.map((s) => (s ? `${s.id}:${s.sold ? 1 : 0}` : '-')).join('|');
      useEffect(() => { setArmed(null); }, [sig]);

      const buy = async (idx) => {
        const s = slots[idx];
        if (!s) return;
        setArmed(null);
        try {
          const r = onBuy(idx);
          if (r && typeof r.then === 'function') await r;
          setState({ reveal: { kind: s.kind === 'item' ? 'item' : 'chess', id: s.id } });
          audio.sfx('levelup', { volume: 0.5 });
        } catch (e) {
          toast('购买失败：' + ((e && e.message) || '未知错误'), 'error');
        }
      };

      const tapCard = (idx) => {
        const s = slots[idx];
        if (!s || s.sold) return;
        const poor = funds < (Number(s.price) || 0);
        if (poor) { toast('资金不足', 'warn'); return; }
        if (armed !== idx) { audio.sfx('click', { volume: 0.4 }); setArmed(idx); return; }
        buy(idx);
      };

      const chessSlots = slots.map((s, i) => ({ s, i })).filter(({ s }) => !s || s.kind !== 'item');
      const itemSlots = slots.map((s, i) => ({ s, i })).filter(({ s }) => s && s.kind === 'item');

      return html`
        <section class=${'shopbar'} aria-label=${'盲盒商店'} ref=${barRef}>
          <div class="shopbar__tools">
            <span class="shopbar__remain">${'剩余可放置角色：'}<b class="num">${remaining}</b></span>
            <button type="button" class=${`toolbtn toolbtn--ice${frozen ? ' is-on' : ''}`} disabled=${!editable}
              onClick=${() => { audio.sfx('freeze', { volume: 0.4 }); onFreeze(); }}>
              <span>${frozen ? '解冻' : '冻结'}</span>
            </button>
            <button type="button" class="toolbtn toolbtn--amber" disabled=${!editable}
              onClick=${() => { audio.sfx('refresh', { volume: 0.4 }); onRefresh(); }}>
              <span>${'刷新'}</span>
              ${free > 0 ? html`<span class="toolbtn__free">${`免费 ×${free}`}</span>`
                : html`<span style=${{ fontSize: '.12rem', color: THEME.gold }}>${refPrice}</span>`}
            </button>
            <span style=${{ fontSize: '.11rem', color: THEME.accent, letterSpacing: '.08em' }}>
              ${`盲盒 · 每个 ${boxPriceShown} 资金`}
            </span>
          </div>
          <div class="shopbar__row">
            <button type="button" class=${`lvcard${max ? ' is-max' : ''}`} disabled=${!editable || max}
              onClick=${() => { audio.sfx('click', { volume: 0.4 }); onLevel(); }}
              style=${{ cursor: editable && !max ? 'pointer' : 'default' }}>
              ${!max ? html`<span class="lvcard__price" style=${{ fontSize: '.12rem', color: THEME.gold }}>${upPrice}</span>` : null}
              <span class="lvcard__frame">
                <span class="lvcard__micro">LEVEL</span>
                <b class="lvcard__num num">${lv}</b>
              </span>
              <span class="lvcard__label">${max ? '已满级' : '升级'}</span>
            </button>
            <div class="shopbar__cards">
              ${chessSlots.map(({ s, i }) => (s && s.sold
                ? html`<${SoldCard} key=${`s${i}`} />`
                : html`<${BlindCard} key=${`b${i}:${s ? s.id : ''}`} slot=${s} idx=${i} frozen=${frozen}
                    armed=${armed === i} poor=${!!s && funds < (Number(s.price) || 0)} onTap=${tapCard} />`))}
            </div>
            <div class="shopbar__item">
              ${itemSlots.length
                ? itemSlots.map(({ s, i }) => html`<${BlindCard} key=${`bi${i}:${s.id}`} slot=${s} idx=${i} frozen=${frozen}
                    armed=${armed === i} poor=${funds < (Number(s.price) || 0)} onTap=${tapCard} />`)
                : html`<${SoldCard} item=${true} />`}
            </div>
            <div class="funds">
              <div class="funds__hex">
                <b class="funds__num num">${funds}</b>
              </div>
              <span class="funds__label">${'目前资金'}</span>
              <button type="button" class="funds__collapse" onClick=${() => onCollapse(true)}>${'收起'}</button>
            </div>
          </div>
        </section>`;
    }

    /** The shop-bar replacement: takes over only while the shop mode is on and 创造模式 is off — otherwise the chain's
     *  next renderer (the other MOD's override, or the official bar) decides. The enemy mode does NOT touch the shop.
     *  jar 模式彻底取代商店栏（用户确认不保留商店），渲染 JarBar。 */
    function BlindShop(props) {
      const st = useShared();
      const showReward = !!(props.reward && Array.isArray(props.reward.slots) && props.reward.slots.length);
      // 砸罐子模式：整排罐子取代商店（创造模式接管时仍让位，避免两套栏位冲突）
      if (jarOn(st.mode) && !st.creative && !props.collapsed && !showReward) {
        return html`<${JarBar} ...${props} />`;
      }
      // 奖励三选一 / 折叠态 / 创造模式接管 / 砸罐子外未选商店盲盒 → 让位（范围只限休整期商店栏，其余一切照旧）
      if (!shopOn(st.mode) || st.creative || props.collapsed || showReward) {
        return props.next ? html`<${props.next} ...${props} />` : html`<${ShopBar} ...${props} />`;
      }
      return html`<${BlindBar} ...${props} />`;
    }

    /** 砸罐子（jar 模式）的一只罐子（地图模式）：被放在由 JarField 计算好绝对定位的容器里，这里只画罐身、填满父容器。
     *  罐身用从 prts.wiki 取的「彩瓷花瓶」图标，经 AI 抠图（去棕色背景、保留瓶身与把手）成透明 PNG（public/assets/blindbox-jar.png），贴在地图格子上不露底；
     *  借用了 .scard 类（E2E / 测试靠 .scard--jar 找罐子），但用内联样式覆盖布局。砸罐音效见文件顶部 JAR_SFX_URL（e_imp_mirror.mp3，玻璃/镜面破碎感）。 */
    function Jar({ jar, onSmash }) {
      const size = { width: '100%', height: '100%', justifyContent: 'center', alignContent: 'center',
        gridTemplateColumns: '1fr', gridTemplateRows: 'minmax(0, 1fr) auto', padding: '.04rem' };
      if (jar.smashed) {
        // 已砸开：什么都不渲染——地上不留残骸标识，罐子层里也没有这个格子对应的槽位，
        // 点击全部落到下面战场的部署格上（玩家可直接把干员放到这个格子上）。
        return null;
      }
      return html`<button type="button" class="scard scard--jar"
        onClick=${() => onSmash(jar.id)}
        aria-label="罐子（点击砸开）"
        style=${{ ...size, display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0,
          background: 'transparent', border: 'none', position: 'relative', overflow: 'visible' }}>
        <img src="/assets/blindbox-jar.png" alt="罐子" draggable=${false}
          style=${{ height: '100%', width: 'auto', maxWidth: '100%', objectFit: 'contain',
            filter: 'drop-shadow(0 .05rem .12rem rgba(0,0,0,.55))' }} />
      </button>`;
    }

    /** jar 商店商品图标：/assets/jar-shop-<kind>.png 覆盖位（prts 素材由用户手放，与 blindbox-boss-<key>.png 同一约定），
     *  加载失败回退内置图标。kind: 'deploy' | 'life' | 'revive' | 'obstacleBasic' | 'obstacleAdvanced'。
     *  障碍物素材取自 prts.wiki「障碍物」词条：basic=装置立绘(头像_装置_障碍物)。
     *  高级障碍物与初级共用同一张灰色路障立绘（用户 2026-10-17：展示框里高级不要用地雷样式，要初级的灰色样子），
     *  档位差异由卡面等级徽标（IV / tier 4 金色六边形）与价格体现，不再单给一张异形素材。 */
    function JarShopIcon({ kind }) {
      const src = kind === 'obstacleAdvanced' ? '/assets/jar-shop-obstacleBasic.png' : `/assets/jar-shop-${kind}.png`;
      const fallbacks = { deploy: 'users', life: 'shield', revive: 'refresh', obstacleBasic: 'lock', obstacleAdvanced: 'lock' };
      return html`<${Img} src=${src} alt="" style=${{ width: '100%', height: '100%', objectFit: 'contain', filter: 'none' }}
        fallback=${html`<${Icon} name=${fallbacks[kind] || 'bolt'} style=${{ width: '.6rem', height: '.6rem' }} />`} />`;
    }

    /** jar 商店商品卡：做成原生道具购买卡片样式（scard--item），含等级徽标、价格六边形、图标、名称、描述；
     *  点击直接购买（服务端权威扣费与生效）。 */
    function JarShopCard({ kind, label, desc, price, soldout, disabled, onBuy, tier = 2, soldoutText }) {
      const afford = !soldout && !disabled;
      if (soldout) {
        const sold = soldoutText || '已购买';
        return html`<div class=${cx('scard', 'scard--item', 'scard--sold')} aria-label=${`${label}，${sold}`}>
          <span class="scard__soldtxt"><span>${'SOLD OUT'}</span><span>${sold}</span></span>
        </div>`;
      }
      return html`<button type="button"
        class=${cx('scard', 'scard--item', !afford && 'is-disabled')}
        disabled=${!afford}
        onClick=${(e) => { e.preventDefault(); if (afford) { audio.sfx('click', { volume: 0.4 }); onBuy(); } }}
        title=${`${label}（${price} 资金）—— ${desc}`}
        aria-label=${`${label}，价格 ${price} 资金。${desc}`}>
        <span class="scard__bg" aria-hidden="true"></span>
        <span class="scard__top">
          <${TierChip} tier=${tier} size="md" />
          <${HexBadge} value=${price} tone=${disabled ? 'dark' : 'gold'} size="md" class="scard__price" title=${`价格 ${price} 资金`} />
        </span>
        <span class="scard__itemart">
          <${JarShopIcon} kind=${kind} />
        </span>
        <span class="scard__body">
          <span class="scard__name">${label}</span>
          <span class="scard__idesc">${desc}</span>
        </span>
      </button>`;
    }


    /** 砸罐子（jar 模式）的休整期底栏：商店已彻底去掉，只留「升级（调度中心）+ 资金」两样。 */
    function JarBar(props) {
      const { priv, editable, onLevel, onCollapse, barRef, onDetail, onDetailClose } = props;
      const shop = priv?.shop || {};
      const funds = Number(priv?.funds) || 0;
      const lv = shop.level ?? 1;
      const maxLevel = shop.maxLevel ?? 6;
      const max = lv >= maxLevel;
      const upPrice = Number(shop.upgradePrice) || 0;
      const st = useShared();
      const [, setForceRender] = useState(0); // 只为订阅 store 后强制重渲染（资金 / 罐子变化）
      useEffect(() => store.subscribe(() => setForceRender((n) => n + 1)), []);
      // jar 商店：三件商品（部署位 / 生命 / 复活一次），价格与已购态由服务端 priv.jarShop 下发
      const js = priv?.jarShop || null;
      const buy = (item) => { net.request('g.jarShopBuy', { item }).catch(() => {}); };
      const canBuy = (price) => editable && js && price != null && funds >= price;
      // 合并精锐的「晋升奖励」三选一（用户要求保留）：直接复用原生 RewardCards（和普通商店同一套呈现：
      // rwtag 头 + 标准干员大卡 + 两段点击 + 「稍后」pill）——原生底栏被 jar 替换、RewardOverlay 又只在
      // PREP 渲染（jar 无休整期），故这里自己挂载；offer 存在即显示，选一个（g.reward）或回合结束
      // （endPrep 清 offers）后消失。offer 出现期间让位给奖励卡（jar 商店卡暂时收起，选完再回来）。
      const offer = priv?.shop?.rewardOffer || null;
      const showReward = !!(offer && Array.isArray(offer.slots) && offer.slots.length);
      const [rwMin, setRwMin] = useState(false); // 「稍后选择」：收起成 pill，点 pill 唤回
      const rwKeys = useMemo(() => {
        const set = new Set();
        if (showReward) for (const [i, sl] of offer.slots.entries()) if (sl && !sl.sold) set.add(armKey('r', i, sl));
        return set;
      }, [showReward, offer && offer.slots && offer.slots.map((x) => x && x.id).join(',')]);
      const [armed, setArmed] = useTwoTap({ editable, keys: rwKeys });
      // 走原生活动通道（actions.reward → act）：成功播 pick 音效，失败 toast ERR_TEXT（不再 .catch 静默吞错）
      const pickReward = (i) => { actions && actions.reward ? actions.reward(i) : net.request('g.reward', { idx: i }).catch(() => {}); };
      /** 第一段武装 + 开详情，第二段确认选取（与原生 ShopBar 的 tapCard 同构）。 */
      const tapReward = (kind, idx, slot, detailKind, reason, buy2) => {
        const key = armKey('r', idx, slot);
        if (armed !== key) {
          setArmed(key);
          if (onDetail) onDetail(slot.id, detailKind, null);
          return;
        }
        if (reason) { if (props.onRefuse) props.onRefuse(reason); return; }
        setArmed(null);
        if (onDetailClose) onDetailClose();
        buy2(idx);
      };
      return html`
        <section class=${'shopbar'} aria-label=${'砸罐子'} ref=${barRef}>
          ${rwMin && showReward ? html`<${RewardOverlay} priv=${priv} minimized=${true} onMinimize=${(m) => setRwMin(!!m)} />` : null}
          <div class="shopbar__tools">
            <span style=${{ gridColumn: '1 / -1', justifySelf: 'end', fontSize: '.14rem', color: THEME.accent,
              letterSpacing: '.08em', padding: '.02rem .1rem', background: 'rgba(8,11,10,.78)' }}>
              ${'砸罐子模式 · 无商店；敌人全部来自罐子（砸开 5 秒后出战）；敌人随回合逐步变强 · 干员 / 道具拿到就能用'}
            </span>
          </div>
          <div class="shopbar__row" style=${{ gap: '.16rem', alignItems: 'center' }}>
            ${showReward && !rwMin ? html`<${RewardCards} offer=${offer} priv=${priv} editable=${editable}
              onPick=${pickReward} onDetail=${(id, kind, hint) => onDetail && onDetail(id, kind, hint)}
              onLater=${() => setRwMin(true)} armed=${armed} onTap=${tapReward} offBonds=${null} />` : null}
            <button type="button" class=${`lvcard${max ? ' is-max' : ''}`} disabled=${!editable || max}
              onClick=${() => { audio.sfx('click', { volume: 0.4 }); onLevel && onLevel(); }}
              title=${max ? '调度中心已满级' : `升级调度中心（${upPrice} 资金）`}
              style=${{ cursor: editable && !max ? 'pointer' : 'default' }}>
              ${!max ? html`<span class="lvcard__price" style=${{ fontSize: '.12rem', color: THEME.gold }}>${upPrice}</span>` : null}
              <span class="lvcard__frame">
                <span class="lvcard__micro">LEVEL</span>
                <b class="lvcard__num num">${lv}</b>
              </span>
              <span class="lvcard__label">${max ? '已满级' : '升级'}</span>
            </button>
            ${js && !showReward ? html`
              <${JarShopCard} kind="deploy" label=${'部署位 +1'} price=${js.priceSlot} soldout=${js.priceSlot == null}
                disabled=${!canBuy(js.priceSlot)} onBuy=${() => buy('slot')} tier=${2}
                desc=${`可同时部署的干员数 +1（当前 ${js.cap}，最多买 2 次）`} />
              <${JarShopCard} kind="life" label=${'生命 +1'} price=${js.priceLife} soldout=${false}
                disabled=${!canBuy(js.priceLife)} onBuy=${() => buy('life')} tier=${3}
                desc=${`生命值永久 +1（当前 ${js.lp}，越买越贵）`} />
              <${JarShopCard} kind="revive" label=${'复活一次'} price=${js.priceRevive} soldout=${js.revive > 0}
                disabled=${!canBuy(js.priceRevive)} onBuy=${() => buy('revive')} tier=${4}
                desc=${'下次干员被击倒时原地满血复活，整局仅一件'} />
              <${JarShopCard} kind="obstacleBasic" label=${'初级障碍物'} price=${js.priceObstacleBasic} soldout=${js.priceObstacleBasic == null}
                disabled=${!canBuy(js.priceObstacleBasic)} onBuy=${() => buy('obstacleBasic')} tier=${2}
                soldoutText=${'库存已满（可补买）'}
                desc=${`库存 ${js.obsBasic}/3 · 战斗中可手动部署 3000 血路障，被摧毁后可再买`} />
              <${JarShopCard} kind="obstacleAdvanced" label=${'高级障碍物'} price=${js.priceObstacleAdvanced} soldout=${js.priceObstacleAdvanced == null}
                disabled=${!canBuy(js.priceObstacleAdvanced)} onBuy=${() => buy('obstacleAdvanced')} tier=${4}
                soldoutText=${'库存已满（可补买）'}
                desc=${`库存 ${js.obsAdvanced}/3 · 战斗中可手动部署 6000 血路障，被摧毁后可再买`} />
            ` : null}
            <div class="funds">
              <div class="funds__hex">
                <b class="funds__num num">${funds}</b>
              </div>
              <span class="funds__label">${'目前资金'}</span>
              <button type="button" class="funds__collapse" onClick=${() => onCollapse(true)}>${'收起'}</button>
            </div>
          </div>
        </section>`;
    }

    /** 砸罐子：把已购障碍物投影到「待部署区」空格上，可**拖拽**到战场合法格部署（仿干员拖拽）。
     *  引擎没有"可部署设备棋子"，故 overlay 投影到整备区空格 + 自实现指针拖拽（指针捕获 + 鬼物 + 屏幕→格子反查），不碰原生 hand / invariants。 */
    function JarObstacleDeploy() {
      const [, force] = useState(0);
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const s = store.get();
      const pub = s.match && s.match.public;
      const priv = s.match && s.match.private;
      const js = priv && priv.jarShop;
      const combat = !!(pub && (pub.phase === 'COMBAT' || pub.phase === 'UNITE')); // 联防阶段障碍物照常可拖放
      const layerRef = useRef(null);
      const ghostRef = useRef(null);
      const dragRef = useRef(null); // { tier, icon }
      const basicReserve = js ? Math.max(0, (Number(js.obsBasic) || 0) - (Number(js.obsBasicPlaced) || 0)) : 0;
      const advReserve = js ? Math.max(0, (Number(js.obsAdvanced) || 0) - (Number(js.obsAdvancedPlaced) || 0)) : 0;
      const chips = [];
      for (let i = 0; i < basicReserve; i++) chips.push({ key: `b${i}`, tier: 'obstacleBasic', icon: '/assets/jar-shop-obstacleBasic.png', adv: false });
      // 高级障碍物与初级共用同一张灰色路障立绘（用户 2026-10-17），档位靠金色边框 / 灰度区分。
      for (let i = 0; i < advReserve; i++) chips.push({ key: `a${i}`, tier: 'obstacleAdvanced', icon: '/assets/jar-shop-obstacleBasic.png', adv: true });
      // 投影到整备区空格：优先使用服务端预留给障碍物的槽位（jarReservedSlots），保证障碍物独占一格、不与道具共享；
      // 预留表缺失时回退到「占用 priv.hand 为空的槽位」。
      const hand = Array.isArray(priv && priv.hand) ? priv.hand : [];
      let slots = [];
      if (js && Array.isArray(js.reservedSlots) && js.reservedSlots.length) {
        for (let i = 0; i < chips.length && i < js.reservedSlots.length; i++) slots.push(js.reservedSlots[i]);
      } else {
        for (let i = 0; i < JAR_HAND_SIZE && slots.length < chips.length; i++) if (!hand[i]) slots.push(i);
      }
      // 每帧把棋子贴到整备区空格（跟随平移 / 缩放），与 JarLayer 同机制
      useEffect(() => {
        let raf = 0;
        const tick = () => {
          const view = globalThis.__SP_VIEW__;
          const layer = layerRef.current;
          if (view && view.tileScreen && layer) {
            const nodes = layer.querySelectorAll('[data-hslot]');
            for (let k = 0; k < nodes.length; k++) {
              const node = nodes[k];
              const col = Number(node.dataset.hslot);
              const scr = view.tileScreen(JAR_HAND_ROW, col);
              if (!scr || !Number.isFinite(scr.x) || !Number.isFinite(scr.y)) { node.style.display = 'none'; continue; }
              const poly = scr.poly || null;
              const tpx = poly ? Math.abs(poly[1][0] - poly[0][0]) : (scr.s || 36);
              // 占满整个整备格（与干员/道具棋子同等大小），让障碍物视觉上「独占一个格子」。
              const size = Math.max(24, tpx);
              node.style.display = 'flex';
              node.style.width = size + 'px'; node.style.height = size + 'px';
              node.style.left = (scr.x - size / 2) + 'px'; node.style.top = (scr.y - size / 2) + 'px';
            }
            // 高级障碍物战场贴皮：读 runner 存活障碍格子，advanced 档投影灰色贴皮 + 金环边框（盖在引擎原生木箱上，初级不贴 → 战场上区分）；
            // 该格被敌人/干员占用（拆箱中）时隐藏贴皮，避免 DOM 层盖住单位。
            const R = globalThis.__SP_RUNNER__;
            const advTiles = (R && typeof R.jarObstacleTiles === 'function') ? R.jarObstacleTiles().filter((t) => t && t.tier === 'advanced') : [];
            const occ = (R && typeof R.jarOccupants === 'function') ? R.jarOccupants() : [];
            const skins = layer.querySelectorAll('[data-hskin]');
            for (let k = 0; k < skins.length; k++) {
              const node = skins[k];
              const t = advTiles[k];
              if (!t) { node.style.display = 'none'; continue; }
              const busy = occ.some((o) => o.row === t.row && o.col === t.col);
              if (busy) { node.style.display = 'none'; continue; }
              const mscr = view.tileScreen(t.row, t.col);
              if (!mscr || !Number.isFinite(mscr.x) || !Number.isFinite(mscr.y)) { node.style.display = 'none'; continue; }
              const mpoly = mscr.poly || null;
              const mtpx = mpoly ? Math.abs(mpoly[1][0] - mpoly[0][0]) : (mscr.s || 36);
              // 箱子是 0.84×0.74（tile）的 3D 盒，向上探出半格以上；贴皮放大并上移以完整盖住原生木箱，避免棕色透出。
              const msize = Math.max(28, mtpx * 1.28);
              node.style.display = 'block';
              node.style.width = msize + 'px'; node.style.height = msize + 'px';
              node.style.left = (mscr.x - msize / 2) + 'px'; node.style.top = (mscr.y - msize * 0.64) + 'px';
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [chips.length, slots.join(',')]);
      // 屏幕(client)坐标 → 战场格子：投影全棋盘 + 点在多边形内测试（tileScreen 的 poly 是 client 坐标）；跳过整备区/临时区行（落在那里=取消）
      const tileAtClient = (cx, cy) => {
        const view = globalThis.__SP_VIEW__;
        if (!view || !view.tileScreen) return null;
        for (let r = 0; r < JAR_ROWS; r++) {
          if (r === JAR_HAND_ROW || r === JAR_HAND_ROW + 1) continue;
          for (let c = 0; c < JAR_COLS; c++) {
            const scr = view.tileScreen(r, c);
            if (scr && scr.poly && jarPointInPoly(cx, cy, scr.poly)) return { row: r, col: c };
          }
        }
        return null;
      };
      const ghostTo = (cx, cy) => { const g = ghostRef.current; if (g) { g.style.left = cx + 'px'; g.style.top = cy + 'px'; } };
      const onDown = (e, chip) => {
        if (!combat) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        dragRef.current = { tier: chip.tier, icon: chip.icon };
        const g = ghostRef.current;
        if (g) { const im = g.querySelector('img'); if (im) im.src = chip.icon; g.style.display = 'block'; g.style.border = chip.adv ? '2px solid #e0c266' : 'none'; g.style.borderRadius = '.06rem'; g.style.background = 'rgba(10,12,10,.35)'; }
        ghostTo(e.clientX, e.clientY);
        audio.sfx('click', { volume: 0.3 });
      };
      const onMove = (e) => { if (dragRef.current) ghostTo(e.clientX, e.clientY); };
      const onUp = (e) => {
        const d = dragRef.current;
        if (!d) return;
        dragRef.current = null;
        const g = ghostRef.current; if (g) g.style.display = 'none';
        const tile = tileAtClient(e.clientX, e.clientY);
        if (tile) net.request('g.jarDeployDevice', { item: d.tier, row: tile.row, col: tile.col }).catch(() => {});
        force((n) => n + 1);
      };
      if (!js || !chips.length) return null;
      const chipStyle = (adv) => ({
        position: 'absolute', display: 'none', pointerEvents: combat ? 'auto' : 'none', alignItems: 'center', justifyContent: 'center',
        // 实心底板 + 边框：占满整备格，视觉上与干员/道具棋子一样「独占一个格子」（不再只浮一个小图标）。
        background: adv ? 'rgba(46,36,12,.96)' : 'rgba(20,25,23,.96)',
        border: `2px ${adv ? 'solid #e0c266' : 'solid rgba(150,170,150,.85)'}`, borderRadius: '.06rem',
        cursor: combat ? 'grab' : 'default', opacity: combat ? 1 : .55, touchAction: 'none',
        boxShadow: adv ? '0 0 0 1px rgba(224,194,102,.4)' : 'inset 0 0 0 1px rgba(0,0,0,.35)',
      });
      return html`
        <div ref=${layerRef} style=${{ position: 'fixed', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
          ${chips.map((chip, i) => html`<button key=${chip.key} type="button" data-hslot=${slots[i]} data-test=${`jar-obs-${chip.tier}`}
            disabled=${!combat}
            title=${combat ? `${chip.tier === 'obstacleBasic' ? '初级' : '高级'}障碍物 · 拖拽到战场合法格放置` : '障碍物（战斗中可拖拽部署）'}
            style=${chipStyle(chip.adv)}
            onPointerDown=${(e) => onDown(e, chip)} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp}>
            <${Img} src=${chip.icon} alt="" style=${{ width: '66%', height: '66%', objectFit: 'contain', pointerEvents: 'none',
              filter: chip.adv ? 'grayscale(100%)' : 'none' }}
              fallback=${html`<${Icon} name="lock" style=${{ width: '.5rem', height: '.5rem' }} />`} />
          </button>`)}
          ${[0, 1, 2, 3, 4, 5].map((k) => html`<div key=${'hs' + k} data-hskin=${k} style=${{ position: 'absolute', display: 'none', pointerEvents: 'none' }}>
            <${Img} src="/assets/jar-shop-obstacleBasic.png" alt="" style=${{ width: '100%', height: '100%', objectFit: 'fill', borderRadius: '.04rem',
              border: '2px solid #e0c266', boxSizing: 'border-box',
              filter: 'grayscale(100%) brightness(0.92) contrast(1.08) drop-shadow(0 2px 3px rgba(0,0,0,.55))' }} fallback=${html`<${Icon} name="lock" style=${{ width: '.5rem', height: '.5rem' }} />`} />
          </div>`)}
        </div>
        <div ref=${ghostRef} style=${{ position: 'fixed', display: 'none', pointerEvents: 'none', zIndex: 70,
          transform: 'translate(-50%, -50%)', width: '2.2rem', height: '2.2rem' }}>
          <${Img} src=${chips[0] ? chips[0].icon : ''} alt="" style=${{ width: '100%', height: '100%', objectFit: 'contain', filter: 'drop-shadow(0 3px 5px rgba(0,0,0,.65))' }} fallback=${html`<${Icon} name="lock" />`} />
        </div>`;
    }

    /** 砸罐子：多档存档/读档。存=快照当前成长进度；读=发 g.jarLoadSave，下一波 startRound 生效。
     *  存储：localStorage「sp.jar.saves.v1」（origin 作用域、与插件生命周期无关 → 卸载插件不丢失）；另支持导出/导入 .json 做终极备份。 */
    const JAR_SAVES_KEY = 'sp.jar.saves.v1';
    const jarReadSaves = () => { try { return JSON.parse(localStorage.getItem(JAR_SAVES_KEY) || '{}'); } catch { return {}; } };
    const jarWriteSaves = (o) => { try { localStorage.setItem(JAR_SAVES_KEY, JSON.stringify(o)); } catch { /* ignore */ } };
    // —— 6 个固定槽位（slot1..slot6）；旧版「时间戳 key」的存档一次性迁移进来（按时间倒序，最多 6 个）
    const JAR_SLOT_COUNT = 6;
    const JAR_SLOT_KEYS = Array.from({ length: JAR_SLOT_COUNT }, (_, i) => 'slot' + (i + 1));
    const jarMigrateSlots = () => {
      const raw = jarReadSaves();
      if (JAR_SLOT_KEYS.some((k) => raw[k])) return raw;
      const olds = Object.keys(raw).filter((k) => !JAR_SLOT_KEYS.includes(k) && raw[k] && Array.isArray(raw[k].roster))
        .sort((a, b) => (raw[b].at || 0) - (raw[a].at || 0)).slice(0, JAR_SLOT_COUNT);
      if (!olds.length) return raw;
      const next = {};
      olds.forEach((k, i) => { next[JAR_SLOT_KEYS[i]] = raw[k]; });
      jarWriteSaves(next);
      return next;
    };
    /** [{ key, data|null }] × 6，固定顺序。 */
    const jarSlots = () => { const raw = jarMigrateSlots(); return JAR_SLOT_KEYS.map((k) => ({ key: k, data: raw[k] || null })); };
    let jarActiveSlot = null; // 本局绑定的存档槽（开局选择确定；null = 新开、未绑定）
    const jarSaveToSlot = (slot, snap) => { if (!JAR_SLOT_KEYS.includes(slot)) return; const raw = jarReadSaves(); raw[slot] = { ...snap, slot }; jarWriteSaves(raw); };
    const jarClearSlot = (slot) => { const raw = jarReadSaves(); delete raw[slot]; jarWriteSaves(raw); };
    const jarFirstFreeSlot = () => { const raw = jarReadSaves(); return JAR_SLOT_KEYS.find((k) => !raw[k]) || null; };
    const jarExport = (k, d) => { const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `jar-save-${k}-R${d.round || 'x'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    const jarFmt = (t) => { try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
    const jarSaveMeta = (d) => `R${d.round || '?'} · ${d.funds || 0} 资金 · ${d.lp || 0} LP · ${d.roster ? d.roster.length : 0} 干员${d.jars && d.jars.length ? ` · 已砸 ${d.jars.length} 罐` : ''} · ${jarFmt(d.at)}`;
    /** 存档页卡片样式（外框用原生 <Modal tone="mint"> + 原生 <Button>：与整体配色一致，无金色）。 */
    const JAR_SV_CSS = `
.modal:has(.jar-sv-modal){z-index:220} /* 盖过「离开模拟」弹窗（--z-modal 80）*/
.jar-sv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.12rem;padding:.02rem 0}
.jar-sv-card{padding:.12rem;border:1px solid var(--line);border-radius:.06rem;background:rgba(255,255,255,.028);display:flex;flex-direction:column;gap:.06rem;transition:border-color .15s,background .15s;min-height:1.1rem}
.jar-sv-card:hover{border-color:var(--mint-500);background:rgba(78,216,175,.05)}
.jar-sv-card.is-empty{border-style:dashed}
.jar-sv-idx{font-size:.09rem;letter-spacing:.12em;color:var(--text-lo)}
.jar-sv-name{font-size:.14rem;color:var(--text-hi);font-weight:700}
.jar-sv-meta{font-size:.1rem;color:var(--text-lo);line-height:1.5}
.jar-sv-row{display:flex;gap:.06rem;flex-wrap:wrap;margin-top:auto}
.jar-sv-note{font-size:.1rem;color:var(--text-lo);line-height:1.5;margin:0 0 .1rem}
`;
    const jarSnapshot = () => {
      const s = store.get();
      const pub = s.match && s.match.public;
      const priv = s.match && s.match.private;
      if (!priv) return null;
      const roster = [];
      for (const p of (priv.board || [])) {
        if (!p || p.kind !== 'chess') continue;
        roster.push({ kind: 'chess', id: p.id, area: 'board', row: p.row, col: p.col, dir: p.dir, items: (p.items || []).map((i) => i.id) });
      }
      for (const p of (priv.hand || [])) if (p && p.kind === 'chess') roster.push({ kind: 'chess', id: p.id, area: 'hand', items: (p.items || []).map((i) => i.id) });
      for (const p of (priv.temp || [])) if (p && p.kind === 'chess') roster.push({ kind: 'chess', id: p.id, area: 'temp', items: (p.items || []).map((i) => i.id) });
      // 独立道具（开罐子获得、尚未装到干员身上的装备）：手牌 / 临时区里 kind==='item' 的都算玩家内容，必须继承
      for (const p of (priv.hand || [])) if (p && p.kind === 'item') roster.push({ kind: 'item', id: p.id, area: 'hand' });
      for (const p of (priv.temp || [])) if (p && p.kind === 'item') roster.push({ kind: 'item', id: p.id, area: 'temp' });
      const js = priv.jarShop || {};
      const obsView = (js && Array.isArray(js.obstacles)) ? js.obstacles : [];
      // 完整罐子布局（含未砸开内容，来自 view.jarSaveJars——私有的「存档专用」副本）：读档据此把地形 / 罐位 / 砸开状态原样还原。
      // 敌人罐的 enemyKey/count 一并带走，否则读档后放出的敌人会「卡没掉」（战斗中注入的敌人是运行时 battle 状态，不进进度快照）。
      const jarsView = Array.isArray(priv.jarSaveJars) ? priv.jarSaveJars : [];
      const allJars = jarsView.filter((j) => j && Number.isInteger(j.row) && Number.isInteger(j.col)).map((j) => ({
        id: j.id, kind: j.kind, smashed: !!j.smashed, row: j.row, col: j.col,
        opId: j.opId,
        enemyKey: j.kind === 'enemy' ? j.enemyKey : undefined,
        count: j.kind === 'enemy' ? (j.count || 1) : undefined,
        itemId: j.kind === 'item' ? j.itemId : undefined,
        buff: j.kind === 'buff' ? j.buff : undefined,
        amt: j.kind === 'buff' ? j.amt : undefined,
      }));
      return {
        v: 1, name: `第 ${pub ? pub.round : '?'} 回合`, at: Date.now(),
        round: pub ? pub.round : 1, stageId: pub ? pub.stageId : null,
        funds: Number(priv.funds) || 0, lp: Number(priv.lp) || 0, shopLevel: (priv.shop && priv.shop.level) || 1,
        jarShop: { slots: js.slots || 0, life: js.life || 0, revive: js.revive || 0, obsBasic: js.obsBasic || 0, obsAdvanced: js.obsAdvanced || 0 },
        // 已部署障碍物位置：仅当「存档地图 == 当前地图」时才有意义恢复（否则会重铺到不同地形）；恢复逻辑见 jarApplyLoad
        obstacles: obsView.map((o) => ({ tier: o.tier, row: o.row, col: o.col })),
        // 完整罐子布局（含未砸开内容 / 砸开状态）：同波次 / 跨波次读档均据此原样还原地形
        jars: allJars,
        roster,
      };
    };
    function JarSaveLoad() {
      const [, force] = useState(0);
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const [open, setOpen] = useState(false);
      const [confirmLoad, setConfirmLoad] = useState(null); // {key, data} 待确认读取
      // 暂停页（原生 PausedOverlay 注入点）的「存档」按钮通过该事件打开面板
      useEffect(() => {
        const h = () => setOpen(true);
        window.addEventListener('jar-save-open', h);
        return () => window.removeEventListener('jar-save-open', h);
      }, []);
      const s = store.get();
      const priv = s.match && s.match.private;
      if (!priv || !priv.jarShop) return null; // 仅 jar 模式显示
      const slots = jarSlots();
      const doSaveTo = (k) => { const snap = jarSnapshot(); if (!snap) return; jarSaveToSlot(k, snap); jarActiveSlot = k; audio.sfx('click', { volume: .4 }); force((n) => n + 1); };
      const doLoad = (k, d) => { if (!d) return; setConfirmLoad({ key: k, data: d }); };
      const confirmLoadExec = () => { const d = confirmLoad && confirmLoad.data; setConfirmLoad(null); if (d) net.request('g.jarLoadSave', { data: d }).then(() => setOpen(false)).catch(() => {}); };
      const doDel = (k) => { jarClearSlot(k); force((n) => n + 1); };
      const doImport = (e) => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => { try { const d = JSON.parse(String(r.result)); if (d && Array.isArray(d.roster)) { const k = jarFirstFreeSlot(); if (k) jarSaveToSlot(k, { ...d, name: d.name || '导入存档', at: Date.now() }); force((n) => n + 1); } } catch { /* ignore */ } };
        r.readAsText(f); e.target.value = '';
      };
      // 入口按钮在「离开模拟」弹窗（PauseSaveButton 注入）；这里只渲染槽位面板（原生 Modal 外框）
      return html`<${Modal} open=${open} onClose=${() => setOpen(false)} tone="mint" width="9.8rem" class="jar-sv-modal"
        title="砸罐子存档" micro="SAVE DATA · BLIND BOX">
        <style>${JAR_SV_CSS}</style>
        <p class="jar-sv-note">存档保存在浏览器本地（卸载插件也不会丢失）。读取<b>同波次存档立即生效</b>（冻结当前关卡：地形 / 已砸开罐子 / 资金 / 生命 / 商店 / 阵容 / 装备全部恢复）；读取其他波次的存档则在下一波开始时生效。最多 ${JAR_SLOT_COUNT} 个存档。</p>
        <div class="jar-sv-grid">
          ${slots.map((sl, i) => html`<div key=${sl.key} class=${'jar-sv-card' + (sl.data ? '' : ' is-empty')} data-test=${`jar-save-slot-${sl.key}`}>
            <span class="jar-sv-idx">SAVE SLOT ${i + 1}${jarActiveSlot === sl.key ? ' · 本局' : ''}</span>
            ${sl.data ? html`
              <span class="jar-sv-name">${sl.data.name || '存档'}</span>
              <span class="jar-sv-meta">${jarSaveMeta(sl.data)}</span>
              <div class="jar-sv-row">
                <${Button} variant="secondary" size="sm" onClick=${() => doSaveTo(sl.key)}>覆盖保存<//>
                <${Button} variant="primary" size="sm" onClick=${() => doLoad(sl.key, sl.data)}>读取<//>
                <${Button} variant="secondary" size="sm" onClick=${() => jarExport(sl.key, sl.data)}>导出<//>
                <${Button} variant="danger" size="sm" onClick=${() => doDel(sl.key)}>删除<//>
              </div>` : html`
              <span class="jar-sv-name">空槽位</span>
              <span class="jar-sv-meta">把当前进度存到这里</span>
              <div class="jar-sv-row">
                <${Button} variant="primary" size="sm" onClick=${() => doSaveTo(sl.key)}>保存到此<//>
              </div>`}
          </div>`)}
        </div>
        ${confirmLoad && html`<${Modal} open=${true} onClose=${() => setConfirmLoad(null)} tone="mint" width="4.4rem" class="jar-sv-modal"
          title="读取存档？"
          actions=${html`<${Button} variant="secondary" size="sm" onClick=${() => setConfirmLoad(null)}>取消<//>
            <${Button} variant="primary" size="sm" onClick=${confirmLoadExec}>确定读取<//>`}>
          <p class="jar-sv-note">确定读取这个存档吗？将恢复资金 / 生命 / 商店等级 / 干员阵容 / 装备道具；<b>同波次读取立即冻结当前关卡</b>（地形 / 已砸开罐子一并恢复），其他波次则在下一波开始时生效。</p>
        <//>`}
      <//>`;
    }

    /** 开局存档选择页：大厅点击「开始独立模拟」后弹出。选择读取则直接创建房间并加载存档；选择新开/空槽则创建房间后进入正常准备页。 */
    function JarStartSave() {
      const [, force] = useState(0);
      useEffect(() => {
        const cb = () => force((n) => n + 1);
        jarStartSaveSubs.add(cb);
        return () => jarStartSaveSubs.delete(cb);
      }, []);
      const [confirmLoad, setConfirmLoad] = useState(null); // {slot, data} 待确认读取
      const ctl = jarStartSaveCtl;
      if (!ctl || !ctl.open) return null;
      const slots = jarSlots();
      const start = async (slot, loadData) => {
        if (ctl.busy) return;
        ctl.busy = true; force((n) => n + 1);
        try {
          await ctl.onCreate({ slot, loadData });
          ctl.open = false;
          notifyJarStartSave();
          if (ctl.onDone) ctl.onDone();
        } catch (e) {
          ctl.busy = false;
          toast(e && e.message ? `进入存档失败：${e.message}` : '进入存档失败，请重试', 'error');
          ctl.open = false; // 关闭弹窗，避免反复确认死循环
          notifyJarStartSave();
          if (ctl.onDone) ctl.onDone();
        }
      };
      const choose = (slot, data) => {
        audio.sfx('click', { volume: .4 });
        jarActiveSlot = slot || null;
        if (data) { setConfirmLoad({ slot, data }); return; } // 已存在存档：先二次确认，不直接读档
        start(slot, null);
      };
      const confirmLoadExec = () => {
        const { slot, data } = confirmLoad || {};
        setConfirmLoad(null);
        if (data) start(slot, data);
      };
      if (confirmLoad) return html`<${Modal} open=${true} onClose=${() => setConfirmLoad(null)} tone="mint" width="4.4rem" class="jar-sv-modal"
        title="读取存档？"
        actions=${html`<${Button} variant="secondary" size="sm" onClick=${() => setConfirmLoad(null)}>取消<//>
          <${Button} variant="primary" size="sm" onClick=${confirmLoadExec} disabled=${ctl.busy}>确定读取<//>`}>
        <p class="jar-sv-note">确定读取这个存档吗？将<b>冻结回到存档时的关卡</b>：回合 / 地形（已部署障碍物，同地图）/ 本波已砸开的罐子 / 资金 / 生命 / 商店等级 / 干员阵容 / 装备道具全部恢复。</p>
      <//>`;
      const used = slots.filter((x) => x.data).length;
      return html`<${Modal} open=${true} onClose=${() => start(null, null)} tone="mint" width="9.8rem" class="jar-sv-modal" closeOnBackdrop=${false}
        title="选择存档" micro="SAVE DATA · BLIND BOX"
        actions=${html`<${Button} variant="primary" size="md" onClick=${() => start(null, null)} disabled=${ctl.busy}>新开一局（不读档）<//>`}>
        <style>${JAR_SV_CSS}</style>
        <p class="jar-sv-note">从 ${JAR_SLOT_COUNT} 个存档位中选择一个继续上次的进度（<b>冻结回到存档时的关卡</b>：回合 / 地形 / 已砸开的罐子 / 资金 / 生命 / 商店等级 / 干员阵容 / 装备道具全部恢复），或新开一局。当前已有 ${used} / ${JAR_SLOT_COUNT} 个存档。</p>
        ${ctl.busy ? html`<div style=${{ textAlign: 'center', padding: '.2rem', color: 'var(--text-lo)' }}>正在进入模拟…</div>` : html`<div class="jar-sv-grid">
          ${slots.map((sl, i) => html`<div key=${sl.key} class=${'jar-sv-card' + (sl.data ? '' : ' is-empty')} data-test=${`jar-start-slot-${sl.key}`}>
            <span class="jar-sv-idx">SAVE SLOT ${i + 1}</span>
            ${sl.data ? html`
              <span class="jar-sv-name">${sl.data.name || '存档'}</span>
              <span class="jar-sv-meta">${jarSaveMeta(sl.data)}</span>
              <div class="jar-sv-row">
                <${Button} variant="primary" size="sm" onClick=${() => choose(sl.key, sl.data)} disabled=${ctl.busy}>继续此存档<//>
                <${Button} variant="danger" size="sm" onClick=${() => { jarClearSlot(sl.key); force((n) => n + 1); }} disabled=${ctl.busy}>删除<//>
              </div>` : html`
              <span class="jar-sv-name">空槽位</span>
              <span class="jar-sv-meta">新开一局，进度将存到这里</span>
              <div class="jar-sv-row">
                <${Button} variant="primary" size="sm" onClick=${() => choose(sl.key, null)} disabled=${ctl.busy}>从此处开始<//>
              </div>`}
          </div>`)}
        </div>`}
      <//>`;
    }

    /** 「离开模拟」弹窗（原生 ExitModal 的 __SP_EXIT_EXTRAS__ 注入点）里的「存档」按钮：仅 jar 模式显示，
     *  原生 <Button secondary> 与「取消」同款配色；点击发 'jar-save-open' 事件，由 JarSaveLoad 打开存档面板。 */
    function PauseSaveButton() {
      const [, force] = useState(0);
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const s = store.get();
      const priv = s.match && s.match.private;
      if (!priv || !priv.jarShop) return null; // 仅 jar 模式
      return html`<${Button} variant="secondary" size="md" data-test="jar-pause-save"
        title="砸罐子存档（本地保存，卸载插件不丢失）"
        onClick=${() => { audio.sfx('click', { volume: .4 }); window.dispatchEvent(new CustomEvent('jar-save-open')); }}>存档<//>`;
    }

    /**
     * 砸罐子（jar 模式）的罐子层：不再铺满全屏 DOM 网格，而是把每个罐子投影到战场的真实格子上
     * （view.tileScreen(row,col) 把 board 坐标投影成屏幕像素，再用 position:fixed 相对视口绝对定位）。
     * 休整期常驻（没有收起按钮），点一个砸一个：砸开后罐子和槽位一起消失，格子让给部署。每帧根据活相机重算位置，跟随平移 / 缩放。
     */
    /** 罐子层（portal 进 .gm 的内容）：每帧把罐子贴到战场的真实格子上（跟随平移 / 缩放）。 */
    function JarLayer({ jars, onSmash }) {
      const layerRef = useRef(null);
      useEffect(() => {
        let raf = 0;
        const tick = () => {
          const view = globalThis.__SP_VIEW__;
          const layer = layerRef.current;
          if (view && view.tileScreen && layer) {
            const slots = layer.querySelectorAll('.jar-slot');
            for (let k = 0; k < slots.length; k++) {
              const node = slots[k];
              const row = Number(node.dataset.row), col = Number(node.dataset.col);
              const scr = view.tileScreen(row, col);
              if (!scr || !Number.isFinite(scr.x) || !Number.isFinite(scr.y)) { node.style.display = 'none'; continue; }
              const poly = scr.poly || null;
              const wpx = poly ? Math.abs(poly[1][0] - poly[0][0]) : 36;
              const hpx = poly ? Math.abs(poly[3][1] - poly[0][1]) : 36;
              const size = Math.max(16, Math.min(wpx, hpx) * 0.7);
              node.style.display = 'block';
              node.style.width = size + 'px';
              node.style.height = size + 'px';
              node.style.left = (scr.x - size / 2) + 'px';
              node.style.top = (scr.y - size / 2) + 'px';
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [jars]);
      return html`
        <div class="jarfield" ref=${layerRef}
          style=${{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 2, pointerEvents: 'none' }}>
          ${jars.filter((j) => !j.smashed).map((j) => html`<div key=${j.id} class="jar-slot" data-row=${j.row} data-col=${j.col}
            style=${{ position: 'absolute', pointerEvents: 'auto' }}
            ><${Jar} jar=${j} onSmash=${onSmash} /></div>`)}
        </div>`;
    }

    function JarField() {
      const st = useShared();
      const [, force] = useState(0);
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const s = store.get();
      const pub = s.match && s.match.public;
      const priv = s.match && s.match.private;
      const phase = pub && pub.phase;
      const round = pub && pub.round;
      const jars = (priv && priv.jars) || [];
      // 罐子阵常驻：休整期 + 战斗中一直铺在战场格子上——边防守边砸；干员也能直接放到没罐子的格子上。
      const open = jarOn(st.mode) && !st.creative && (phase === 'PREP' || phase === 'COMBAT') && jars.length > 0;
      const smash = (jarId) => {
        audio._play(JAR_SFX_URL, { volume: 0.7 }); // 砸罐玻璃破碎音效（原生 Arknights 镜面受击声）
        net.request('g.smashJar', { round, jarId }).catch(() => {});
      };

      // 罐子层 portal 进游戏屏 .gm（z-index 2：战场之上、HUD 之下——花瓶不再盖住底栏 / 浮层等任何 UI）；
      // 找不到 .gm（异常壳）时退回根部 fixed 层。根上只留控件（计数 chip / 战斗中快速部署条），它们本来就该压住 HUD。
      const [noGm, setNoGm] = useState(false);
      // jar 无休整期：通知简化视图在战斗中保持 prep 布局（整备区可见且可拖拽），并隐藏战斗倒计时。
      // 【hooks 规则】必须在任何条件 return 之前统一调用——此前放在 `if (!open) return null` 之后，
      // 罐子层开↔关切换时 hook 数量变化，preact 抛 "Rendered fewer hooks…" 中断整棵渲染树，
      // 同帧后续的干员头像 <img> 全部丢失（=「一加上插件就丢素材」的根因）。
      // 联防阶段（UNITE）也算「作战中」：整备区拖拽 / 罐中商店在联防阶段照常可用（用户 2026-10-17）。
      const combat = phase === 'COMBAT' || phase === 'UNITE';
      const hideTimer = combat && jarOn(st.mode);
      useEffect(() => {
        const view = globalThis.__SP_VIEW__;
        const on = combat && jarOn(st.mode);
        if (!view || typeof view.setJarMode !== 'function') return undefined;
        view.setJarMode(on);
        if (!on) return () => view.setJarMode(false);
        // 无休整期开战后 game.js 不再调 setPrep，两个视图（引擎 / 降级）都靠这里用 rAF 轮询把砸出的
        // 干员/道具实时灌进原生整备区（hand/temp）。board 要剥掉：已部署的干员由战斗快照渲染，
        // prep 视图再画一遍会同格重叠。引用相同则跳过重绘。
        let raf = 0, last = null;
        // 被主动撤离（benched）的击倒干员：再部署倒计时未结束前拒绝落场（客户端模拟下服务端没有这场战斗，
        // 门禁只能在客户端——canPlace 拦掉拖拽落格，干员留在整备区继续倒计时）。
        const canPlace = (uid, target) => {
          if (!target || target.area !== 'board') return true;
          const r = globalThis.__SP_RUNNER__;
          const t = r && typeof r.jarBenchTimer === 'function' ? r.jarBenchTimer(uid) : null;
          return !(t && t.time < t.respawnAt);
        };
        const tick = () => {
          const priv = store && store.get ? store.get().match?.private : null;
          if (priv && priv !== last) { last = priv; view.setPrep({ ...priv, board: [] }, { editable: true, canPlace }); }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => { cancelAnimationFrame(raf); view.setJarMode(false); };
      }, [combat, st.mode]);

      useEffect(() => {
        if (!open) return undefined;
        const gm = document.querySelector('.gm');
        if (!gm || typeof preactRender !== 'function') { setNoGm(true); return undefined; }
        setNoGm(false);
        const host = document.createElement('div');
        host.className = 'jarfield-host';
        host.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;';
        gm.appendChild(host);
        preactRender(html`<${JarLayer} jars=${jars} onSmash=${smash} />`, host);
        return () => { preactRender(null, host); host.remove(); };
      }, [open, jars]);

      if (!open) return null;
      const left = jars.filter((j) => !j.smashed).length;

      // 隐藏右上角战斗倒计时：只限 jar 模式的战斗阶段。砸出的干员/道具走原生整备区 + 原生拖拽部署
      // （引擎视图 setJarMode 保持 prep 布局、game.js 放行 editable；降级视图本来就保持整备区）。
      return html`<div style=${{ display: 'contents' }}>
        ${hideTimer ? html`<style>.countdown { display: none !important; }</style>` : null}
        ${open ? html`<div style=${{ position: 'fixed', left: '50%', top: '.18rem', transform: 'translateX(-50%)', pointerEvents: 'none',
          zIndex: 60, display: 'flex', alignItems: 'center', gap: '.14rem',
          padding: '.08rem .18rem', borderRadius: '.1rem', background: 'rgba(6,8,7,.82)',
          fontFamily: THEME.display, fontSize: '.16rem', letterSpacing: '.12em', color: THEME.gold }}>
          <span>${'战场罐子'}</span>
          <span style=${{ fontSize: '.13rem', color: THEME.dim }}>${`点击砸开 · 剩余 ${left} / ${jars.length}`}</span>
        </div>` : null}
        ${(noGm && open) ? html`<div class="jarfield" style=${{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 80, pointerEvents: 'none' }}>
          ${jars.filter((j) => !j.smashed).map((j) => html`<div key=${j.id} class="jar-slot" data-row=${j.row} data-col=${j.col}
            style=${{ position: 'absolute', pointerEvents: 'auto' }}
            ><${Jar} jar=${j} onSmash=${smash} /></div>`)}
        </div>` : null}
      </div>`;
    }

    function RevealOverlay() {
      const st = useShared();
      const rev = st.reveal;
      const [show, setShow] = useState(false);
      useEffect(() => {
        if (!rev) return undefined;
        setShow(false);
        const raf = requestAnimationFrame(() => setShow(true));
        // 敌人罐揭示开战在即，浮层 1.6s 就撤（不挡战斗）；干员/道具 2.6s。点击可随时关闭。
        const ms = rev.kind === 'jar' && rev.jar && rev.jar.kind === 'enemy' ? 1600 : 2600;
        const timer = setTimeout(() => setState({ reveal: null }), ms);
        return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
      }, [rev]);

      if (!rev) return null;
      const assets = data.get('assets');
      const close = () => { audio.sfx('back', { volume: 0.4 }); setState({ reveal: null }); };

      // 砸罐子揭示（服务端单播内容）：干员 / 敌人 / 道具 / 兜底增益
      if (rev.kind === 'jar') {
        const c = rev.jar || {};
        let name = '？', src = null, sub = '点击关闭', tag = '砸罐子';
        if (c.kind === 'operator' && c.opId) {
          const rec = data.lookup('chess', c.opId);
          name = (rec && rec.name) || c.opId;
          src = chessPortraitUrl(assets, rec); // 传 rec 对象（传 id 字符串会返回 null）
          sub = '获得干员 · 点击关闭';
        } else if (c.kind === 'enemy' && c.enemyKey) {
          const rec = data.lookup('enemies', c.enemyKey);
          name = (rec && rec.name) || c.enemyKey;
          src = enemyIconUrl(assets, c.enemyKey);
          const n = c.count && c.count > 1 ? ` ×${c.count}` : '';
          sub = `罐中敌人来袭${n}！· 点击关闭`;
        } else if (c.kind === 'item' && c.itemId) {
          const rec = data.lookup('items', c.itemId);
          name = (rec && rec.name) || c.itemId;
          // 传 rec 对象（含 trapId/iconId）：manifest 的 m.items 以 trapId 为键，直接传 itemId 字符串会解析为 null
          src = itemIconUrl(assets, rec);
          sub = '获得道具 · 点击关闭';
        } else if (c.kind === 'buff') {
          name = '增益';
          sub = (c.buff === 'deployCap' ? `部署上限 +${c.amt}` : '增益') + ' · 点击关闭';
        } else {
          name = '空罐';
          sub = '什么都没有… · 点击关闭';
        }
        return html`
          <div onClick=${close} style=${{ position: 'fixed', inset: 0, zIndex: 90, display: 'grid', placeItems: 'center',
            background: 'rgba(6, 8, 7, .62)', cursor: 'pointer',
            opacity: show ? 1 : 0, transition: 'opacity .22s var(--ease-out)' }}>
            <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.14rem',
              padding: '.32rem .46rem', background: THEME.panel, border: `1px solid ${THEME.gold}`,
              boxShadow: '0 0 .5rem rgba(248, 200, 66, .18)',
              transform: show ? 'scale(1)' : 'scale(.9)', transition: 'transform .26s var(--ease-out)' }}>
              <span style=${{ fontFamily: THEME.display, fontSize: '.12rem', letterSpacing: '.24em', color: THEME.gold }}>${tag}</span>
              ${src ? html`<img src=${src} alt=${name} style=${{ width: '1.6rem', height: '1.6rem', objectFit: 'contain' }} />` : null}
              <span style=${{ fontFamily: THEME.display, fontSize: '.24rem', fontWeight: 900, color: THEME.text }}>${name}</span>
              <span style=${{ fontSize: '.13rem', color: THEME.dim }}>${sub}</span>
            </div>
          </div>`;
      }

      const rec = rev.kind === 'item' ? data.lookup('items', rev.id) : data.lookup('chess', rev.id);
      const name = (rec && rec.name) || rev.id;
      // 传 rec 对象（item 含 trapId/iconId，chess 含 spine/avatar）：manifest 以 trapId 为键，直接传 id 字符串会解析为 null
      const src = rev.kind === 'item' ? itemIconUrl(assets, rec) : chessPortraitUrl(assets, rec);

      return html`
        <div onClick=${close} style=${{ position: 'fixed', inset: 0, zIndex: 90, display: 'grid', placeItems: 'center',
          background: 'rgba(6, 8, 7, .62)', cursor: 'pointer',
          opacity: show ? 1 : 0, transition: 'opacity .22s var(--ease-out)' }}>
          <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.14rem',
            padding: '.32rem .46rem', background: THEME.panel, border: `1px solid ${THEME.accent}`,
            boxShadow: '0 0 .5rem rgba(23, 249, 183, .18)',
            transform: show ? 'scale(1)' : 'scale(.9)', transition: 'transform .26s var(--ease-out)' }}>
            <span style=${{ fontFamily: THEME.display, fontSize: '.12rem', letterSpacing: '.24em', color: THEME.accent }}>BLIND BOX</span>
            ${src ? html`<img src=${src} alt=${name} style=${{ width: '1.6rem', height: '1.6rem', objectFit: 'contain' }} />` : null}
            <span style=${{ fontFamily: THEME.display, fontSize: '.24rem', fontWeight: 900, color: THEME.text }}>${name}</span>
            <span style=${{ fontSize: '.13rem', color: THEME.dim }}>${rev.kind === 'item' ? '获得道具' : '获得干员'} · 点击关闭</span>
          </div>
        </div>`;
    }

    /** The lobby card under the 01 模拟方式 mode cards: the four-option mode selector (local pref, applied at match start). */
    function BlindBoxLobbyCard() {
      const [pref, setPref] = useState(loadPref);
      const mode = pref.mode || 'off';
      const on = mode !== 'off';
      const choose = (id) => {
        const next = { ...pref, mode: id };
        setPref(next);
        savePref(next);
        audio.sfx('click', { volume: 0.4 });
        const label = (BB_MODES.find((m) => m.id === id) || {}).label || '';
        toast(id === 'off' ? '盲盒模式已关闭：之后的模拟恢复正常'
          : `盲盒模式：${label} · 进入模拟后生效`, id === 'off' ? 'info' : 'success');
      };

      return html`
        <div class="brackets" style=${{ '--bk-c': on ? 'var(--mint-400)' : 'var(--line-2)', display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(28, 34, 31, .92), rgba(13, 16, 15, .94))',
          border: `1px solid ${on ? 'var(--mint-700)' : 'var(--line)'}`,
          boxShadow: on ? '0 0 0 1px rgba(78, 216, 175, .22), 0 0 .44rem rgba(23, 249, 183, .13), inset 0 0 .7rem rgba(23, 249, 183, .05)' : 'none',
          transition: 'border-color var(--t-med), box-shadow var(--t-med)' }}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '.22rem', padding: '.2rem .32rem .12rem' }}>
            <span aria-hidden="true" style=${{ flex: 'none', width: '.56rem', height: '.56rem', display: 'grid', placeItems: 'center',
              background: on ? 'var(--mint-500)' : '#0c0f0e', border: `1px solid ${on ? 'var(--mint-400)' : 'var(--line-2)'}`,
              color: on ? 'var(--text-on-mint)' : 'var(--text-md)',
              clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)' }}>
              <svg viewBox="0 0 24 24" style=${{ width: '.28rem', height: '.28rem' }} aria-hidden="true">
                <path d="M3 8l9-5 9 5v9l-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="1.6" />
                <path d="M12 3v18M3 8l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.1" />
              </svg>
            </span>
            <span style=${{ display: 'flex', flexDirection: 'column', gap: '.03rem' }}>
              <span style=${{ fontFamily: THEME.display, fontSize: '.11rem', letterSpacing: '.18em', color: on ? THEME.accent : THEME.dim2 }}>BLIND BOX</span>
              <span style=${{ fontFamily: THEME.display, fontSize: '.22rem', fontWeight: 900, letterSpacing: '.06em', color: THEME.text }}>盲盒模式</span>
            </span>
          </div>
          <div style=${{ display: 'flex', gap: '.1rem', padding: '0 .32rem .22rem', flexWrap: 'wrap' }}>
            ${BB_MODES.map((m) => html`<button type="button" key=${m.id} onClick=${() => choose(m.id)}
              aria-pressed=${mode === m.id ? 'true' : 'false'}
              style=${{ flex: m.wide ? '1 1 100%' : '1 1 40%', minWidth: '1.3rem', display: 'flex', flexDirection: 'column', gap: '.02rem', textAlign: 'left',
                padding: '.12rem .14rem', cursor: 'pointer', borderRadius: '.08rem',
                background: mode === m.id ? 'var(--mint-a10)' : 'rgba(255,255,255,.02)',
                border: `1px solid ${mode === m.id ? 'var(--mint-400)' : 'var(--line-2)'}`,
                color: mode === m.id ? THEME.accent : THEME.dim }}>
              <b style=${{ fontSize: '.15rem', fontFamily: THEME.display, letterSpacing: '.06em' }}>${m.label}</b>
              <span style=${{ fontSize: '.1rem', lineHeight: 1.4 }}>${m.desc}</span>
            </button>`)}
          </div>
        </div>`;
    }

    registerLobbyEntry({ id: 'blindbox-mode', Component: BlindBoxLobbyCard });

    /** 插件 overlay 错误边界：任何 overlay 渲染抛错只「本帧跳过该 overlay」（1.5s 后自动重试），绝不连坐宿主渲染树。
     *  修「加插件后部分干员头像变首字占位」：此前某个 overlay 渲染中断会让 preact 那一帧后续的 <img>（干员头像等）一起丢失。 */
    const jarOverlaySafe = (Comp, tag) => {
      if (!PreactComponent) return Comp; // 极端环境（preact 不可用）退回原样
      return class extends PreactComponent {
        constructor(props) { super(props); this.state = { err: false }; }
        static getDerivedStateFromError() { return { err: true }; }
        componentDidCatch(err) { try { console.warn(`[blindbox] overlay "${tag}" render failed (skipped, retrying)`, err); } catch { /* ignore */ } setTimeout(() => { try { this.setState({ err: false }); } catch { /* ignore */ } }, 1500); }
        render() { return this.state.err ? null : html`<${Comp} ...${this.props} />`; }
      };
    };

    registerOverlay(jarOverlaySafe(BlindBoxBrain, 'BlindBoxBrain'));
    registerOverlay(jarOverlaySafe(BlindScoutListener, 'BlindScoutListener'));
    registerOverlay(jarOverlaySafe(BlindRevealEnemy, 'BlindRevealEnemy'));
    registerOverlay(jarOverlaySafe(RevealOverlay, 'RevealOverlay'));
    registerOverlay(jarOverlaySafe(JarMiniBossBanner, 'JarMiniBossBanner')); // 无尽模式·小型首领登场横幅（#62）
    registerOverlay(jarOverlaySafe(JarField, 'JarField')); // 砸罐子：罐子投影到战场真实格子（每帧跟随活相机）
    registerOverlay(jarOverlaySafe(JarObstacleDeploy, 'JarObstacleDeploy')); // 砸罐子：障碍物手动部署面板（战斗中）
    registerOverlay(jarOverlaySafe(JarStartSave, 'JarStartSave')); // 砸罐子：开局存档选择页（6 槽，每局一次）
    registerOverlay(jarOverlaySafe(JarSaveLoad, 'JarSaveLoad')); // 砸罐子：多档存档/读档（localStorage，卸载插件不丢失）
    // 砸罐子：把「存档」按钮注入「离开模拟」确认弹窗（ExitModal 渲染 __SP_EXIT_EXTRAS__；jarOverlaySafe 兜底防连累弹窗）
    globalThis.__SP_EXIT_EXTRAS__ = globalThis.__SP_EXIT_EXTRAS__ || [];
    globalThis.__SP_EXIT_EXTRAS__.push(jarOverlaySafe(PauseSaveButton, 'PauseSaveButton'));
    registerShopOverride({ id: 'blindbox-shop', Component: jarOverlaySafe(BlindShop, 'BlindShop') });
  },
};

// ==============================================================================================================
// 服务端半边（Node）：public/mod/*.js 的 `server` 导出，由 server/mods.js 的 loadMods() 在启动时调用。
// 盲盒的全部服务端权威逻辑都在这里 —— 协议注册（C2S schema）、四个 intent、PREP 阶段钩子（罐子生成）、
// 私有视图增强（jars）、悬赏过滤（敌人罐不显示为悬赏卡）、敌情预览增强（redacted / partial）、价格钩子（盲盒价）。
// per-match 状态走 api.matchState（match.mods.blindbox），随机源走 api.rng(match, 'jars')，核心引擎零盲盒代码。
// ==============================================================================================================
// ---- 协议：MOD 自有 C2S 的 schema（两端共用同一份 —— 服务端注入服务端的 C2S 目录，
//      客户端注入浏览器的 C2S 目录；浏览器 net.request 先用它本地校验，缺了消息根本发不出去）----
const C2S_MSGS = {
  'g.blindBoxSet': { mode: (v) => v === 'off' || v === 'shop' || v === 'enemy' || v === 'all' || v === 'jar' },
  'g.blindBoxGet': {},
  'g.scoutWave': { round: (v) => v === undefined || Number.isInteger(v) },
  'g.smashJar': { round: (v) => v === undefined || Number.isInteger(v), jarId: (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 },
  'g.jarEquip': { itemUid: (v) => Number.isInteger(v), targetUid: (v) => Number.isInteger(v), replaceUid: (v) => v === undefined || v === null || Number.isInteger(v) },
  'g.jarSell': { uid: (v) => Number.isInteger(v) },
  'g.jarShopBuy': { item: (v) => v === 'slot' || v === 'life' || v === 'revive' || v === 'obstacleBasic' || v === 'obstacleAdvanced' },
  'g.jarReviveUsed': { battleId: (v) => typeof v === 'string' && v.length > 0 && v.length <= 80, playerId: (v) => typeof v === 'string' && v.length > 0 && v.length <= 64, n: (v) => Number.isInteger(v) && v >= 0 && v <= 99 },
  'g.jarDeployDevice': { item: (v) => v === 'obstacleBasic' || v === 'obstacleAdvanced', row: (v) => Number.isInteger(v), col: (v) => Number.isInteger(v) },
  'g.jarDeployDeviceDone': { item: (v) => v === 'obstacleBasic' || v === 'obstacleAdvanced' },
  'g.jarLoadSave': { data: (v) => !!v && typeof v === 'object' && !Array.isArray(v) },
  'g.jarStartAndLoad': { data: (v) => !!v && typeof v === 'object' && !Array.isArray(v) },
  'g.jarObstacleLost': { item: (v) => v === 'obstacleBasic' || v === 'obstacleAdvanced', row: (v) => Number.isInteger(v), col: (v) => Number.isInteger(v) },
};

export function server(api) {
  const { PHASE, ERR, OK, fail, msg, matchState, rng } = api;
  /** per-match 状态（惰性初始化）：{ mode, blindScout: {…}, jars: { [playerId]: JarSlot[] }, jarShop: { [playerId]: rec }, jarReviveUsed: { [playerId]: { [battleId]: n } } } */
  const state = (m) => matchState(m, () => ({ mode: 'off', blindScout: {}, jars: {}, jarShop: {}, jarReviveUsed: {}, pendingLoad: {}, jarObstacles: {}, jarPendingSmash: {}, jarFrozenEnemies: {} }));

  // ---- 协议注册：C2S schema 注入 validateC2S 的目录（m.blindBoxState / m.jarSmashed 是 S2C，无需注册）----
  for (const [name, schema] of Object.entries(C2S_MSGS)) api.registerMessage(name, schema);

  // ---- intents（intents.js _handle 顶端的 MOD 注册表路由）----------------------------------------------------

  /** 盲盒开关：match-wide，广播 m.blindBoxState；离开 jar 清罐子，PREP 中途切 jar 立即生成。 */
  function blindBoxSet(m, ps, mode) {
    if (m.phase === PHASE.LOBBY) return fail(ERR.WRONG_PHASE);
    if (mode !== 'off' && mode !== 'shop' && mode !== 'enemy' && mode !== 'all' && mode !== 'jar') return fail(ERR.BAD_MSG, 'bad blind box mode');
    const st = state(m);
    if (st.mode === mode) return OK;
    st.mode = mode;
    // 无尽模式（jar）：把引擎的「最终强袭 / 隐藏核心」回合实例遮蔽为永不触发，使 jar 轮次无限推进、
    // 仅当被淘汰（LP 归零）才结束——m.gd 是每局独立的 GameData 实例，遮蔽只影响本局，不影响其他对局。
    // （bossRound / hiddenRound 是 gd 上的 getter，按实例遮蔽即可盖掉原型 getter；离开 jar 时 delete 还原。）
    if (mode === 'jar') {
      try {
        Object.defineProperty(m.gd, 'bossRound', { value: 1e9, configurable: true, writable: true });
        Object.defineProperty(m.gd, 'hiddenRound', { value: null, configurable: true, writable: true });
      } catch { /* ignore */ }
    } else {
      try { if (m.gd.hasOwnProperty('bossRound')) delete m.gd.bossRound; } catch { /* ignore */ }
      try { if (m.gd.hasOwnProperty('hiddenRound')) delete m.gd.hiddenRound; } catch { /* ignore */ }
    }
    // jar 模式：取代商店栏。离开 jar 模式时清掉上一批罐子，避免残留；在 PREP 中途切到 jar 则立刻生成罐子。
    if (mode !== 'jar') st.jars = {};
    else if (m.phase === PHASE.PREP) generateJars(m);
    // 私有视图在构建时读盲盒状态（价格钩子 / 敌情钩子 / jars），每个玩家的视图都要重建。
    for (const p of m.players.values()) m.markPrivate(p);
    m.broadcast({ t: 'm.blindBoxState', mode: st.mode });
    const label = { off: '盲盒模式已关闭', shop: '盲盒模式：商店变盲盒', enemy: '盲盒模式：敌人情报隐藏（可侦察）', all: '盲盒模式：商店+敌人同时盲盒', jar: '盲盒模式：砸罐子（休整期砸罐·真威胁）' }[mode];
    m.toast(ps, 'info', msg(label));
    return OK;
  }

  function blindBoxGet(m, ps) {
    m.sendTo(ps.playerId, { t: 'm.blindBoxState', mode: state(m).mode });
    return OK;
  }

  /** 大厅「读档并直接开战」一键入口：g.jarStartAndLoad {data}。
   *  前提：jar 模式已激活（客户端先发 g.blindBoxSet {jar}）——不在此处自动开无尽模式（fuzz / 其他流程不得借道开 jar）。
   *  作用：以存档的回合数开波（__freeze：冻结当前关卡——地形 / 本波敌人 / 罐子布局与存档时一致），
   *  并跳过 INFO_CHECK / BAND_DRAFT / BATTLE_CHECK 直接进入该波休整期；读档内容在 startRound 边界应用。
   *  仅用于大厅点击「开始独立模拟」后的开局读档流程，不替代游戏中的 g.jarLoadSave。 */
  function jarStartAndLoad(m, ps, req) {
    if (m.phase === PHASE.LOBBY) return fail(ERR.WRONG_PHASE, 'match not started');
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    const d = req && req.data;
    if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.roster)) return fail(ERR.BAD_MSG, 'bad save');
    st.pendingLoad[ps.playerId] = { ...d, __freeze: true };
    // 自动推进：跳过 briefing → 策略选择 → 战前检查，直接以存档回合数开始
    if (m.phase === PHASE.INFO_CHECK) m.enterBandDraft();
    if (m.phase === PHASE.BAND_DRAFT) m.finishBandDraft(false);
    if (m.phase === PHASE.BATTLE_CHECK) m.startRound(1);
    return OK;
  }

  /**
   * 砸罐子（jar 模式）的罐子生成：在战场每个「可部署格子」上放一个罐子（而不是铺满全屏 DOM 网格）。
   * 罐子坐标用 board 坐标（与服务端 buildDeployMap 的 'r,c' 键一致），客户端用 view.tileScreen(row,col)
   * 把格子投影到屏幕、相对视口绝对定位，于是能直接看到地图、罐子落在真实格子上。
   * 内容服务端权威（客户端只看 id + 是否砸开 + 格子坐标）：干员 / 敌人 / 道具按回合调权重——单机前期干员 40%，
   * R6 起 30%、R11 起 18%（用户 2026-10-15：后期减少开干员的比例），敌人/道具相应提高；
   * 同盟（coop）更容易出怪：干员 28/20/12%、敌人 52/55/63%（用户 2026-10-16），且精英 R4 起解锁、轮转池精英双份。
   * 敌人取自按回合强度解锁的全敌人池（enemyPool：R1-2 杂兵 / R3-4 老练 / R5+ 精英），打乱后按顺序轮流
   * 分给各敌人罐——种类丰富且不会连出同一种。
   * 注入数量随波次缩放（早波 2、中期 3、后期 4）；道具按调度中心等级从装备池抽（与商店道具位同一个池），
   * 砸开后进整备区（两件相同的会自动合成金色）。
   */
  function generateJars(m) {
    if (!m.wave) return;
    const rj = rng(m, 'jars');
    const pool = enemyPool(m, rj); // 打乱的敌人池
    // 罐子内容权重随回合变化（用户 2026-10-15：后期减少从罐子开出干员的比例——阵容成型后干员罐边际收益
    // 递减，把格子让给敌人/道具）：单机 R1-5 干员 40/敌人 40/道具 20 → R6-10 干员 30/敌人 45/道具 25
    // → R11+ 干员 18/敌人 57/道具 25。
    // 同盟（coop，用户 2026-10-16）：更容易出怪——干员份额再让给敌人：
    // R1-5 干员 28/敌人 52/道具 20 → R6-10 20/55/25 → R11+ 12/63/25（道具份额与单机一致）。
    const r0 = Number(m.round) || 1;
    const coop = !m.isSolo; // 同盟（多人）对局
    // 第 10 关（R11+）后：降低干员 / 道具比例、提升敌人比例（用户要求：减少罐中干员与道具数量、提升敌人数量与比例）
    const wOp = coop ? (r0 >= 11 ? 0.12 : r0 >= 6 ? 0.20 : 0.28)
                     : (r0 >= 11 ? 0.18 : r0 >= 6 ? 0.30 : 0.40);
    const wEn = coop ? (r0 >= 11 ? 0.63 : r0 >= 6 ? 0.55 : 0.52)
                     : (r0 >= 11 ? 0.57 : r0 >= 6 ? 0.45 : 0.40);
    const rollKind = () => {
      const r = rj();
      if (r < wOp) return 'operator';
      if (r < wOp + wEn) return 'enemy';
      return 'item';
    };
    const st = state(m);
    st.jars = {};
    st.jarsRound = Number(m.round) || 1; // 本波罐子的回合标记：读档时据此判断能否就地恢复砸开状态
    for (const ps of m.alivePlayers()) {
      const dm = m.deployMapFor(ps); // board tile 'r,c' → 'melee'|'ranged'
      // 用户要求：有干员（含召唤物）占着的地块不刷新罐子——上波部署的棋子原样留在场上，
      // 新罐子只落在空闲的可部署格（键都是 'r,c'，与 deployMap 一致）。
      const occupied = new Set();
      for (const [key, p] of ps.board) if (p) occupied.add(key);
      // 已持久部署的障碍物（jar 木箱）也占着战场格：罐子不能刷在上面，否则罐子会盖在障碍物上。
      // 例外：本波处于「冻结读档恢复」中（jarPendingSmash 待消费）——读档需按存档原样还原罐子布局（存档里罐子可能正落在
      // 障碍物格上），故此时不剔除障碍物格，保证已砸开数量精确恢复（见 jarApplyLoad）。
      const restoring = !!(st.jarPendingSmash && st.jarPendingSmash[ps.playerId]);
      const obsList = (st.jarObstacles && Array.isArray(st.jarObstacles[ps.playerId])) ? st.jarObstacles[ps.playerId] : [];
      if (!restoring) for (const o of obsList) if (o && Number.isInteger(o.row) && Number.isInteger(o.col)) occupied.add(`${o.row},${o.col}`);
      const jars = [];
      let i = 0;
      let enemySeq = 0; // 第几个敌人罐：按序取池，保证每种敌人都会出现、不会连出同一种
      const add = (row, col) => {
        const jar = makeJar(m, ps, rj, rollKind(), pool, enemySeq, i++, row, col);
        if (jar.kind === 'enemy') enemySeq++;
        jars.push(jar);
      };
      for (const [key] of dm) {
        if (occupied.has(key)) continue; // 已部署的地块不刷罐
        const [br, bc] = key.split(',').map(Number);
        add(br, bc);
      }
      // 兜底：当前场没有可部署格子 / 全被占满（理论上不会发生）才用 normal 场默认 9–12×2–10 铺一个，避免一局空罐。
      if (!jars.length) {
        for (let r = 9; r <= 12; r++) {
          for (let c = 2; c <= 10; c++) {
            if (occupied.has(`${r},${c}`)) continue;
            add(r, c);
          }
        }
      }
      st.jars[ps.playerId] = jars;
    }
    // 冻结读档：恢复「哪些罐子已砸开」（存档瞬间的关卡状态）。砸开时发放的内容已在存档的
    // funds/roster 里，这里只恢复格子的 smashed 显示状态，不重复发放。
    const psm = st.jarPendingSmash || {};
    for (const pid of Object.keys(psm)) {
      const set = psm[pid];
      const list = st.jars[pid];
      if (!set || !Array.isArray(list)) continue;
      for (const j of list) if (set.has(`${j.row},${j.col}`)) j.smashed = true;
      delete psm[pid];
    }
    for (const ps of m.alivePlayers()) m.markPrivate(ps);
  }

  /**
   * jar 敌人强度分（0 杂兵 / 1 老练 / 2 精英 / 3 大首领 / 4 永不入罐）：
   * 口径 = maxHp/1000 + atk/120。用户 2026-10-15：「除了固定在原地不会走的怪其他的都可以加入」——
   * 会走的怪全部放行（含 BOSS：弑君者 / W / 碎骨 / 鼠王 / 泥岩 / 墓碑 …），只排除三类：
   *  ① 不沿路径移动的（FLY：破胄之锤 / 斩胄之剑 / 愧悔魂灵圣杯 / 萨科塔昂首 / 威龙 / 枯朽萃聚使徒）；
   *  ② score ≥ 90 的会走超模（碎铳之簧 250 万血、萨米的意志、泥岩巨像…）——血厚到打不完，而 jar 回合靠
   *     「敌人清完」收尾，放进去会让回合永远无法结束（功能卡死，非强度偏见；想放改这个阈值即可）。
   *  ③ 完全不会攻击的敌人（基础 atk === 0：无人机 / 文玩瑞印 / 铁砧 / 哨兵 / 磷火 / 落石 / 护障… 被动 / 辅助类）——
   *     出罐后只走到目标点漏怪、不参与战斗，对 jar 的作战挑战毫无意义（用户 2026-10-17）。经核验全库 atk===0 的
   *     敌人（116 个）均无造成伤害/控制的技能，判定干净、无真威胁被误删。
   * 解锁曲线：tier0 R1-2 / tier1 R3-4 / tier2 R5+ / tier3（大首领）R10+（与小型首领同步登场）。
   */
  function jarEnemyTier(m, key) {
    const e = m.gd.enemy(key);
    if (!e || !e.stats) return 4;
    // 站桩（在原地不会走动，官方数据 moveSpeed 0：圣徒像 /「无念之冬」/ 阿利斯泰尔 / 未装配刀片 / 泄漏源…）
    // 永不入罐——出罐后永远到不了目标点，回合收不了尾（用户 2026-10-16：除站桩外全量加入）。
    if (Number(e.stats.moveSpeed) === 0) return 4;
    // 完全不会攻击的敌人（基础攻击力 atk 为 0：无人机 / 文玩瑞印 / 铁砧 / 哨兵 / 磷火 / 落石 / 护障 等被动 / 辅助类）：
    // 出罐后只走到目标点漏怪、不参与战斗，对 jar 的作战挑战毫无意义，永不入罐（用户 2026-10-17）。
    if (Number(e.stats.atk) === 0) return 4;
    // 飞行怪也算「会动」，同样入罐（jarEnemySpecs 按 motion 选飞行路线）；分数口径不变。
    const s = (Number(e.stats.maxHp) || 0) / 1000 + (Number(e.stats.atk) || 0) / 120;
    // 百万级超模（碎铳之簧 / 萨米的意志 / 斩胄之剑…）不再永久排除，归入大首领档：R10+ 一次一只
    if (s >= 90) return 3;
    if (s >= 34) return 3;
    if (s >= 14) return 2;
    if (s >= 7) return 1;
    return 0;
  }

  /** jar 敌人必须有可渲染的 Spine 模型：数据清单（assets.json enemies）含 spine / spineLocal / 可解析的 spineAliasOf。
   *  防止把「只有图标、没有模型」的敌人放进罐子——出场后会变成菱形占位/黑影（用户报告「部分敌人素材丢失」）。 */
  function jarEnemyHasSpine(m, key) {
    const assets = m.gd.raw && m.gd.raw.assets;
    const rec = assets && assets.enemies && assets.enemies[key];
    if (!rec) return false;
    if (rec.spine || rec.spineLocal) return true;
    const alias = rec.spineAliasOf;
    if (alias) {
      const al = assets.enemies[alias];
      return !!(al && (al.spine || al.spineLocal));
    }
    return false;
  }

  /**
   * 敌人池：按回合强度渐进解锁——R1-2 仅杂兵 / R3-4 放开老练 / R5+ 加入精英 / R10+ 加入会走的大首领
   * （经典 BOSS 从罐中登场，见 jarEnemyTier）。来源是官方全敌人库（2026-10-16 起含全部会动敌人：
   * 飞行怪与超模也入罐，仅站桩——moveSpeed 0——永不入罐），而非模式波次模板：
   * 种类随回合极大丰富，且前期绝不会碰见「灵幛」/ 孽罪奇美拉 这类玩家打不过的精英（用户 2026-10-15：
   * 第 5 回合起就要能出比较强的怪）。
   * 额外过滤：没有 Spine 模型的敌人不进罐，避免「只有头像、进场后变成菱形占位」的素材丢失观感。
   * 排除 mode.inactiveEnemyKeys（训练假想敌等）；过滤后为空逐级回退（本波 spawns → 全库 tier≤2），绝不空罐。
   */
  function enemyPool(m, rj) {
    const cur = Number(m.round) || 1;
    const coop = !m.isSolo; // 同盟（多人）对局：更容易出精英怪（用户 2026-10-16）
    // 同盟模式精英（tier 2）R4 起解锁（单机 R5+）；大首领仍 R10+ 与小型首领同步
    const maxTier = cur <= 2 ? 0 : cur <= (coop ? 3 : 4) ? 1 : cur <= 9 ? 2 : 3;
    const all = (m.gd.raw && m.gd.raw.enemies) || {};
    const inactive = m.gd.inactiveEnemies;
    const ok = (k) => jarEnemyHasSpine(m, k) && !(inactive && inactive.has(k)) && jarEnemyTier(m, k) <= maxTier;
    let out = Object.keys(all).filter(ok);
    if (!out.length) { // 回退 1：本波 spawns 里符合条件的（模式只配了超模敌人的极端情况）
      const set = new Set();
      for (const s of m.wave.spawns || []) { const k = s.key; if (k && m.gd.enemy(k) && ok(k)) set.add(k); }
      out = [...set];
    }
    if (!out.length) out = Object.keys(all).filter((k) => jarEnemyHasSpine(m, k) && jarEnemyTier(m, k) <= 2); // 回退 2：全库 tier≤2 且有模型
    // 同盟模式：轮转池中精英（tier 2）双份——轮流分配时精英出现频率约 2 倍（种类不减）
    if (coop) {
      const elites = out.filter((k) => jarEnemyTier(m, k) === 2);
      if (elites.length && out.length < 2048) {
        out = out.concat(elites);
        for (let i = out.length - 1; i > 0; i--) { // Fisher–Yates 重洗，把追加的精英打散
          const j = Math.floor(rj() * (i + 1));
          const t = out[i]; out[i] = out[j]; out[j] = t;
        }
      }
    }
    for (let i = out.length - 1; i > 0; i--) { // Fisher–Yates（MOD 专用 rng，不占引擎随机流）
      const j = Math.floor(rj() * (i + 1));
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /** 造一个罐子：按 kind 填内容，抽空则按 干员 → 敌人 → 道具 降级，全空才兜底为增益。 */
  function makeJar(m, ps, rj, kind, pool, seq, i, row, col) {
    const jar = { id: `jar:${ps.playerId}:${m.round}:${i}`, kind: 'buff', smashed: false, row, col };
    const fill = (k) => {
      if (k === 'operator') {
        const opId = m.pool.roll(rj, { maxTier: ps.shop.level });
        if (!opId) return false;
        jar.kind = 'operator'; jar.opId = opId; return true;
      }
      if (k === 'enemy') {
        // 轮流取池：pool[seq % pool.length]，第 seq 个敌人罐拿第 seq 种敌人，种类分散且不重复连出
        const ek = pool.length ? pool[seq % pool.length] : null;
        if (!ek) return false;
        jar.kind = 'enemy'; jar.enemyKey = ek;
        // 数量随波次增长；精英（tier≥2）减半出——R6 初遇精英时一次 1-2 只，给玩家凑阵容的时间
        const et = jarEnemyTier(m, ek);
        jar.count = et >= 3 ? 1 // 大首领（泥岩 / 墓碑 / 弑君者…）一次一只，R10+ 才可能出现
          : et >= 2 ? Math.max(1, Math.min(3, 1 + Math.floor((m.round - 1) / 6)))
          : Math.min(4, 2 + Math.floor((m.round - 1) / 3));
        // 同盟模式（用户 2026-10-16）：单罐敌人再多 1 只（上限 6）——多人分摊火力，出怪量要跟上
        if (et < 3 && !m.isSolo) jar.count = Math.min(6, jar.count + 1);
        // 第 10 关（R11+）后：敌人数量再 +1（上限 6），进一步「提升敌人的数量」
        if (et < 3 && Number(m.round) >= 11) jar.count = Math.min(6, jar.count + 1);
        return true;
      }
      if (k === 'item') {
        const itemId = m.pool.rollItem(rj, ps.shop.level);
        if (!itemId) return false;
        jar.kind = 'item'; jar.itemId = itemId; return true;
      }
      return false;
    };
    if (!(fill(kind) || fill('operator') || fill('enemy') || fill('item'))) {
      // 极端兜底：干员池 / 敌人波 / 装备池全空 → 部署上限 +1（正常对局抽不到）
      jar.kind = 'buff'; jar.buff = 'deployCap'; jar.amt = 1;
    }
    return jar;
  }

  // ---- 战斗中继续玩（jar 模式）：砸罐 / 部署都接进正在运行的战斗 ---------------------------------------------

  const DIRS = new Set(['UP', 'RIGHT', 'DOWN', 'LEFT']);
  const dirOf = (piece) => (piece && DIRS.has(piece.dir) ? piece.dir : 'RIGHT'); // 与 server/match/board.js pieceDir 一致
  /** 罐中敌人出场缓冲：砸开敌人罐后等这么久敌人才从出生点走出。单位是战斗秒（战斗恒 2 倍速：
   * 10 战斗秒 = 5 真实秒，即用户要求的「砸完等五秒才出」）。 */
  const JAR_LEAD_IN = 10;

  /** jar 战斗的时限（战斗秒）：本波倒计时的「运行逻辑」在 jar 模式不生效——时限抬到引擎硬顶
   *  （sim MAX_BATTLE_TIME = 3600，超时路径形同虚设），回合改由「最后一罐砸开（锚点撤除）+ 敌人清完」
   *  自然收尾。玩家不砸完就一直打（引擎 3600 战斗秒 = 2 倍速下 30 真实分钟的兜底仍保留，防止对局挂死）。 */
  const JAR_BATTLE_LIMIT = 3600;

  /** 最后一罐砸开后撤锚点的延迟（真实毫秒）：给玩家几秒把刚开出的干员/道具放下——
   *  若这罐是敌人罐，敌人 JAR_LEAD_IN（5 真实秒）才出场，撤锚点后战斗照样等它们打完。 */
  const JAR_ANCHOR_CLEAR_DELAY_MS = 4000;
  /** AI 队友砸「敌人罐」的延迟（真实毫秒）：先布阵、后放怪，别一开场就被漏穿。 */
  const JAR_BOT_FOE_DELAY_MS = 3000;
  /** AI 队友每波商店消费后保留的底仓（资金）：不留空仓，下一波还能买。 */
  const JAR_BOT_KEEP_FUNDS = 2;

  // ---- jar 模式 AI 队友：真正下场玩砸罐子（2026-10-17）------------------------------------------------------
  // jar 没有休整期商店、600ms 就开战，核心 botPrep 的购物/布阵切片会被 phase 切换丢弃，砸罐/罐中商店/障碍物
  // 又只给人类玩家做了客户端入口 → 原先 AI 队友完全躺平（空场接怪、全部漏掉）。
  // 这里在每波战斗建立后驱动 AI：① 买罐中商店 → ② 砸开全部非敌人罐，按路线热图部署上场并穿装 →
  // ③ 要道放障碍物 → ④ 延后几秒砸开剩余敌人罐（敌人后到）。所有罐子最终都会砸开，战场才能收尾。

  /** 本波敌人路线的「热力图」：key 'r,c' → 经过次数（AI 部署/放障碍物优先贴敌人必经之路）。 */
  function jarRouteHeat(m) {
    const heat = new Map();
    const routes = (m.wave && Array.isArray(m.wave.routes)) ? m.wave.routes : [];
    const add = (r, c) => { const k = `${r},${c}`; heat.set(k, (heat.get(k) || 0) + 1); };
    for (const rt of routes) {
      if (!rt) continue;
      const pts = [];
      if (Array.isArray(rt.start)) pts.push(rt.start);
      if (Array.isArray(rt.checkpoints)) for (const cp of rt.checkpoints) if (Array.isArray(cp)) pts.push(cp);
      if (Array.isArray(rt.end)) pts.push(rt.end);
      for (let i = 0; i + 1 < pts.length; i++) {
        const [r0, c0] = pts[i], [r1, c1] = pts[i + 1];
        const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
        for (let s = 0; s <= steps; s++) {
          add(Math.round(r0 + ((r1 - r0) * s) / Math.max(1, steps)), Math.round(c0 + ((c1 - c0) * s) / Math.max(1, steps)));
        }
      }
    }
    return heat;
  }

  /** 敌人主流方向 → 干员朝向（面朝敌人来的方向，格挡/输出最大化）。 */
  function jarRouteDir(m) {
    const routes = (m.wave && Array.isArray(m.wave.routes)) ? m.wave.routes : [];
    let dr = 0, dc = 0;
    for (const rt of routes) {
      if (!rt || !Array.isArray(rt.start) || !Array.isArray(rt.end)) continue;
      dr += (rt.end[0] - rt.start[0]); dc += (rt.end[1] - rt.start[1]);
    }
    if (!dr && !dc) return 'RIGHT';
    if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? 'UP' : 'DOWN';
    return dc > 0 ? 'LEFT' : 'RIGHT';
  }

  /** AI 每波商店消费：部署位（前期）→ 初级障碍物 → 复活一次（低压）→ 高级障碍物 → 生命（低压）。留底仓。 */
  function jarBotShop(m, ps) {
    const st = state(m);
    const round = Number(m.round) || 1;
    const rec = jarShopRec(m, ps); // 惰性建：没买过也要能算价格
    const wish = [];
    if (rec.slots < JAR_SHOP_SLOT_PRICES.length) wish.push('slot');
    if (round >= 2 && rec.obsBasic < JAR_SHOP_OBSTACLE_CAP) wish.push('obstacleBasic');
    if (round >= 4 && rec.revive <= 0 && ps.lp <= 6) wish.push('revive');
    if (round >= 5 && rec.obsAdvanced < JAR_SHOP_OBSTACLE_CAP) wish.push('obstacleAdvanced');
    if (ps.lp <= 8) wish.push('life');
    for (const item of wish) {
      const price = jarShopPrice(rec, item);
      if (price == null) continue;
      if ((Number(ps.funds) || 0) < price) continue;
      if ((Number(ps.funds) || 0) - price < JAR_BOT_KEEP_FUNDS) break; // 不留空仓
      jarShopBuy(m, ps, item);
    }
  }

  /** AI 部署：把手牌/临时区里的干员按路线热力图就近上场（近战找地面格、远程任意合法格），朝向面敌。 */
  function jarBotDeploy(m, ps) {
    const pieces = [...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)].filter((p) => p && p.kind === 'chess');
    if (!pieces.length) return;
    const heat = jarRouteHeat(m);
    const dir = jarRouteDir(m);
    const cands = [];
    for (const [key, cls] of ps.deployMap()) {
      const [r, c] = key.split(',').map(Number);
      let h = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) h += heat.get(`${r + dr},${c + dc}`) || 0;
      cands.push({ key, r, c, cls, h });
    }
    cands.sort((a, b) => b.h - a.h);
    const taken = new Set([...ps.board.keys()]);
    for (const p of pieces) {
      const rec = ps.gd.chess(p.id);
      const melee = !rec || rec.position !== 'RANGED';
      for (const t of cands) {
        if (taken.has(t.key)) continue;
        if (melee && t.cls === 'ranged') continue; // 近战只能落地面格
        const res = ps.move(p.uid, { area: 'board', row: t.r, col: t.c, dir });
        if (res && res.ok) { taken.add(t.key); break; }
      }
    }
  }

  /** AI 穿装：手牌里的纯属性装备穿到还有空槽的干员身上（有穿戴特效 / 消耗类不硬穿）。 */
  function jarBotEquip(m, ps) {
    const items = ps.hand.filter((p) => p && p.kind === 'item');
    if (!items.length) return;
    const ops = [...ps.board.values(), ...ps.hand.filter((p) => p && p.kind === 'chess')];
    const slots = m.gd.equipPerChess ?? 2;
    for (const it of items) {
      const rec = ps.gd.item(it.id);
      if (!rec || rec.itemType !== 'EQUIP') continue;
      const target = ops.find((o) => (o.items || []).length < slots);
      if (!target) break;
      const r = jarEquip(m, ps, it.uid, target.uid);
      if (!r || !r.ok) break;
    }
  }

  /** AI 放障碍物：每个未部署的障碍物放到「路线热力最高且空闲的地面格」。 */
  function jarBotObstacles(m, ps) {
    const st = state(m);
    const rec = st.jarShop && st.jarShop[ps.playerId];
    if (!rec) return;
    const heat = jarRouteHeat(m);
    const occ = new Set([...ps.board.keys()]);
    for (const o of (st.jarObstacles && st.jarObstacles[ps.playerId]) || []) if (o) occ.add(`${o.row},${o.col}`);
    const ground = [];
    for (const [key, cls] of ps.deployMap()) {
      if (cls === 'ranged' || occ.has(key)) continue;
      const [r, c] = key.split(',').map(Number);
      let h = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) h += heat.get(`${r + dr},${c + dc}`) || 0;
      ground.push({ r, c, key, h });
    }
    ground.sort((a, b) => b.h - a.h);
    for (const item of ['obstacleBasic', 'obstacleAdvanced']) {
      const tier = item === 'obstacleBasic' ? 'basic' : 'advanced';
      const owned = item === 'obstacleBasic' ? rec.obsBasic : rec.obsAdvanced;
      let left = Math.max(0, owned - jarObstacleCount(st, ps.playerId, tier));
      while (left-- > 0) {
        const t = ground.find((g) => !occ.has(g.key));
        if (!t) break;
        const res = jarDeployDevice(m, ps, item, t.r, t.c, false);
        if (!res || !res.ok) break;
        occ.add(t.key);
      }
    }
  }

  /** 驱动一个 AI 队友打完本波：商店 → 砸软罐+部署+穿装+障碍 → 砸敌人罐（敌人有 JAR_LEAD_IN 出场缓冲）→ 补部署。 */
  function jarBotRound(m, ps) {
    jarBotShop(m, ps);
    const st = state(m);
    const list = (st.jars && st.jars[ps.playerId]) || [];
    const rest = list.filter((j) => j && !j.smashed);
    // ① 先砸干员/道具罐：拿到人和装备
    for (const j of rest) {
      if (j.kind === 'enemy') continue;
      try { smashJar(m, ps, j.id); } catch { /* ignore */ }
    }
    // ② 部署 + 穿装 + 放障碍（敌人还没出场，AI 先布阵）
    jarBotDeploy(m, ps);
    jarBotEquip(m, ps);
    jarBotObstacles(m, ps);
    // ③ 再砸敌人罐：敌人按 JAR_LEAD_IN 延迟出场，AI 已就位；全部砸完战场才能收尾
    for (const j of rest) {
      if (j.kind !== 'enemy') continue;
      try { smashJar(m, ps, j.id); } catch { /* ignore */ }
    }
    jarBotDeploy(m, ps);
    // ④ 中期补买（击杀资金陆续入账）＋ 补部署（手牌里还有没上场的干员时）：只逛商店 / 部署，不再砸罐
    m.sched.setTimeout(() => {
      if (state(m).mode !== 'jar' || m.phase !== PHASE.COMBAT) return;
      try {
        jarBotShop(m, ps);
        jarBotDeploy(m, ps);
      } catch { /* ignore */ }
    }, JAR_BOT_FOE_DELAY_MS);
  }

  /** 每波战斗建立后驱动所有 AI 队友（仅 jar 模式）。 */
  function jarBotsPlay(m) {
    const st = state(m);
    if (st.mode !== 'jar' || m.phase !== PHASE.COMBAT) return;
    for (const ps of m.alivePlayers()) {
      if (!ps.isBot) continue;
      try { jarBotRound(m, ps); } catch { /* AI 逻辑异常不能拖垮对局 */ }
    }
  }

  /**
   * 无尽模式·小型首领血量倍率（相对其基础 maxHp）。每 10 回合抽一只精英级行走敌人当小型首领，单只高血量构成威胁；
   * 漏过即按泄漏扣 LP，逼玩家在砸罐途中回头处理——形成「每 10 回合一场小 boss」的节奏。
   */
  const JAR_MINI_BOSS_HP_MUL = 14;

  /** 无尽模式·小型首领漏怪（进点）的 LP 惩罚：普通罐中敌人漏 1 只扣 1 LP，小型首领漏 1 只扣 5 LP。
   *  引擎 jar 场 LP 按 leak 条目「计数」扣（settle.js：counted = leaked 中 counted!==false 的条目数；loss = min(cap, counted)），
   *  不走 lpr。故把小型首领的 leak 条目在结算前扩成 5 份，即让 counted 计数 ×5 → 扣 5 LP（cap≥5 时精确扣 5）。 */
  const JAR_MINI_BOSS_LEAK_LP = 5;

  /** 本玩家正在运行（live）的战斗场；没有则 null。 */
  function liveField(m, playerId) {
    return (m.fields || []).find((f) => f && f.live && Array.isArray(f.players) && f.players.includes(playerId)) || null;
  }

  /** 把一条消息发给本场战斗涉及的所有人类客户端（权威端 + 观战副本都应用，保持一致）。 */
  function sendBattleMsg(m, f, msgObj) {
    for (const other of m.alivePlayers()) {
      if (other.isBot) continue;
      m.sendTo(other.playerId, msgObj);
    }
  }

  /** battleInput 风格的一个 chess unit 条目（round.js battleInput 的棋子分支，board 坐标）。 */
  function jarUnitInput(ps, piece, row, col, dir) {
    const u = { uid: piece.uid, kind: 'chess', chessId: piece.id, row, col, dir: dir || dirOf(piece), items: (piece.items || []).map((i) => i.id) };
    if (ps.noAutoSkill) u.noAutoSkill = true;
    const pick = ps.diyPickOf(piece.id);
    if (pick) u.diy = { charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId };
    else if (ps.fieldsStandIn(piece.id)) u.standIn = true;
    else {
      const lo = ps.loadoutFor(ps.gd.chess(piece.id));
      u.skillIndex = lo.skillIndex;
      u.moduleId = lo.moduleId;
    }
    return u;
  }

  /**
   * 战斗中部署（jar 模式）：干员已落格（ps.move 的战斗中旁路），把它即时注入正在运行的战斗——
   * 客户端模拟（默认）→ b.jarDeploy 下发（runner 在 Battle 上调 deployFromInput）；服务端模拟 → 直接调。
   * spec 同步补写该 unit（服务器接管 / headless 校验重建战斗时干员也在，只是按开场部署出现在该格）。
   */
  function jarCombatDeploy(m, ps, piece, row, col, dir) {
    const f = liveField(m, ps.playerId);
    if (!f) return;
    const u = jarUnitInput(ps, piece, row, col, dir);
    if (f.spec) {
      const p = (f.spec.players || []).find((x) => x && x.playerId === ps.playerId);
      if (p && Array.isArray(p.units)) p.units.push({ ...u });
    }
    // 有服务端战斗（AI 队友 headless 战场 / 服务器接管）时直接注入；否则（人类客户端模拟）下发 b.jarDeploy。
    if (f.battle && typeof f.battle.deployFromInput === 'function') {
      try { f.battle.deployFromInput(ps.playerId, u); } catch { /* ignore */ }
    } else if (m.clientCombat) {
      sendBattleMsg(m, f, { t: 'b.jarDeploy', battleId: f.battleId, playerId: ps.playerId, unit: u });
    }
    m.markPrivate(ps);
  }

  /**
   * 把某个棋子的战斗单位彻底请出正在运行的战斗（jar）：棋子已经不在玩家阵容里（被合成吃掉 / 被场地更换消除）时，
   * 战斗里再留着它的单位就是「幽灵」——它之后被击倒会进 snap.down，点选却找不到对应棋子（只弹详情窗 / 无反应）。
   * 客户端模拟 → b.jarRetreat（runner 调 battle.retreatToBench：活的永久撤下、倒地的置 removed 不再进 down）；
   * 服务端模拟 → 直接调。
   */
  function jarPurgeUnit(m, ps, uid) {
    if (!Number.isInteger(uid)) return;
    const f = liveField(m, ps.playerId);
    if (!f) return;
    if (m.clientCombat) sendBattleMsg(m, f, { t: 'b.jarRetreat', battleId: f.battleId, playerId: ps.playerId, uid });
    else if (f.battle && typeof f.battle.retreatToBench === 'function') {
      try { f.battle.retreatToBench(ps.playerId, uid); } catch { /* ignore */ }
    }
  }

  /** 敌人罐 → 战斗 spawn 条目：按敌人位移选路线（地面 / 飞行，各取第一条匹配路线），数量只按罐子缩放。
   *  time 是「相对注入时刻的秒数」（battle.injectSpawns：this.time + time）——砸开罐子后等 JAR_LEAD_IN 秒敌人才走出。 */
  function jarEnemySpecs(m, ps, jar) {
    const count = Math.max(1, jar.count || 1);
    const def = m.gd.enemy(jar.enemyKey);
    const fly = !!(def && def.stats && def.stats.motion === 'FLY');
    const routes = (m.wave && m.wave.routes) || [];
    let routeIndex = 0;
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      if (r && (fly ? r.motion === 'FLY' : r.motion !== 'FLY' && r.motion !== 'E_NUM')) { routeIndex = i; break; }
    }
    return [{ enemyKey: jar.enemyKey, count, time: JAR_LEAD_IN, routeIndex, tag: 'bounty', ownerPlayerId: ps.playerId }];
  }

  /**
   * 战斗中砸出敌人罐：敌人延后 JAR_LEAD_IN 秒注入正在运行的战斗（从出生点走出，给玩家应对时间）——客户端模拟 →
   * b.jarSpawn 下发（runner 调 battle.injectSpawns，spec.time 为相对秒数）；服务端模拟 → 直接调（time 同为相对秒数）。
   * spec 同步补写（接管 / headless 重建时敌人也在，time 取战斗已进行时刻 + 缓冲）。
   */
  function injectJarEnemies(m, ps, jar) {
    const f = liveField(m, ps.playerId);
    const specs = jarEnemySpecs(m, ps, jar);
    if (!f) { m.toast(ps, 'warn', msg('战场已结算，罐中敌人未能出现')); return; }
    const gt = Number(f.progress && f.progress.gt) || 0;
    if (f.spec && Array.isArray(f.spec.spawns)) for (const s of specs) f.spec.spawns.push({ ...s, time: gt + JAR_LEAD_IN });
    // 有服务端战斗（AI 队友 headless 战场 / 服务器接管）直接注入；否则（人类客户端模拟）下发 b.jarSpawn。
    if (f.battle && typeof f.battle.injectSpawns === 'function') {
      try { f.battle.injectSpawns(specs.map((s) => ({ ...s, time: JAR_LEAD_IN }))); } catch { /* ignore */ }
    } else if (m.clientCombat) {
      sendBattleMsg(m, f, { t: 'b.jarSpawn', battleId: f.battleId, spawns: specs });
    }
  }

  /**
   * 最后一罐砸开：撤掉挂住战斗的「锚点」spawn——战斗恢复「无 pending 且无活敌即 cleared」的自然结束，
   * 回合不再等时限。spec 同步剥离（接管 / headless 重建时锚点不再回来）；客户端模拟走 b.jarClear（runner 调
   * battle.removeSpawnsByTag），服务端模拟直接调。人类玩家延迟几秒执行，给玩家把刚开出的干员/道具放下的时间。
   * AI 队友（服务端 headless 代跑）必须【立即】撤：headless 战斗不受真实时间 pacing、以最快速度跑完，
   * 3600 战斗秒上限 ≈ 3~4 真实秒就打满——4 秒延迟等不到它生效，锚点把战斗拖满上限，
   * 战果 endGt=3600 → 按战场时钟释放要 30 真实分钟 → 回合被 AI 的战场挂死、观战只见空场（用户 2026-10-17 报告）。
   */
  function clearJarAnchor(m, ps) {
    const run = () => {
      for (const f of (m.fields || [])) {
        if (!f || f.done || !Array.isArray(f.players) || !f.players.includes(ps.playerId)) continue;
        if (f.spec && Array.isArray(f.spec.spawns)) f.spec.spawns = f.spec.spawns.filter((s) => s && s.tag !== 'jar-anchor');
        if (m.clientCombat) sendBattleMsg(m, f, { t: 'b.jarClear', battleId: f.battleId });
        if (f.battle && typeof f.battle.removeSpawnsByTag === 'function') {
          try { f.battle.removeSpawnsByTag('jar-anchor'); } catch { /* ignore */ }
        }
      }
    };
    if (ps.isBot) { run(); return; }
    m.sched.setTimeout(run, JAR_ANCHOR_CLEAR_DELAY_MS);
  }

  // ---- 无尽模式（jar）：每 10 回合整张地图轮换 + 每 10 回合随机小型首领 ---------------------------------

  /** 无尽模式：每 10 回合整张地图（stage）轮换。round 1 沿用开局地形；进入 round 11/21/31… 时切到下一张，循环复用。
   *  只改 m.stageId / m.stage——棋盘（buildDeployMap 读 m.stage）、战斗（combat 读 m.stageId）、客户端视图（field meta 带 stageId）随之刷新。 */
  function jarRotateStage(m, r) {
    const st = state(m);
    if (!st.stageList) {
      const modeStages = (m.gd.mode && Array.isArray(m.gd.mode.stages)) ? m.gd.mode.stages.filter((id) => m.gd.stage(id)) : [];
      st.stageList = modeStages.length ? modeStages.slice()
        : Object.keys(m.gd.raw.stages || {}).filter((id) => m.gd.stage(id) && m.gd.stage(id).active !== false);
      st.stageIdx = st.stageList.indexOf(m.stageId);
      if (st.stageIdx < 0) st.stageIdx = 0;
    }
    if (r > 1 && (r - 1) % 10 === 0) st.stageIdx = (st.stageIdx + 1) % st.stageList.length;
    const id = st.stageList[st.stageIdx];
    if (id && id !== m.stageId) { m.stageId = id; m.stage = m.gd.stage(id); return true; }
    return false;
  }

  /** 无尽模式：小型首领候选池（精英级行走敌人——会动、非站桩、非飞行、非 token，且有 Spine 模型）。惰性缓存。 */
  function jarMiniBossPool(m) {
    const st = state(m);
    if (st.miniBossPool) return st.miniBossPool;
    const out = [];
    const all = (m.gd.raw && m.gd.raw.enemies) || {};
    for (const key of Object.keys(all)) {
      const e = m.gd.enemy(key);
      if (!e || !e.stats) continue;
      if (e.rank !== 'ELITE') continue;                 // 小型首领量级：精英（BOSS 太大、NORMAL 太弱）
      if (e.stats.motion !== 'WALK') continue;          // 必须会走（用户要求：不是固定不动的）
      if (e.tokenOnly || e.notCountInTotal) continue;   // 跳过 token / 不计入总量的占位
      if (!jarEnemyHasSpine(m, key)) continue;          // 无模型的小型首领不登场，避免立绘/模型丢失
      out.push(key);
    }
    st.miniBossPool = out;
    return out;
  }

  /** 无尽模式：第 10/20/30… 回合，给每位存活玩家的战场注入一只随机行走精英（高血量）当小型首领。
   *  走与罐中敌人相同的「战斗中注入」链路（b.jarSpawn / battle.injectSpawns，time 相对战斗秒），hpMul 拉高构成威胁；
   *  漏过即按泄漏扣 LP。st.lastMiniBoss 记下本轮抽到的 key，供立绘匹配（#62）。 */
  function jarSpawnMiniBoss(m) {
    const inactive = m.gd.inactiveEnemies;
    const pool = jarMiniBossPool(m).filter((k) => !(inactive && inactive.has(k)));
    if (!pool.length) return;
    const rj = rng(m, 'miniboss');
    const key = pool[Math.floor(rj() * pool.length)];
    state(m).lastMiniBoss = key;
    const def0 = m.gd.enemy(key);
    const name = (def0 && def0.name) || key;
    for (const ps of m.alivePlayers()) {
      const f = liveField(m, ps.playerId);
      if (!f) continue;
      const fly = !!(def0 && def0.stats && def0.stats.motion === 'FLY');
      const routes = (m.wave && m.wave.routes) || [];
      let routeIndex = 0;
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r && (fly ? r.motion === 'FLY' : r.motion !== 'FLY' && r.motion !== 'E_NUM')) { routeIndex = i; break; }
      }
      const spec = { enemyKey: key, count: 1, time: JAR_LEAD_IN, routeIndex, tag: 'jar-miniboss', ownerPlayerId: ps.playerId, mods: { hpMul: JAR_MINI_BOSS_HP_MUL } };
      const gt = Number(f.progress && f.progress.gt) || 0;
      if (f.spec && Array.isArray(f.spec.spawns)) f.spec.spawns.push({ ...spec, time: gt + JAR_LEAD_IN });
      if (m.clientCombat) sendBattleMsg(m, f, { t: 'b.jarSpawn', battleId: f.battleId, spawns: [spec] });
      else if (f.battle && typeof f.battle.injectSpawns === 'function') {
        try { f.battle.injectSpawns([{ ...spec, time: JAR_LEAD_IN }]); } catch { /* ignore */ }
      }
    }
    for (const ps of m.alivePlayers()) {
      if (!ps.isBot) m.sendTo(ps.playerId, { t: 'm.jarMiniBoss', key, name, round: m.round }); // #62 立绘横幅（原生立绘，客户端优先读覆盖位）
      m.toast(ps, 'warn', msg(`第 ${m.round} 回合 · 小型首领「${name}」登场！`));
    }
  }

  /** 无尽模式：结算前把每位玩家 lastResults 里 `tag:'jar-miniboss'` 的 leak 条目扩成 JAR_MINI_BOSS_LEAK_LP 份
   *  （原 1 + 补 4，counted 保持真），使 counted 计数 ×5 → loss = min(cap, counted) = 5（cap≥5 时精确扣 5）。
   *  只在 jar 模式生效。该扩写发生在 settle 读取 lastResults 之前、audit 的 check 读取之后（audit 包装在 orig 调用后
   *  读 lastResults，故看到的是扩写后的值），满足 audit 不变量 loss ≤ min(cap, counted)；total/win 不受影响（total 在
   *  spawn 时已计入，扩写只动泄漏统计、不增敌人）。 */
  function jarExpandMiniBossLeaks(m) {
    const st = state(m);
    if (st.mode !== 'jar') return;
    if (!m.lastResults || typeof m.lastResults.forEach !== 'function') return;
    m.lastResults.forEach((r) => {
      if (!r || !Array.isArray(r.leaked)) return;
      const expanded = [];
      for (const l of r.leaked) {
        if (l && l.tag === 'jar-miniboss' && l.counted !== false) {
          for (let i = 0; i < JAR_MINI_BOSS_LEAK_LP; i++) expanded.push(l); // 原 1 份 + 补 4 份
        } else {
          expanded.push(l);
        }
      }
      r.leaked = expanded;
    });
  }

  /**
   * 砸开一个罐子（无休整期：全程战斗中）：operator → 免费入整备区（acquireChess，满则返还提示）；enemy → 敌人
   * 延后 JAR_LEAD_IN 战斗秒（= 5 真实秒）注入正在运行的战斗（从出生点走出；无战斗在跑 → bounty 兜底随本波出现）；item → 道具进整备区（acquireItem，
   * 两件相同的自动合成金色，满则销毁提示）；buff（兜底）→ deployCapBonus += amt。
   * 单播 m.jarSmashed（队友看不到你开了什么），标记 smashed 后重发私有视图（客户端把该罐连同槽位从战场移除，格子让给部署）。
   */
  /** jar 的「战斗进行中」阶段：COMBAT + UNITE（联防）。联防阶段照常操作（用户 2026-10-17）：
   *  砸罐 / 罐中商店 / 穿装 / 卖件在联防阶段照常可用；出战协防的队友（联防战场的 players）还能继续部署。 */
  function jarPhaseOn(m) {
    const st = state(m);
    return st.mode === 'jar' && (m.phase === PHASE.COMBAT || m.phase === PHASE.UNITE);
  }

  /**
   * 砸开一个罐子。联防阶段（UNITE）也放行：罐子在联防开始前必然已全部砸开（战场收尾要求），
   * 这里放行只是保持语义一致，不改变任何行为。
   */
  function smashJar(m, ps, jarId) {
    const st = state(m);
    const inCombat = jarPhaseOn(m);
    if (m.phase !== PHASE.PREP && !inCombat) return fail(ERR.WRONG_PHASE);
    if (!jarId || typeof jarId !== 'string') return fail(ERR.BAD_MSG, 'bad jar id');
    const list = st.jars && st.jars[ps.playerId];
    if (!list) return fail(ERR.BAD_MSG, 'no jars this round');
    const jar = list.find((j) => j.id === jarId);
    if (!jar) return fail(ERR.BAD_TARGET, 'no such jar');
    if (jar.smashed) return fail(ERR.BAD_MSG, 'already smashed');
    jar.smashed = true;
    const content = { id: jar.id, kind: jar.kind };
    if (jar.kind === 'operator') {
      content.opId = jar.opId;
      const piece = ps.acquireChess(jar.opId, { source: 'jar' });
      if (!piece) m.toast(ps, 'warn', msg('整备区已满，罐中干员已返还'));
    } else if (jar.kind === 'enemy') {
      content.enemyKey = jar.enemyKey;
      content.count = jar.count || 1;
      if (inCombat || liveField(m, ps.playerId)) {
        // 战斗在跑：敌人延后 JAR_LEAD_IN 秒加入、从敌方出生点走出；不入 bounty（避免下一波重复出现）
        injectJarEnemies(m, ps, jar);
      } else {
        // 没有战斗在跑（服务端代跑 / 特殊回合）：敌人走 bounty 随本波战斗出现
        ps.bounties.push({ id: jar.id, card: { enemyKey: jar.enemyKey, count: jar.count || 1, name: '罐中敌人', desc: '砸罐子揭开的敌人', jar: true }, roundsLeft: 1, chooser: ps.playerId });
      }
    } else if (jar.kind === 'item') {
      content.itemId = jar.itemId;
      const piece = ps.acquireItem(jar.itemId, { source: 'jar' });
      if (!piece) m.toast(ps, 'warn', msg('整备区已满，罐中道具已销毁'));
    } else if (jar.kind === 'buff') {
      content.buff = jar.buff;
      content.amt = jar.amt;
      ps.deployCapBonus += jar.amt;
      ps.dirty();
    }
    m.markPrivate(ps);
    m.sendTo(ps.playerId, { t: 'm.jarSmashed', ...content });
    // 最后一罐：撤掉锚点（延迟几秒给玩家放下刚开出的东西），战斗恢复自然收尾——倒计时的运行逻辑不生效
    if (!list.some((j) => j && !j.smashed)) clearJarAnchor(m, ps);
    return OK;
  }

  /**
   * 战斗中穿装（jar 模式）：g.jarEquip {itemUid, targetUid}。手牌/整备区的装备穿到干员身上——
   * 未部署干员 → 常规 ps.equip（解除一次 PREP gate：战斗中穿装是本模式的正常玩法），装备随部署生效；
   * 已部署干员 → 仅纯属性 EQUIP（无穿戴特效），ps.equip 记账后 battle.equipItem 立即生效（items 内容实时读
   * unit.items）：客户端模拟 → b.jarEquip 下发（runner 调 battle.equipItem，'items' 事件驱动图标）；服务端模拟 → 直接调。
   * consume_on_equip（装备即销毁生效、不占槽：盟约之币 / 骑士储蓄罐 / 人事部文档 …）战斗中放行——效果在服务端
   * dispatchItem 里结算（资金 / 部署上限 / 抽干员等都与战斗无关），只是不往战斗单位上挂物品图标。
   * 其余注册了 onEquip 处理器的特效装备（改单位本体的，如博士投影）与槽位替换，战斗中不支持——给未部署干员穿。
   */
  function jarEquip(m, ps, itemUid, targetUid, replaceUid) {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    if (!jarPhaseOn(m) && m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const iloc = ps.find(itemUid);
    if (!iloc || iloc.piece.kind !== 'item' || (iloc.area !== 'hand' && iloc.area !== 'temp')) return fail(ERR.BAD_TARGET);
    const item = iloc.piece;
    const rec = m.gd.item(item.id);
    if (!rec || rec.itemType !== 'EQUIP') return fail(ERR.BAD_TARGET, 'not equipment');
    const tloc = ps.find(targetUid);
    if (!tloc || tloc.piece.kind !== 'chess' || tloc.area === 'equipped') return fail(ERR.BAD_TARGET);
    const deployed = tloc.area === 'board';
    // consume_on_equip：装备即销毁、不占槽——战斗中放行（效果服务端结算，无战斗侧图标）
    const consume = typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip');
    const ru = Number.isInteger(replaceUid) ? replaceUid : null;
    if (deployed && !consume) {
      const hkey = 'item:' + (typeof item.id === 'string' ? item.id.replace(/_[ab]$/, '') : '');
      const h = m.dispatcher && m.dispatcher.registry ? m.dispatcher.registry.get(hkey) : null;
      if (h && typeof h.onEquip === 'function') return fail(ERR.BAD_TARGET, '这件装备的穿戴特效无法在战斗中生效，请先部署干员再穿');
      // 满槽 + 没给 replaceUid（不是替换）→ 拒绝；带 replaceUid 的替换放行（战斗中支持替换装备）
      if ((tloc.piece.items || []).length >= (m.gd.equipPerChess ?? 2) && !ru) return fail(ERR.BAD_TARGET, '穿戴槽位已满（战斗中不支持替换）');
    }
    // 解除一次 PREP gate（仅本次 equip 调用）：战斗中穿装是本模式的正常玩法
    const beforeIds = (deployed && !consume) ? (tloc.piece.items || []).map((x) => x.id) : null;
    const origGate = typeof ps._gate === 'function' ? ps._gate : null;
    let res;
    if (origGate) {
      ps._gate = () => null;
      try { res = ps.equip(itemUid, targetUid, ru); } finally { ps._gate = origGate; }
    } else {
      res = ps.equip(itemUid, targetUid, ru);
    }
    if (!res || !res.ok) return res || fail(ERR.BAD_TARGET);
    // consume_on_equip 已销毁、不占槽：没有东西可挂到战斗单位上（效果已在 ps.equip 里结算）
    if (deployed && !consume) {
      const afterIds = (tloc.piece.items || []).map((x) => x.id);
      const replacedId = beforeIds ? (beforeIds.find((id) => !afterIds.includes(id)) || null) : null;
      const f = liveField(m, ps.playerId);
      if (f) {
        // spec 同步补写（接管 / headless 重建时装备也在）：替换后旧装备 id 要移除、新装备 id 加上
        if (f.spec) {
          const p = (f.spec.players || []).find((x) => x && x.playerId === ps.playerId);
          const u = p && Array.isArray(p.units) ? p.units.find((x) => x && x.uid === targetUid) : null;
          if (u) u.items = [...afterIds];
        }
        // 有服务端战斗（AI 队友 headless 战场 / 服务器接管）直接替换；否则（人类客户端模拟）下发 b.jarEquip
        if (f.battle && typeof f.battle.replaceItem === 'function') { try { f.battle.replaceItem(ps.playerId, targetUid, item.id, replacedId); } catch { /* ignore */ } }
        else if (m.clientCombat) sendBattleMsg(m, f, { t: 'b.jarEquip', battleId: f.battleId, playerId: ps.playerId, uid: targetUid, itemId: item.id, replaceUid: replacedId });
      }
    }
    return OK;
  }

  /**
   * 战斗中售卖干员（jar 模式）：核心 g.sell 的 _gate 只放行休整期，而 jar 全程战斗（无休整期），
   * 故新增本 intent——保留「售卖干员」功能。战斗中对场上已部署的干员，先撤掉战斗单位（与 jarRetreat 同一套路：
   * 客户端模拟走 b.jarRetreat、服务端模拟直接调 battle.retreatToBench），否则 placeCtx 摘掉后战斗单位仍留在场上造成脱节；
   * 整备区 / 手牌里的干员则直接售卖。再解除一次 PREP gate 调用 ps.sell 完成记账 + 发放资金。休整期也走本 intent（等价 g.sell）。
   */
  function jarSell(m, ps, uid) {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    if (!jarPhaseOn(m) && m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!Number.isInteger(uid)) return fail(ERR.BAD_TARGET);
    const loc = ps.find(uid);
    if (!loc || loc.piece.kind !== 'chess') return fail(ERR.BAD_TARGET);
    // 战斗中已部署在战场上的干员：先移除战斗单位，避免 placeCtx 摘掉后战斗单位仍在场上
    if (m.phase === PHASE.COMBAT && loc.area === 'board') jarPurgeUnit(m, ps, uid);
    // 解除一次 PREP gate（仅本次 sell 调用）：战斗中售卖是本模式的正常玩法
    const origGate = typeof ps._gate === 'function' ? ps._gate : null;
    let res;
    if (origGate) { ps._gate = () => null; try { res = ps.sell(uid); } finally { ps._gate = origGate; } }
    else res = ps.sell(uid);
    return res || fail(ERR.BAD_TARGET);
  }

  /** 敌人盲盒侦察：每波 1 次免费，之后 2×调度中心等级 资金。结果由 registerNextEnemiesAugment 的 partial 分支呈现。 */
  function scoutWave(m, ps) {
    const st = state(m);
    if (st.mode !== 'enemy' && st.mode !== 'all') return fail(ERR.BAD_MSG, 'enemy blind box off');
    if (m.phase === PHASE.LOBBY) return fail(ERR.WRONG_PHASE);
    const psc = (st.blindScout[ps.playerId] = st.blindScout[ps.playerId] || {});
    const rec = (psc[m.round] = psc[m.round] || { free: false, paid: 0 });
    if (!rec.free) {
      rec.free = true;
      m.markPrivate(ps);
      m.sendTo(ps.playerId, { t: 'm.toast', kind: 'success', text: msg('已侦察本波敌人（免费）') });
      return OK;
    }
    const lv = Math.trunc(Number(ps.shop && ps.shop.level)) || 1;
    const cost = 2 * lv;
    if (ps.funds < cost) return fail(ERR.NO_FUNDS, 'funds');
    ps.funds -= cost;
    rec.paid += 1;
    m.markPrivate(ps);
    m.sendTo(ps.playerId, { t: 'm.toast', kind: 'info', text: msg('花费 {n} 资金重新侦察', { n: cost }) });
    return OK;
  }

  // ---- jar 商店（砸罐子模式专属，用资金购买；价格服务端权威）--------------------------------------------------
  // 部署位 +1：第 1/2/3 次分别 8/10/12 资金，最多买 3 次（deployCapBonus +1 → ps.deployCap 实时生效）。
  // 生命 +1：4 资金起、每买一次 +2（4/6/8/…），不限次数（滚雪球自限）。
  // 复活一次：15 资金，整局只能买一个——下次己方干员被击倒时原地满血复活（战斗侧 kill 钩子，见文件顶部）。
  const JAR_SHOP_SLOT_PRICES = [8, 10]; // 部署位 +1：第 1/2 次分别 8/10 资金，最多买 2 次（deployCapBonus +1 → ps.deployCap 实时生效）
  const JAR_SHOP_LIFE_BASE = 4;
  const JAR_SHOP_LIFE_STEP = 2;
  const JAR_SHOP_REVIVE_PRICE = 15;
  const JAR_SHOP_OBSTACLE_BASIC_PRICE = 4;   // 初级障碍物：3000 血路障
  const JAR_SHOP_OBSTACLE_ADV_PRICE = 6;     // 高级障碍物：6000 血路障
  const JAR_SHOP_OBSTACLE_CAP = 3;           // 每种最多买 3 次

  /** 玩家的 jar 商店购买记录（惰性建）。 */
  function jarShopRec(m, ps) {
    const st = state(m);
    return (st.jarShop[ps.playerId] = st.jarShop[ps.playerId] || { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 });
  }

  /** 当前价格；null = 已售罄（部署位买满 3 次 / 复活已持有 / 障碍物某档买满 3 次）。 */
  function jarShopPrice(rec, item) {
    if (!rec) rec = { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 };
    if (item === 'slot') return rec.slots >= JAR_SHOP_SLOT_PRICES.length ? null : JAR_SHOP_SLOT_PRICES[rec.slots];
    if (item === 'life') return JAR_SHOP_LIFE_BASE + JAR_SHOP_LIFE_STEP * rec.life;
    if (item === 'revive') return rec.revive > 0 ? null : JAR_SHOP_REVIVE_PRICE;
    if (item === 'obstacleBasic') return rec.obsBasic >= JAR_SHOP_OBSTACLE_CAP ? null : JAR_SHOP_OBSTACLE_BASIC_PRICE;
    if (item === 'obstacleAdvanced') return rec.obsAdvanced >= JAR_SHOP_OBSTACLE_CAP ? null : JAR_SHOP_OBSTACLE_ADV_PRICE;
    return null;
  }

  /** 购买：g.jarShopBuy { item: 'slot'|'life'|'revive' }。PREP / COMBAT 均可（jar 全程战斗，无休整期商店）。 */
  function jarShopBuy(m, ps, item) {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    if (!jarPhaseOn(m) && m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (item !== 'slot' && item !== 'life' && item !== 'revive' && item !== 'obstacleBasic' && item !== 'obstacleAdvanced') return fail(ERR.BAD_TARGET);
    const rec = jarShopRec(m, ps);
    const price = jarShopPrice(rec, item);
    if (price == null) {
      const soldOutMsg = (item === 'obstacleBasic' || item === 'obstacleAdvanced')
        ? '障碍物库存已满（最多囤积 3 个，被摧毁后可再买）' : '该商品已售罄';
      return fail(ERR.BAD_TARGET, soldOutMsg);
    }
    if ((Number(ps.funds) || 0) < price) return fail(ERR.NO_FUNDS, 'funds');
    ps.funds -= price;
    if (item === 'slot') { rec.slots += 1; ps.deployCapBonus += 1; }
    else if (item === 'life') { rec.life += 1; ps.lp += 1; }
    else if (item === 'revive') { rec.revive += 1; jarRegrantRevive(m, ps); }
    else if (item === 'obstacleBasic') rec.obsBasic += 1;     // 战斗中由玩家手动部署到战场合法格（见 g.jarDeployDevice）
    else if (item === 'obstacleAdvanced') rec.obsAdvanced += 1;
    ps.dirty();
    m.markPrivate(ps);
    const label = {
      slot: msg('部署位 +1（当前 {n}）', { n: ps.deployCap }),
      life: msg('生命 +1（当前 {n}）', { n: ps.lp }),
      revive: msg('「复活一次」已生效：下次干员被击倒时原地复活'),
      obstacleBasic: msg('初级障碍物 +1（库存 {n}/3）：战斗中可手动部署到战场合法位置', { n: rec.obsBasic }),
      obstacleAdvanced: msg('高级障碍物 +1（库存 {n}/3）：战斗中可手动部署到战场合法位置', { n: rec.obsAdvanced }),
    }[item];
    m.toast(ps, 'success', msg('花费 {cost} 资金：{label}', { cost: price, label }));
    return OK;
  }

  /** 战斗开始（endPrep 创建战斗后）发放复活充能：对每场 live 战斗里持有充能的玩家授予 + 通知客户端副本。顺带 GC 授予表。 */
  function jarGrantRevives(m) {
    const st = state(m);
    const liveIds = new Set((m.fields || []).filter((f) => f && f.live && f.battleId).map((f) => f.battleId));
    for (const bid of [...jarReviveGrants.keys()]) {
      if (!liveIds.has(bid)) { jarReviveGrants.delete(bid); jarReviveCtx.delete(bid); }
    }
    for (const f of (m.fields || [])) {
      if (!f || !f.live || !f.battleId || !Array.isArray(f.players)) continue;
      for (const pid of f.players) {
        const ps2 = m.players.get(pid);
        if (!ps2 || ps2.isBot) continue;
        const rec = st.jarShop && st.jarShop[pid];
        if (!rec || rec.revive <= 0) continue;
        let g = jarReviveGrants.get(f.battleId);
        if (!g) jarReviveGrants.set(f.battleId, (g = new Map()));
        g.set(pid, Math.max(g.get(pid) || 0, rec.revive));
        if (!jarReviveCtx.has(f.battleId)) jarReviveCtx.set(f.battleId, { consume: (p) => jarReviveConsume(m, p) });
        if (m.clientCombat) sendBattleMsg(m, f, { t: 'b.jarReviveGrant', battleId: f.battleId, playerId: pid });
      }
    }
  }

  /** 战斗中购入复活：立即向正在进行的那场战斗补发授予（本波战斗结束后剩余充能照常结转）。 */
  function jarRegrantRevive(m, ps) {
    const f = liveField(m, ps.playerId);
    if (!f || !f.battleId) return;
    let g = jarReviveGrants.get(f.battleId);
    if (!g) jarReviveGrants.set(f.battleId, (g = new Map()));
    const rec = state(m).jarShop[ps.playerId];
    g.set(ps.playerId, Math.max(g.get(ps.playerId) || 0, rec.revive));
    if (!jarReviveCtx.has(f.battleId)) jarReviveCtx.set(f.battleId, { consume: (p) => jarReviveConsume(m, p) });
    if (m.clientCombat) sendBattleMsg(m, f, { t: 'b.jarReviveGrant', battleId: f.battleId, playerId: ps.playerId });
  }

  /** 战斗中部署一个障碍物（g.jarDeployDevice）：校验库存 > 0 → battle.spawnDevice 生成引擎原生阻隔工事 → 扣库存。
   *  客户端模拟：只转发生成（b.jarDeployDevice 由 runner 调 spawnDevice），库存改由 g.jarDeployDeviceDone 上报后扣，避免非法落格白扣。
   *  服务端模拟：直接生成并扣库存。
   *  @param fromRunner true 时走「上报已生成」路径：只校验库存并扣减（item 为档位名），不再触碰战斗。 */
  function jarDeployDevice(m, ps, item, row, col, fromRunner) {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    if (item !== 'obstacleBasic' && item !== 'obstacleAdvanced') return fail(ERR.BAD_TARGET);
    if (fromRunner) return OK; // 持久模型：部署不再经此回调改拥有数（意图时记入、被摧毁才释放）
    const rec = jarShopRec(m, ps);
    const tier = item === 'obstacleBasic' ? 'basic' : 'advanced';
    const hp = item === 'obstacleBasic' ? 3000 : 6000;
    const owned = item === 'obstacleBasic' ? rec.obsBasic : rec.obsAdvanced;
    if (m.phase !== PHASE.COMBAT && !(state(m).mode === 'jar' && m.phase === PHASE.UNITE)) return fail(ERR.WRONG_PHASE, '只能在战斗中部署障碍物');
    const placed = jarObstacleCount(st, ps.playerId, tier);
    if (owned - placed <= 0) return fail(ERR.BAD_TARGET, '没有可放置的障碍物（该档已全部在战场上）');
    if (!Number.isInteger(row) || !Number.isInteger(col)) return fail(ERR.BAD_TARGET, 'bad tile');
    const f = liveField(m, ps.playerId);
    if (!f || !f.battleId) return fail(ERR.BAD_TARGET, '当前没有进行中的战斗');
    // 记入持久部署表（跨回合保留，每波战斗建立后由 jarRespawnObstacles 重铺）
    (st.jarObstacles[ps.playerId] = st.jarObstacles[ps.playerId] || []).push({ tier, row, col });
    // 有服务端战斗（AI 队友 headless 战场 / 服务器接管）直接生成；否则（人类客户端模拟）下发 b.jarDeployDevice。
    if (f.battle && typeof f.battle.spawnDevice === 'function') {
      // jarObsTier/jarObsOwner 必须在 spawnDevice 发 spawn 事件前传入（否则客户端 UnitInfo 缺档位，高级障碍物无法着灰）
      const u = f.battle.spawnDevice(JAR_CRATE_KEY, row, col, { hp, obstacle: true, name: '障碍物', jarObsTier: tier, jarObsOwner: ps.playerId });
      if (!u) { jarObstacleRemoveAt(st, ps.playerId, tier, row, col); return fail(ERR.BAD_TARGET, '无法在该位置放置障碍物（需空置的合法地面格）'); }
      u.jarObsOwner = ps.playerId; u.jarObsTier = tier; // 兜底：旧版 sim 不支持 opts 时标签仍补在单位上
    } else if (m.clientCombat) {
      sendBattleMsg(m, f, { t: 'b.jarDeployDevice', battleId: f.battleId, playerId: ps.playerId, tier, row, col });
    } else {
      jarObstacleRemoveAt(st, ps.playerId, tier, row, col);
      return fail(ERR.BAD_TARGET, '战斗未就绪');
    }
    m.markPrivate(ps);
    m.toast(ps, 'success', msg('障碍物已部署（将持续存在，被敌人拆毁后可再买）'));
    return OK;
  }

  /** 玩家某档位已部署（在战场上、跨回合持久）的障碍物数量。 */
  function jarObstacleCount(st, pid, tier) {
    const arr = st.jarObstacles && st.jarObstacles[pid];
    return Array.isArray(arr) ? arr.filter((o) => o && o.tier === tier).length : 0;
  }
  /** jar 障碍物在「待部署区」独占格子：把最左侧 K 个手牌槽划给未部署的障碍物（K = 未部署数）。
   *  该清单随私有视图下发给客户端（jarShop.reservedSlots），客户端据此把障碍物投影到这些独占格，
   *  并在格内铺一块与整备格等大的底板，视觉上「独占一个格子」。物品按右→左填充（board.js freeSlot），
   *  天然先占右侧、不抢左侧独占格；不写入手牌数据，故不影响引擎不变量。 */
  function jarReservedSlots(m, ps) {
    const st = state(m);
    if (st.mode !== 'jar') return [];
    const rec = st.jarShop && st.jarShop[ps.playerId];
    if (!rec) return [];
    const basic = Math.max(0, (Number(rec.obsBasic) || 0) - jarObstacleCount(st, ps.playerId, 'basic'));
    const adv = Math.max(0, (Number(rec.obsAdvanced) || 0) - jarObstacleCount(st, ps.playerId, 'advanced'));
    const k = basic + adv;
    if (k <= 0) return [];
    const n = ps.hand ? ps.hand.length : 0;
    const out = [];
    for (let i = 0; i < k && i < n; i++) out.push(i);
    return out;
  }
  // 暴露给测试导出（障碍物待部署区独占格清单计算）。
  __jarReservedTestFn = { reservedSlots: jarReservedSlots };
  /** 从持久部署表移除指定格子的一条记录（部署失败回滚 / 被摧毁）；返回是否移除。 */
  function jarObstacleRemoveAt(st, pid, tier, r, c) {
    const arr = st.jarObstacles && st.jarObstacles[pid];
    if (!Array.isArray(arr)) return false;
    const i = arr.findIndex((o) => o && o.tier === tier && o.row === r && o.col === c);
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
  }

  /** 障碍物被敌人拆毁：从持久表移除 + 释放拥有数（可再买）。幂等（找不到记录则不扣）。 */
  function jarObstacleLost(m, pid, tier, r, c) {
    const st = state(m);
    if (!jarObstacleRemoveAt(st, pid, tier, r, c)) return;
    const rec = st.jarShop && st.jarShop[pid];
    if (rec) { if (tier === 'basic' && rec.obsBasic > 0) rec.obsBasic -= 1; else if (tier === 'advanced' && rec.obsAdvanced > 0) rec.obsAdvanced -= 1; }
    const ps = m.players.get(pid);
    if (ps) { m.markPrivate(ps); m.toast(ps, 'info', msg('障碍物被摧毁，可再买补回')); }
  }

  /** 每波战斗建立后（endPrep 包装里）：把各玩家持久部署的障碍物重铺进战场（服务端模拟直接生成；客户端模拟发 b.jarObstacles 由 runner 生成）。
   *  顺带注册 jarObstacleCtx（服务端摧毁回调）+ GC 非 live 战场。 */
  function jarRespawnObstacles(m) {
    const st = state(m);
    const liveIds = new Set((m.fields || []).filter((f) => f && f.live && f.battleId).map((f) => f.battleId));
    for (const bid of [...jarObstacleCtx.keys()]) if (!liveIds.has(bid)) jarObstacleCtx.delete(bid);
    const list = [];
    for (const [pid, arr] of Object.entries(st.jarObstacles || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const ps = m.players.get(pid); if (!ps || !ps.alive) continue;
      for (const o of arr) if (o && (o.tier === 'basic' || o.tier === 'advanced')) list.push({ tier: o.tier, row: o.row, col: o.col, playerId: pid });
    }
    for (const f of (m.fields || [])) {
      if (!f || !f.live || !f.battleId) continue;
      if (!jarObstacleCtx.has(f.battleId)) jarObstacleCtx.set(f.battleId, { lost: (pid, tier, r, c) => jarObstacleLost(m, pid, tier, r, c) });
      if (!list.length) continue;
      if (m.clientCombat) {
        sendBattleMsg(m, f, { t: 'b.jarObstacles', battleId: f.battleId, list });
      } else if (f.battle && typeof f.battle.spawnDevice === 'function') {
        for (const o of list) {
          // jarObsTier/jarObsOwner 在 spawn 事件前传入（同 jarDeployDevice：否则客户端 UnitInfo 缺档位，高级障碍物无法着灰）
          const u = f.battle.spawnDevice(JAR_CRATE_KEY, o.row, o.col, { hp: o.tier === 'advanced' ? 6000 : 3000, obstacle: true, name: '障碍物', jarObsTier: o.tier, jarObsOwner: o.playerId });
          if (u) { u.jarObsOwner = o.playerId; u.jarObsTier = o.tier; } // 兜底
        }
      }
    }
  }
  __jarDeployDeviceFn = jarDeployDevice; // 暴露给测试导出

  /** 每波战斗建立后（endPrep 包装里）：把冻结读档带来的「罐中敌人」重新注入战场。
   *  与 jarRespawnObstacles 同一时机——endPrep 已创建好本波战斗，liveField 可用；
   *  敌人从出生点走出（JAR_LEAD_IN 缓冲），与当场砸开罐子的表现一致，实现「把当前关卡冻结」。 */
  function jarRespawnFrozenEnemies(m) {
    const st = state(m);
    const fe = st.jarFrozenEnemies || {};
    for (const ps of m.alivePlayers()) {
      const specs = fe[ps.playerId];
      if (!specs || !specs.length) continue;
      fe[ps.playerId] = []; // 消费式，只生效一次
      const f = liveField(m, ps.playerId);
      if (!f) continue;
      for (const spec of specs) injectJarEnemies(m, ps, spec);
    }
  }

  /** 读档：g.jarLoadSave {data}。只校验 + 暂存到 pendingLoad（下一波 startRound 时应用），绕开 jar 600ms 休整期的竞态。PREP/COMBAT 均可发起。 */
  function jarLoadSave(m, ps, req) {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    const d = req && req.data;
    if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.roster)) return fail(ERR.BAD_MSG, 'bad save');
    // 同波次读档 = 冻结当前关卡：立即应用（含 jar 的 COMBAT——本波罐子已生成，砸开状态就地恢复）。
    // 开局第一波（PREP R1）同样立即生效，玩家在第一个休整期就能用上恢复的资金 / 阵容。
    const sameWave = Number.isInteger(d.round) && Number(d.round) === (Number(m.round) || 1);
    if (sameWave || (m.phase === PHASE.PREP && Number(m.round) <= 1)) {
      jarApplyLoad(m, ps, d);
      m.toast(ps, 'success', msg('已载入存档「{name}」，当前关卡已恢复', { name: String(d.name || '存档') }));
      return OK;
    }
    st.pendingLoad[ps.playerId] = d;
    m.toast(ps, 'info', msg('已读取存档「{name}」，将在下一波开始时生效', { name: String(d.name || '存档') }));
    return OK;
  }

  /** 把存档快照应用到玩家状态（在 startRound 包装器里、origSR 之后调用）：恢复标量 + 商店 + jarShop + 重建干员阵容 +
   *  冻结关卡（同地图恢复已部署障碍物位置；记录本波已砸开罐子，待 generateJars 后标记 smashed）。不跳回合（冻结回合由包装器改 round 参数）。
   *  快照形状：{ name, round, stageId, funds, lp, shopLevel, jarShop:{slots,life,revive,obsBasic,obsAdvanced}, obstacles:[{tier,row,col}], jars:[{row,col,kind?,enemyKey?,count?}], roster:[{kind:'chess'|'item',id,area,row,col,dir,items:[ids]}] }（jars 里 kind==='enemy' 的条目带 enemyKey/count，用于冻结读档后把放出的敌人重新注入战场） */
  function jarApplyLoad(m, ps, d) {
    if (!ps || !ps.alive) return;
    const st = state(m);
    // —— jarShop 账 + deployCapBonus（部署位购买次数）
    const js = (d.jarShop && typeof d.jarShop === 'object') ? d.jarShop : {};
    const slots = Math.max(0, Math.min(2, Math.floor(Number(js.slots) || 0)));
    st.jarShop[ps.playerId] = {
      slots,
      life: Math.max(0, Math.floor(Number(js.life) || 0)),
      revive: Math.max(0, Math.min(1, Math.floor(Number(js.revive) || 0))),
      obsBasic: Math.max(0, Math.min(3, Math.floor(Number(js.obsBasic) || 0))),
      obsAdvanced: Math.max(0, Math.min(3, Math.floor(Number(js.obsAdvanced) || 0))),
    };
    st.jarReviveUsed[ps.playerId] = {};
    // 已部署障碍物：仅当「当前地图与存档地图一致」(stageId 相同) 才恢复位置——否则会把旧障碍重铺到不同地形上改变地图；
    // 「拥有数量」(obsBasic/obsAdvanced) 无论如何都随上方 jarShop 恢复，玩家在新地图上可重新部署（不会改地形）。
    if (d.stageId != null && d.stageId === m.stageId && Array.isArray(d.obstacles)) {
      st.jarObstacles[ps.playerId] = d.obstacles
        .filter((o) => o && (o.tier === 'basic' || o.tier === 'advanced') && Number.isInteger(o.row) && Number.isInteger(o.col))
        .map((o) => ({ tier: o.tier, row: o.row, col: o.col }));
    }
    // 已砸开罐子（冻结当前关卡）：记录格子集合。本波罐子已生成且不会再重建
    //（phase 处于 PREP/COMBAT 且 jarsRound 一致——含 jar 无休整期的 COMBAT 中读档）就地标记；
    // 否则（startRound 边界 / 暂存到下一波）留给随后的 generateJars 消费——不能提前标，
    // 因为紧接着 enterPrep 的 generateJars 会清空重建罐子，标记会被抹掉。
    if (Array.isArray(d.jars) && d.jars.length) {
      const set = new Set();
      for (const j of d.jars) {
        if (j && Number.isInteger(j.row) && Number.isInteger(j.col)) set.add(`${j.row},${j.col}`);
      }
      if (set.size) {
        const list = st.jars && st.jars[ps.playerId];
        const inWave = m.phase === PHASE.PREP || m.phase === PHASE.COMBAT;
        if (inWave && Array.isArray(list) && list.length && st.jarsRound === (Number(m.round) || 1)) {
          for (const j of list) if (set.has(`${j.row},${j.col}`)) j.smashed = true;
          m.markPrivate(ps);
        } else {
          st.jarPendingSmash[ps.playerId] = set;
        }
      }
    }
    // 冻结读档：罐中放出来的敌人也要随关卡一起恢复——否则读档后敌人直接消失（「卡没掉」）。
    // 敌人是战斗中 inject 进战场的运行时实体，不进进度快照，故需从 d.jars 里带出的 spec 重建：
    // 此刻就有在跑的战斗（同波次战斗中读档）→ 立即注入；否则（PREP / 回合边界，战斗尚未建立）→ 暂存，
    // 等 endPrep 战斗建立后由 jarRespawnFrozenEnemies 注入（与 jarRespawnObstacles 同一时机）。
    const frozenJars = (Array.isArray(d.jars) ? d.jars : []).filter((j) => j && j.kind === 'enemy' && typeof j.enemyKey === 'string' && Number.isInteger(j.row) && Number.isInteger(j.col));
    if (frozenJars.length) {
      const specs = frozenJars.map((j) => ({ enemyKey: j.enemyKey, count: Number(j.count) || 1 }));
      const f = liveField(m, ps.playerId);
      if (f && m.phase === PHASE.COMBAT) {
        for (const spec of specs) injectJarEnemies(m, ps, spec);
      } else {
        if (!st.jarFrozenEnemies[ps.playerId]) st.jarFrozenEnemies[ps.playerId] = [];
        for (const spec of specs) st.jarFrozenEnemies[ps.playerId].push(spec);
      }
    }
    ps.deployCapBonus = slots;
    // —— 标量
    ps.funds = Math.max(0, Math.floor(Number(d.funds) || 0));
    ps.lp = Math.max(1, Math.floor(Number(d.lp) || 1));
    // —— 调度中心等级（同步 upgradePrice + slots/layout，满足 shop 不变量）
    const maxLv = ps.gd.maxShopLevel || 6;
    const lv = Math.max(1, Math.min(maxLv, Math.floor(Number(d.shopLevel) || 1)));
    ps.shop.level = lv;
    ps.shop.upgradePrice = ps.gd.upgradeBase(lv) ?? 0;
    const layout = ps.gd.shopSlots(lv);
    const need = (layout.chess || 0) + (layout.item || 0);
    const old = Array.isArray(ps.shop.slots) ? ps.shop.slots : [];
    ps.shop.slots = Array.from({ length: need }, (_, i) => (i < old.length ? old[i] : null));
    ps.shop.layout = layout;
    // —— 清空现有阵容（照 eliminate 的返还范式：召唤物移除 + pool 份数返还 + 三清）
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) {
      if (p && p.kind === 'chess') ps.removeTokensOf(p.uid);
      if (p) ps.returnCopies(p);
    }
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); if (ps._tempDue && ps._tempDue.clear) ps._tempDue.clear();
    // —— 重建：先 board（守部署上限；非法格交给 recompute 的 _evictIllegal 自动撤回手牌），再 hand，再 temp
    const cap = ps.deployCap;
    const mkItems = (piece, ids) => { for (const iid of (ids || [])) { const s = String(iid); if (ps.gd.item(s)) piece.items.push(ps.newPiece('item', s)); } };
    const roster = Array.isArray(d.roster) ? d.roster : [];
    let deployed = 0;
    for (const e of roster) {
      if (!e || e.kind !== 'chess' || e.area !== 'board') continue;
      const id = String(e.id); const rec = ps.gd.chess(id); if (!rec) continue;
      if (deployed >= cap || !Number.isInteger(e.row) || !Number.isInteger(e.col)) continue;
      const base = ps.gd.baseIdOf(id);
      const taken = ps.poolOf(base).take(base, rec.isGolden ? ps.gd.goldenCopies : 1);
      const piece = ps.newPiece('chess', id, { poolCopies: taken, dir: typeof e.dir === 'string' ? e.dir : 'RIGHT' });
      mkItems(piece, e.items);
      ps.board.set(`${e.row},${e.col}`, piece);
      deployed++;
    }
    for (const e of roster) {
      if (!e || e.kind !== 'chess' || e.area !== 'hand') continue;
      const id = String(e.id); const rec = ps.gd.chess(id); if (!rec) continue;
      const base = ps.gd.baseIdOf(id);
      const taken = ps.poolOf(base).take(base, rec.isGolden ? ps.gd.goldenCopies : 1);
      const piece = ps.newPiece('chess', id, { poolCopies: taken });
      mkItems(piece, e.items);
      ps.stow(piece, { allowTemp: false });
    }
    for (const e of roster) {
      if (!e || e.kind !== 'chess' || e.area !== 'temp') continue;
      const id = String(e.id); const rec = ps.gd.chess(id); if (!rec) continue;
      const base = ps.gd.baseIdOf(id);
      const taken = ps.poolOf(base).take(base, rec.isGolden ? ps.gd.goldenCopies : 1);
      const piece = ps.newPiece('chess', id, { poolCopies: taken });
      mkItems(piece, e.items);
      ps.stow(piece, { toTemp: true });
    }
    // —— 重建独立道具（开罐子获得、尚未装到干员身上的装备）：优先手牌、溢出进临时区
    for (const e of roster) {
      if (!e || e.kind !== 'item') continue;
      const id = String(e.id); if (!ps.gd.item(id)) continue;
      const piece = ps.newPiece('item', id);
      ps.stow(piece, { allowTemp: true, toTemp: e.area === 'temp' });
    }
    // —— 召唤物 stack 交给 grantTokensFor 重建（场上已部署的召唤物丢失，玩家重新拖出）
    for (const p of ps.board.values()) if (p && p.kind === 'chess') ps.grantTokensFor(p);
    ps.recompute();
    m.markPrivate(ps);
    // 冻结读档：把存档里的完整罐子布局原样恢复（地形 / 罐位 / 已砸开状态与存档那一刻完全一致，不重新随机）。
    // 同时覆盖「同波次立即冻结」与「跨波次 pending」两条路径：在跨波次 startRound 路径里，jarApplyLoad 于 generateJars
    // 之后执行，这里直接覆盖其随机结果即可。未砸开罐子的内容由快照完整携带，故读档后砸开仍给出与原存档一致的奖励。
    const fullJars = (Array.isArray(d.jars) ? d.jars : []).filter((j) => j && typeof j.kind === 'string' && Number.isInteger(j.row) && Number.isInteger(j.col));
    if (fullJars.length) {
      st.jars[ps.playerId] = fullJars.map((j) => ({
        id: j.id || `jar:${ps.playerId}:${m.round}:${j.row},${j.col}`, kind: j.kind, smashed: !!j.smashed,
        row: j.row, col: j.col, opId: j.opId, enemyKey: j.enemyKey, count: j.count, itemId: j.itemId, buff: j.buff, amt: j.amt,
      }));
      st.jarsRound = Number(m.round) || 1;
      m.markPrivate(ps);
    }
  }
  __jarSaveTestFn = { apply: jarApplyLoad, load: jarLoadSave }; // 暴露给测试导出
  __jarEnemyTestFn = { tier: jarEnemyTier, pool: enemyPool, hasSpine: jarEnemyHasSpine }; // 暴露给测试导出（强度分档 / 回合敌池 / Spine 素材过滤）

  /** 服务端模拟下的充能消耗（kill 钩子回调）：扣减 match 状态 + 单播提示。 */
  function jarReviveConsume(m, pid) {
    const st = state(m);
    const rec = st.jarShop && st.jarShop[pid];
    if (!rec || rec.revive <= 0) return;
    rec.revive -= 1;
    const ps2 = m.players.get(pid);
    if (ps2) { m.markPrivate(ps2); m.toast(ps2, 'info', msg('「复活一次」生效：干员原地复活')); }
  }

  /** 客户端模拟的消耗上报（g.jarReviveUsed {battleId, playerId, n}，n 累计）：按增量去重扣减——同一上报重发安全。 */
  function jarReviveUsed(m, ps, req) {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    if (typeof req.battleId !== 'string' || !req.battleId || req.playerId !== ps.playerId) return fail(ERR.BAD_TARGET);
    const rec = jarShopRec(m, ps);
    const usedMap = (st.jarReviveUsed[ps.playerId] = st.jarReviveUsed[ps.playerId] || {});
    const prev = usedMap[req.battleId] || 0;
    const accept = Math.max(0, Math.min((Number(req.n) || 0) - prev, rec.revive));
    if (accept > 0) {
      rec.revive -= accept;
      usedMap[req.battleId] = prev + accept;
      m.markPrivate(ps);
    }
    return OK;
  }

  api.registerIntent('g.blindBoxSet', (m, ps, req) => blindBoxSet(m, ps, req.mode));
  api.registerIntent('g.blindBoxGet', (m, ps) => blindBoxGet(m, ps));
  api.registerIntent('g.scoutWave', (m, ps) => scoutWave(m, ps));
  api.registerIntent('g.smashJar', (m, ps, req) => smashJar(m, ps, req.jarId));
  api.registerIntent('g.jarEquip', (m, ps, req) => jarEquip(m, ps, req.itemUid, req.targetUid, req.replaceUid));
  api.registerIntent('g.jarSell', (m, ps, req) => jarSell(m, ps, req.uid));
  api.registerIntent('g.jarShopBuy', (m, ps, req) => jarShopBuy(m, ps, req.item));
  api.registerIntent('g.jarReviveUsed', (m, ps, req) => jarReviveUsed(m, ps, req));
  api.registerIntent('g.jarDeployDevice', (m, ps, req) => jarDeployDevice(m, ps, req.item, req.row, req.col, false));
  api.registerIntent('g.jarDeployDeviceDone', (m, ps, req) => jarDeployDevice(m, ps, req.item, 0, 0, true));
  api.registerIntent('g.jarLoadSave', (m, ps, req) => jarLoadSave(m, ps, req));
  api.registerIntent('g.jarStartAndLoad', (m, ps, req) => jarStartAndLoad(m, ps, req));
  api.registerIntent('g.jarObstacleLost', (m, ps, req) => {
    const st = state(m);
    if (st.mode !== 'jar') return fail(ERR.BAD_MSG, 'jar mode only');
    const tier = req.item === 'obstacleAdvanced' ? 'advanced' : (req.item === 'obstacleBasic' ? 'basic' : null);
    if (!tier || !Number.isInteger(req.row) || !Number.isInteger(req.col)) return fail(ERR.BAD_TARGET);
    jarObstacleLost(m, ps.playerId, tier, req.row, req.col);
    return OK;
  });

  // ---- 引擎挂点 ---------------------------------------------------------------------------------------------

  // 测试 / 工具入口：把罐子再生函数挂到 MOD 状态上（测试在指定 round 直接调 m.mods.blindbox.generate() 重新生成）。
  // 同时包住每个玩家的 ps.move：jar 模式下战场上有正在跑的战斗（休整期遭遇战或本波战斗）时，落格干员即时注入——
  // PREP 走原生 move 全量校验（休整 UI 照常拖拽），COMBAT 走 _moveChessToBoard 旁路（绕过 PREP 门禁）。
  api.registerMatchInit((m) => {
    state(m).generate = () => generateJars(m);
    // 无尽模式（jar）：轮次无限推进 + 每 10 回合换地形 + 每 10 回合小型首领。仅影响 jar 模式。
    // 无限推进靠 blindBoxSet 把 gd.bossRound/hiddenRound 实例遮蔽为「永不触发」（m.gd 是每局独立实例，不影响其他对局）；
    // 这里只挂「换地形」（startRound 前切 m.stage）与「注入小型首领」（endPrep 后，战斗已创建）。
    if (typeof m.startRound === 'function' && !m.__jarStartRoundWrapped) {
      m.__jarStartRoundWrapped = true;
      const origSR = m.startRound;
      m.startRound = function (r) {
        const st = state(m);
        // 冻结读档（大厅「开始独立模拟 → 读取存档」）：用存档的回合数开波——地形（jarRotateStage）、
        // 本波敌人模板、罐子布局全部与存档那一刻一致，实现「把当前关卡冻结」。
        if (st.mode === 'jar' && st.pendingLoad) {
          for (const [, d] of Object.entries(st.pendingLoad)) {
            if (d && d.__freeze && Number.isInteger(d.round) && d.round > 0) {
              r = d.round;
              // 冻结地形：用存档的 stageId 还原地图。jar 每 10 回合换地形，新开局时 stageIdx 是从当前 m.stageId 重新播种的，
              // 不还原就会拿到与存档不同的地图（「读取存档改变地形」的根因）。还原后把 stageIdx 置空，让 jarRotateStage 从
              // 还原后的 m.stageId 重新播种，保证地形轨迹与存档一致。
              if (d.stageId != null && d.stageId !== m.stageId) {
                m.stageId = d.stageId;
                try { m.stage = m.gd.stage(d.stageId); } catch { /* ignore */ }
              }
              st.stageIdx = null;
              break;
            }
          }
        }
        if (st.mode === 'jar') {
          // 换地形（每 10 回合）后让旧战场的部署图缓存失效：否则 recompute 的合法性检查仍用旧图，
          // 站在新地图非法格 / 已不在场上的干员不会被处理。失效后 recompute 触发 jar 版
          // _evictIllegal（下方 ps 包装）——非法格干员强制消除，不撤回整备区（用户 2026-10-15）。
          if (jarRotateStage(m, r)) {
            for (const ps of m.alivePlayers()) if (typeof ps.invalidateDeployMap === 'function') ps.invalidateDeployMap();
          }
        }
        const ret = origSR.call(m, r);
        // 读档：本波 round 边界应用暂存快照（此刻无战斗、enterPrep 未跑，最安全）；消费式，只生效一次
        if (st.mode === 'jar' && st.pendingLoad) {
          for (const [pid, d] of Object.entries(st.pendingLoad)) {
            const p = m.players.get(pid);
            if (p && !p.isBot) { try { jarApplyLoad(m, p, d); } catch { /* ignore */ } }
            delete st.pendingLoad[pid];
          }
        }
        return ret;
      };
    }
    if (typeof m.endPrep === 'function' && !m.__jarEndPrepWrapped) {
      m.__jarEndPrepWrapped = true;
      const origEndPrepMatch = m.endPrep;
      m.endPrep = function () {
        const wasJar = state(m).mode === 'jar';
        const r = m.round;
        const ret = origEndPrepMatch.call(m);
        if (wasJar && r % 10 === 0) jarSpawnMiniBoss(m);
        if (wasJar) jarGrantRevives(m); // jar 商店：战斗建立后向持有「复活一次」充能的玩家发放授予（见文件顶部）
        if (wasJar) jarRespawnObstacles(m); // jar 商店：每波战斗建立后把持久部署的障碍物重铺进战场（跨回合保留）
        if (wasJar) jarRespawnFrozenEnemies(m); // jar 读档：把冻结关卡里「已砸开敌人罐」放出的敌人重新注入战场（防读档后敌人消失）
        if (wasJar) jarBotsPlay(m); // jar 商店：AI 队友真正下场——买罐中商店 / 砸罐部署 / 放障碍物
        return ret;
      };
    }
    // jar 模式：随时随地查看队友。引擎默认「自己普通战斗 live 时不能观战队友」，而 jar 战斗无尽（own.live 恒真）
    // 会把这条路永久堵死。这里对 jar 模式放行：活人玩家也可在自己战斗进行中观看队友的普通战场
    // （g.watch → _startMsg watch 副本 + 「返回战场」）；boss / hidden（另一组）仍旧禁看。
    if (typeof m._watchClient === 'function' && !m.__jarWatchWrapped) {
      m.__jarWatchWrapped = true;
      const origWatchClient = m._watchClient;
      m._watchClient = function (ps, fieldId, playerId = null) {
        const r = origWatchClient.call(this, ps, fieldId, playerId);
        if (state(m).mode === 'jar' && (!r || r.ok !== true) && ps && ps.alive && !ps.isBot && typeof fieldId === 'string') {
          const f = this.fields.find((x) => x && x.fieldId === fieldId) || null;
          const own = this.fields.find((x) => Array.isArray(x.players) && x.players.includes(ps.playerId)) || null;
          if (f && f.kind === 'normal' && own && own !== f && f.live !== false) {
            this.watchers.set(ps.playerId, f.fieldId);
            this._watchPrefSet(ps, f, playerId);
            this.sendTo(ps.playerId, this._startMsg(f, ps.playerId, { watch: true }));
            return OK;
          }
        }
        return r;
      };
    }
    // jar 模式：本波普通敌人全部禁用——所有怪只能来自罐子。time: Infinity = 永不派出（Battle._queueSpawn 跳过：
    // 不计入 total、buildBattleSpec 滤出 spec，客户端同一规则）； bounty / onBattleStart 改过的 spawns 一并禁用。
    // 另挂一个「锚点」spawn（遥远的时刻、countInTotal:false）：没有它 _pending 为空，autoFinish 会在战斗第一拍
    // 就宣布 cleared，玩家一局都砸不到。时限抬到 JAR_BATTLE_LIMIT（引擎硬顶）：本波倒计时的运行逻辑在 jar 不生效，
    // 回合由「最后一罐砸开（撤锚点，b.jarClear / removeSpawnsByTag）+ 敌人清完」自然收尾。
    // 无尽模式（jar）：小型首领漏怪进点扣 5 LP。引擎 jar 场 LP 按 leak 条目计数扣（settle.js），不走 lpr——
    // 在结算前把 lastResults 里 tag==='jar-miniboss' 的 leak 条目扩成 5 份，使 counted ×5 → 扣 5（cap≥5 时精确扣 5）。
    // 该扩写发生在 settle 读取 lastResults 之前、audit 的 check（读 lastResults）之后，满足 audit 不变量。
    if (typeof m.settle === 'function' && !m.__jarSettleWrapped) {
      m.__jarSettleWrapped = true;
      const origSettle = m.settle;
      m.settle = function (plan, uniteResult) {
        if (state(m).mode === 'jar') jarExpandMiniBossLeaks(m);
        return origSettle.call(m, plan, uniteResult);
      };
    }
    if (typeof m._normalOpts === 'function' && !m.__jarLeadWrapped) {
      m.__jarLeadWrapped = true;
      const origOpts = m._normalOpts;
      m._normalOpts = function (ps) {
        const opts = origOpts.call(this, ps);
        if (state(m).mode === 'jar' && opts && Array.isArray(opts.spawns)) {
          const wave = opts.spawns.filter((s) => s && typeof s.enemyKey === 'string');
          opts.timeLimit = JAR_BATTLE_LIMIT;
          const anchorKey = (wave[0] && wave[0].enemyKey) || enemyPool(m, rng(m, 'jars'))[0] || null;
          opts.spawns = wave.map((s) => ({ ...s, time: Infinity }));
          // 锚点只在还有未砸的罐时才挂：战斗建立前罐子已被砸完（罕见）就不再挂——没人会再来撤它，
          // 战斗按「无 pending 且无活敌即 cleared」自然收尾。
          const jars = (state(m).jars && state(m).jars[ps.playerId]) || [];
          if (anchorKey && jars.some((j) => j && !j.smashed)) {
            opts.spawns.push({
              enemyKey: anchorKey, count: 1, time: JAR_BATTLE_LIMIT + 600,
              countInTotal: false, routeIndex: wave[0] && Number.isInteger(wave[0].routeIndex) ? wave[0].routeIndex : 0,
              tag: 'jar-anchor', ownerPlayerId: ps.playerId,
            });
          }
        }
        return opts;
      };
    }
    for (const ps of m.players.values()) {
      // ---- 永续技能跨回合延续（jar 专属）----
      // 引擎侧：battleInput 的 carryState.skillEndless 让上一场结束时仍在生效的「持续时间无限」技能（kind 'toggle'）
      // 跨战斗保持开启（server/sim/battle/deploy.js；unitsEnd.skillEndless 由战斗结果上报）。
      // jar 模式里每一波都是一场新战斗，回合更换默认会把技能重置成关着——玩家开启的永续技能因此白开，故在这里续上。
      // 只认「上一场结束时还活着且永续技能仍在生效」的干员：阵亡 / 已撤离的不续（它的技能本来就该重置）。
      const origBattleInput = ps.battleInput;
      ps.battleInput = function (opts = {}) {
        const inp = origBattleInput.call(this, opts);
        const stj = state(m);
        if (stj.mode !== 'jar' || !inp || !Array.isArray(inp.units) || !inp.units.length) return inp;
        const pp = m.lastResults && typeof m.lastResults.get === 'function' ? m.lastResults.get(this.playerId) : null;
        const list = pp && Array.isArray(pp.unitsEnd) ? pp.unitsEnd : null;
        if (!list || !list.length) return inp;
        const on = new Set();
        for (const u of list) if (u && u.alive && u.skillEndless && Number.isInteger(u.uid)) on.add(u.uid);
        if (!on.size) return inp;
        for (const u of inp.units) {
          if (u && on.has(u.uid)) u.carryState = { ...(u.carryState && typeof u.carryState === 'object' ? u.carryState : null), skillEndless: true };
        }
        return inp;
      };
      const origMove = ps.move;
      ps.move = function (uid, to, dir) {
        const jarOn = state(m).mode === 'jar';
        const live = jarOn && to && to.area === 'board' ? liveField(m, this.playerId) : null;
        // jar 战斗中撤离（to.area 'hand'：被击倒/存活的干员主动撤回待部署区；'temp'：待部署区已满，溢出到临时手牌区）。
        // PREP 的撤离走原生路径。
        const retreatTo = jarOn && m.phase === PHASE.COMBAT && to && (to.area === 'hand' || to.area === 'temp');
        const liveHand = jarOn && to && (to.area === 'hand' || to.area === 'temp') && m.phase === PHASE.COMBAT ? liveField(m, this.playerId) : null;
        if (!live && !retreatTo) return origMove.call(this, uid, to, dir);
        const loc = this.find(uid);
        if (!loc || loc.area === 'equipped') return fail(ERR.BAD_TARGET);
        const piece = loc.piece;
        if (retreatTo) {
          if (loc.area !== 'board' || !piece || piece.kind !== 'chess') return fail(ERR.BAD_TARGET, '只有场上的干员能撤离到整备区');
          // 战斗侧移除：活的直接撤下（permanent，不倒地）；被击倒的不再自动回到场上、倒地占格释放
          let ra = null, rt = 0;
          if (liveHand) {
            if (liveHand.battle && typeof liveHand.battle.retreatToBench === 'function') {
              const u = liveHand.battle.allyUnits && liveHand.battle.allyUnits.find((x) => x.uid === uid && x.ownerId === this.playerId && x.kind === 'op' && !x.removed);
              if (u) { ra = u.respawnAt; rt = Math.max(0, u.respawnAt - (u.deathAt || 0)); }
              try { liveHand.battle.retreatToBench(this.playerId, uid); } catch { /* ignore */ }
            }
            if (m.clientCombat) sendBattleMsg(m, liveHand, { t: 'b.jarRetreat', battleId: liveHand.battleId, playerId: this.playerId, uid });
          }
          // 棋子回整备区（绕 PREP 门禁，与 jarEquip 同一套路）；把再部署倒计时挂到棋子，便于客户端在待部署区显示倒计时
          const gate = typeof this._gate === 'function' ? this._gate : null;
          let r;
          if (to.area === 'temp') {
            // 待部署区已满：溢出到临时手牌区（原生 stow 的溢出语义），不能因为满仓就让「主动撤离」失败（用户 2026-10-13）。
            // jar 无休整期，故把到期推远——否则下一次 endPrep 的 resolveTemp 会把这个还在倒计时的干员自动卖掉；
            // 待部署区一有空位，_fillHandFromTemp 会把它自动回流。
            const idx = Number.isInteger(to.idx) ? to.idx : -1;
            if (idx < 0 || idx >= this.temp.length || this.temp[idx] != null) r = fail(ERR.HAND_FULL);
            else {
              this.board.delete(loc.key);
              this.removeTokensOf(piece.uid);
              this._putTemp(idx, piece);
              this._tempDue.set(piece.uid, this.prepsEnded + 99);
              this.recompute();
              r = OK;
            }
          } else if (gate) {
            this._gate = () => null;
            try { r = origMove.call(this, uid, to, dir); } finally { this._gate = gate; }
          } else r = origMove.call(this, uid, to, dir);
          if (ra != null) { const after = this.find(uid); if (after && after.piece) { after.piece.respawnAt = ra; after.piece.respawnTime = rt; } }
          return r;
        }
        if (!Number.isInteger(to.row) || !Number.isInteger(to.col)) return fail(ERR.BAD_TARGET, 'bad tile');
        const fromBoard = loc.area === 'board';
        if (m.phase === PHASE.PREP) {
          // 遭遇战进行中的休整期：正常拖拽全量校验落格；已在棋盘上的干员本就在战斗快照里，挪位不重复注入
          if (!piece || piece.kind !== 'chess') return origMove.call(this, uid, to, dir);
          const res = origMove.call(this, uid, to, dir);
          if (res && res.ok && !fromBoard) jarCombatDeploy(m, this, piece, to.row, to.col, dir ?? to.dir ?? null);
          return res;
        }
        // 联防阶段（jar + UNITE）也走战斗中部署路径：出战协防的队友（联防战场 players）继续部署干员；
        // 漏怪方不在联防战场玩家列表里，下面有专门的席位拦截（部署会成幽灵棋子）。
        const jarUnite = jarOn && m.phase === PHASE.UNITE;
        if (m.phase !== PHASE.COMBAT && !jarUnite) return origMove.call(this, uid, to, dir);
        if (!piece || piece.kind !== 'chess') return fail(ERR.BAD_TARGET, 'only operators deploy mid-combat');
        // jar：战斗中部署到「倒地（尚未主动撤离）干员」占着的格子——DESIGN §作战阶段明文「倒地干员所在地块所有我方单位
        // 部署行为被阻止」。务必在动棋子之前先查战斗侧 downOn 拦截：否则棋子会落到该格、但战斗单位被 _deploy 的 downOn
        // 拒绝（deployFromInput 静默失败），造成「棋子在场却无战斗单位」的脱节——视觉上表现为把另一名干员拖到被击倒干员
        // 身上，结果那名干员没真正落场、被击倒干员的倒地身位仍占着格子（看似把人「变成了」被击倒的那名）。
        if (jarOn) {
          const f = liveField(m, this.playerId);
          // 联防战场只认它的 players（出战协防的队友）：漏怪方部署会成「棋子在场、战斗无单位」的幽灵，直接拦下。
          if (jarUnite && (!f || !Array.isArray(f.players) || !f.players.includes(this.playerId))) {
            return fail(ERR.BAD_TARGET, '联防阶段只有出战协防的队友能部署（你可在待部署区穿装 / 购买照常操作）');
          }
          if (f && f.battle && typeof f.battle.downOn === 'function') {
            const [dr, dc] = (typeof f.battle.mapTile === 'function' ? f.battle.mapTile(this, to.row, to.col) : [to.row, to.col]);
            if (f.battle.downOn(dr, dc)) return fail(ERR.BAD_TARGET, '倒地干员所在地块不可部署');
          }
          // 被主动撤离（benched）的击倒干员，再部署倒计时未结束前不能再部署（倒计时在待部署区里走）
          const u = f && f.battle && f.battle.allyUnits && f.battle.allyUnits.find((x) => x.uid === uid && x.ownerId === this.playerId && x.kind === 'op' && x.benched);
          if (u && u.benched && Number.isFinite(u.respawnAt) && f.battle.time < u.respawnAt) {
            return fail(ERR.BAD_TARGET, '再部署倒计时未结束');
          }
        }
        const res = this._moveChessToBoard(loc, to.row, to.col, dir ?? to.dir ?? undefined);
        if (res && res.ok) jarCombatDeploy(m, this, piece, to.row, to.col, dir ?? to.dir ?? null);
        return res;
      };
      // jar 模式资金不清零：核心规则是「休整期结束结余资金清零（仅结转编队豁免）」，而 jar 没有商店可花、
      // 600ms 的休整期也来不及点升级——不清零，结余留给「升级调度中心」（决定罐中干员阶数 / 道具池等级）。
      // endPrep 的其余逻辑（temp 结算 / shop 清理 / ready）照常，只把 funds=0 这一行绕开。
      const origEndPrep = ps.endPrep;
      ps.endPrep = function () {
        if (state(m).mode !== 'jar') return origEndPrep.call(this);
        const keep = this.funds;
        const r = origEndPrep.call(this);
        if (this.funds !== keep) { this.funds = keep; this.dirty(); }
        return r;
      };
      // jar 模式换地形：站在新地图非法格（含已不在场上的格子）的干员【强制消除】——
      // 销毁（pool 份数返还、装备随件消失），不撤回整备区（用户 2026-10-15：「不是那种撤离后回到待部署区」）。
      // 召唤物仍回主人的 stack（召唤物不是干员）。非法格 token 的处理与原版一致。
      const origEvict = ps._evictIllegal;
      if (origEvict) {
        ps._evictIllegal = function () {
          if (state(m).mode !== 'jar') return origEvict.call(this);
          this._legalityStale = false;
          const names = [];
          let gone = 0;
          for (const kind of ['chess', 'token']) {
            for (const [key, piece] of [...this.board]) {
              if (!piece || piece.kind !== kind) continue;
              const ci = key.indexOf(',');
              const r = Number(key.slice(0, ci)), c = Number(key.slice(ci + 1));
              if (this._legal(piece, r, c)) continue;
              this.board.delete(key);
              if (kind === 'chess') {
                this.removeTokensOf(piece.uid);
                // 棋子没了，战斗单位必须一并撤下（否则成幽灵：之后被击倒会进 snap.down，
                // 点选却找不到棋子 → 只弹详情窗 / 毫无反应）
                jarPurgeUnit(m, this, piece.uid);
                this.returnCopies(piece); // pool 份数返还（eliminate 同范式），装备随件消失
                const rec = this.gd.chess(piece.id);
                names.push(rec && rec.name ? rec.name : piece.id);
              } else if (!this._returnToken(piece)) {
                this.board.set(key, piece); // 无处可去：原地保留（与原版一致）
                continue;
              }
              gone++;
            }
          }
          if (names.length) this.m.toast(this, 'warn', msg('场地更换：{names}随旧战场一并消除', { names: names.join('、') }));
          return gone;
        };
      }
      // jar 战斗中的合成（三份合一）：核心 _mergeChess 只动棋子，战斗里的单位没人管 ——
      //   * 被吃掉的那个（场上 / 已撤离）棋子对应的战斗单位成了「幽灵」：之后它被击倒会出现在 snap.down，
      //     但 placeCtx 里已经没有这个棋子 → 点它只弹详情窗 / 毫无反应（用户 2026-10-16）；
      //   * 精英若落到被吃干员的格子上，战斗里根本没这个单位 → 干员「在棋盘上却不在战场上」。
      // 故合成后：被吃掉的 uid 一律撤出战斗，落到场上的精英即时注入战斗（与砸出干员部署同一条路）。
      const origMergeChess = typeof ps._mergeChess === 'function' ? ps._mergeChess : null;
      if (origMergeChess) {
        ps._mergeChess = function (baseId, incoming) {
          const jar = state(m).mode === 'jar' && m.phase === PHASE.COMBAT;
          const before = jar ? [...this.board].filter(([, p]) => p && p.kind === 'chess').map(([, p]) => p.uid) : null;
          const elite = origMergeChess.call(this, baseId, incoming);
          if (jar && elite) {
            for (const uid of before || []) {
              if (uid === elite.uid) continue;
              const still = this.find(uid);
              if (still && still.area === 'board') continue; // 没被这次合成吃掉
              jarPurgeUnit(m, this, uid);
            }
            const at = this.find(elite.uid);
            if (at && at.area === 'board' && typeof at.key === 'string') {
              const ci = at.key.indexOf(',');
              const r = Number(at.key.slice(0, ci)), c = Number(at.key.slice(ci + 1));
              if (Number.isInteger(r) && Number.isInteger(c)) jarCombatDeploy(m, this, elite, r, c, dirOf(elite));
            }
          }
          return elite;
        };
      }
      // jar 模式战斗中也能升级调度中心（无休整期，玩家整场战斗里才有时间点）——临时解除 PREP 门禁，
      // 与 jarEquip 的穿装同一套路；休整期 / 非 jar 模式原样走核心路径。
      const origLevelUp = typeof ps.levelUp === 'function' ? ps.levelUp : null;
      if (origLevelUp) {
        ps.levelUp = function (...args) {
          if (state(m).mode !== 'jar') return origLevelUp.apply(this, args);
          const gate = typeof this._gate === 'function' ? this._gate : null;
          if (!gate) return origLevelUp.apply(this, args);
          this._gate = () => null; // 临时解除 PREP 门禁（与 jarEquip 同一套路）
          try { return origLevelUp.apply(this, args); } finally { this._gate = gate; }
        };
      }
      // jar 模式战斗中也能销毁多余装备：原生 g.destroy 的 _gate 只放行休整期，而 jar 无休整期——玩家点击
      // 待部署区（hand/temp）道具，Underframe 出「销毁」按钮走原生 g.destroy。已装备的锁定校验在 items.js
      // destroy 里（gate 之后），旁路 gate 不会放过已装备件；非 jar 模式原样走核心路径。
      const origDestroy = typeof ps.destroy === 'function' ? ps.destroy : null;
      if (origDestroy) {
        ps.destroy = function (...args) {
          if (state(m).mode !== 'jar') return origDestroy.apply(this, args);
          const gate = typeof this._gate === 'function' ? this._gate : null;
          if (!gate) return origDestroy.apply(this, args);
          this._gate = () => null; // 临时解除 PREP 门禁（与 levelUp / jarEquip 同一套路）
          try { return origDestroy.apply(this, args); } finally { this._gate = gate; }
        };
      }
    }
  });

  // 每个 PREP 为存活玩家重新生成罐子（敌人取自本波 wave.spawns，故需 wave 已就绪 —— enterPrep 里 wave 已设好）。
  // 无休整期（jar 模式）：罐子生成后立即 endPrep() 开战——本波普通敌人已全部禁用（_normalOpts 包装置 Infinity），
  // 所有怪只能来自罐子（砸开后 JAR_LEAD_IN 秒走出），玩家全程战斗中砸罐 / 部署干员 / 穿装。
  // 短暂延迟走调度器，避免在 phase 切换事务内同步重入 endPrep。
  api.registerPhaseHook('prep', (m) => {
    if (state(m).mode !== 'jar') return;
    generateJars(m);
    if (typeof m.endPrep !== 'function') return;
    if (m.sched && typeof m.sched.setTimeout === 'function') {
      m.sched.setTimeout(() => { if (state(m).mode === 'jar' && m.phase === PHASE.PREP) m.endPrep(); }, 600);
    } else {
      m.endPrep();
    }
  });

  // jar 模式：私有视图追加罐子行。客户端只拿 id + smashed + 格子坐标（row/col 用 board 坐标，
  // 客户端用 view.tileScreen 投影到地图）。内容服务端权威，砸开前不下发（玩家无法偷看）。
  api.registerPrivateViewAugment((m, ps, view) => {
    const st = state(m);
    if (st.mode === 'jar' && st.jars && st.jars[ps.playerId]) {
      // 仅「已砸开」的罐子才随视图下发内容（kind/enemyKey/count）——未砸开的仍保持「内容不下发」（迷雾，防偷看）。
      // 已砸开的敌人罐需要 enemyKey/count，存档快照才能把放出的敌人随冻结关卡一起恢复（见 jarSnapshot）。
      view.jars = st.jars[ps.playerId].map((j) => {
        const o = { id: j.id, smashed: j.smashed, row: j.row, col: j.col };
        if (j.smashed) {
          o.kind = j.kind;
          if (j.kind === 'enemy') { o.enemyKey = j.enemyKey; o.count = j.count; }
        }
        return o;
      });
      // 存档专用：完整罐子布局（含未砸开内容），仅用于本地快照（单人模式，自己看自己存档无泄密问题）；
      // 显示层仍走上面的 view.jars（未砸开不下发，保持迷雾）。读档据此把地形 / 罐位 / 砸开状态原样还原。
      view.jarSaveJars = st.jars[ps.playerId].map((j) => ({
        id: j.id, kind: j.kind, smashed: !!j.smashed, row: j.row, col: j.col,
        opId: j.opId, enemyKey: j.enemyKey, count: j.count, itemId: j.itemId, buff: j.buff, amt: j.amt,
      }));
    }
    // jar 商店：价格 / 已购态服务端权威下发（客户端只读，购买走 g.jarShopBuy）
    if (st.mode === 'jar') {
      const rec = st.jarShop && st.jarShop[ps.playerId];
      view.jarShop = {
        slots: rec ? rec.slots : 0,
        life: rec ? rec.life : 0,
        revive: rec ? rec.revive : 0,
        obsBasic: rec ? rec.obsBasic : 0,
        obsAdvanced: rec ? rec.obsAdvanced : 0,
        obsBasicPlaced: jarObstacleCount(st, ps.playerId, 'basic'),
        obsAdvancedPlaced: jarObstacleCount(st, ps.playerId, 'advanced'),
        obstacles: (st.jarObstacles && Array.isArray(st.jarObstacles[ps.playerId])) ? st.jarObstacles[ps.playerId].map((o) => ({ tier: o.tier, row: o.row, col: o.col })) : [],
        reservedSlots: jarReservedSlots(m, ps),
        priceSlot: jarShopPrice(rec, 'slot'),
        priceLife: jarShopPrice(rec, 'life'),
        priceRevive: jarShopPrice(rec, 'revive'),
        priceObstacleBasic: jarShopPrice(rec, 'obstacleBasic'),
        priceObstacleAdvanced: jarShopPrice(rec, 'obstacleAdvanced'),
        lp: ps.lp,
        cap: ps.deployCap,
      };
    }
  });

  // 敌人罐走 ps.bounties 注入战斗，但不作为「悬赏」卡显示在效果栏。
  api.registerBountyFilter((m, ps, list) => list.filter((b) => !(b.card && b.card.jar)));

  // 敌人盲盒 / 迷雾：普通波休整期隐藏敌人情报，boss / 领袖波照常明示（让玩家能准备 boss 打法）。已侦察的波只回
  // 「空中 / 地面」两类数量（按 e.fly 切分，精英/领袖的飞行属性同样计入，不额外暴露强弱），未侦察回 redacted 占位
  //（客户端显示「？？？」与侦察按钮）。永不透露具体是谁、兵种、强弱与总数之外的任何信息。
  api.registerNextEnemiesAugment((m, ps, base) => {
    const st = state(m);
    if ((st.mode !== 'enemy' && st.mode !== 'all') || m.bossWaves) return null;
    const total = base.reduce((s, e) => s + (Number(e.count) || 1), 0);
    const rec = st.blindScout[ps.playerId] && st.blindScout[ps.playerId][m.round];
    if (rec && (rec.free || rec.paid > 0)) {
      let fly = 0, ground = 0;
      for (const e of base) {
        const c = Number(e.count) || 1;
        if (e.fly) fly += c; else ground += c;
      }
      return [{ partial: true, fly, ground }];
    }
    return [{ redacted: true, total }];
  });

  // shop / all 模式：每格一个盲盒，价格 = 盲盒底价 + (调度中心等级 - 1)：1 级 = BLIND_BOX_BASE 资金，每升一级 +1
  // （底价现为 2，即 1 级 2 资金、2 级 3 资金 …）。钩子价是最终价 —— 特质/羁绊折扣作用于真实卡价，
  // 不能泄漏盒内内容（至简的「购买价格为1」否则会把盒子钉在 1）。
  const BLIND_BOX_BASE = 2;
  api.registerPriceHook((m, ps) => {
    const st = state(m);
    if (st.mode !== 'shop' && st.mode !== 'all') return null;
    const lv = Math.trunc(Number(ps.shop && ps.shop.level));
    return Number.isFinite(lv) && lv > 0 ? BLIND_BOX_BASE + (lv - 1) : BLIND_BOX_BASE;
  });
}

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'blindbox';

/** 测试专用（test/match/blindbox-jarShop.test.js）：复活充能的授予 / 上下文表与钩子挂载。 */
export const __jarReviveTest = { grants: jarReviveGrants, ctx: jarReviveCtx, attach: jarAttachReviveHook };
/** 测试专用：障碍物手动部署（喂真实 Match/ps + 目标格，验证生成箱子 + 扣库存 + 上限）。 */
export const __jarObstacleTest = {
  crateKey: JAR_CRATE_KEY,
  deploy: (m, ps, item, row, col) => (__jarDeployDeviceFn ? __jarDeployDeviceFn(m, ps, item, row, col, false) : null),
  done: (m, ps, item) => (__jarDeployDeviceFn ? __jarDeployDeviceFn(m, ps, item, 0, 0, true) : null),
};
/** 测试专用：读档应用 / 暂存（喂真实 Match/ps + 快照，验证标量恢复 + 阵容重建 + 不变量）。 */
export const __jarSaveTest = {
  apply: (m, ps, d) => (__jarSaveTestFn ? __jarSaveTestFn.apply(m, ps, d) : null),
  load: (m, ps, req) => (__jarSaveTestFn ? __jarSaveTestFn.load(m, ps, req) : null),
};
/** 测试专用：敌人强度分 / 回合敌池 / Spine 素材过滤（验证 R1-2 仅杂兵、灵幛/奇美拉不到 R6 不进罐、BOSS 永不入池、种类丰富、无模型敌人不进罐）。 */
export const __jarEnemyTest = {
  tier: (m, key) => (__jarEnemyTestFn ? __jarEnemyTestFn.tier(m, key) : 3),
  pool: (m) => (__jarEnemyTestFn ? __jarEnemyTestFn.pool(m, () => 0.5) : []),
  hasSpine: (m, key) => (__jarEnemyTestFn ? __jarEnemyTestFn.hasSpine(m, key) : false),
};
/** 测试专用：障碍物在待部署区独占格清单（K=未部署数，取最左侧 K 槽）。 */
export const __jarReservedTest = {
  reservedSlots: (m, ps) => (__jarReservedTestFn ? __jarReservedTestFn.reservedSlots(m, ps) : []),
};
