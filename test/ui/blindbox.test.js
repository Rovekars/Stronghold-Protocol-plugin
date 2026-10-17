// 盲盒 MOD (public/mod/盲盒模式.js) 的契约测试：
//   * 默认关闭：放进 public/mod/ 就会被扫描加载，但开关默认 off —— 不开启就完全不改变游戏；
//   * 价格不在客户端算：只发 g.blindBoxSet / g.blindBoxGet，定价由服务端 economy.priceOf 决定；
//   * 让位：未开启 / 创造模式开启 / 折叠 / 奖励三选一时渲染 props.next（链上下一个渲染器），不抢创造模式；
//   * 卸下插件时把服务器开关一并关掉；
//   * 本体 ShopOverrideHost 改成了链式（next），旧的"第一个注册的覆盖独占"不再成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mod = new URL('../../public/mod/盲盒模式.js', import.meta.url);
const shopBar = new URL('../../public/js/ui/shopBar.js', import.meta.url);
const drawer = new URL('../../public/js/ui/enemyDrawer.js', import.meta.url);
const src = readFileSync(mod, 'utf8');
const barSrc = readFileSync(shopBar, 'utf8');
const drawerSrc = readFileSync(drawer, 'utf8');
const mainSrc = readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('盲盒：默认关闭（放进 MOD 目录也不改变游戏）', () => {
  // the local pref default: nothing is applied to the server until the player picks a non-off mode
  assert.match(src, /mode = v &&[\s\S]*\? v\.mode : 'off'/, 'the stored pref decides, and an empty store is off');
  assert.match(src, /catch\s*\{\s*return\s*\{\s*mode:\s*'off'\s*\}\s*;\s*\}/, 'a broken / empty pref falls back to off');
  assert.match(src, /if \(pref\.mode && pref\.mode !== 'off'\) net\.request\('g\.blindBoxSet'/, 'the switch is only pushed to the server when a real mode is picked');
});

test('盲盒：价格不在客户端算，只向服务端下发模式', () => {
  assert.match(src, /net\.request\('g\.blindBoxSet', \{\s*mode:/, 'g.blindBoxSet carries the mode');
  assert.match(src, /net\.request\('g\.blindBoxGet', \{\}/, 'g.blindBoxGet pulls the state on reload');
  // the card shows slot.price, which the server computed (player/views.js) — never a client-side formula
  assert.match(src, /const price = Number\(slot\?\.price\) \|\| 0/, 'the card renders the server-computed price');
  assert.doesNotMatch(src, /price\s*=\s*[^;]*shop\.level/, 'no client-side "price = level" formula');
});

test('盲盒：不接管时交给链上的下一个渲染器（与创造模式共存）', () => {
  assert.match(src, /if \(!shopOn\(st\.mode\) \|\| st\.creative \|\| props\.collapsed \|\| showReward\)/, 'the four cases that yield');
  assert.match(src, /props\.next \? html`<\$\{props\.next\} \.\.\.\$\{props\} \/>` : html`<\$\{ShopBar\} \.\.\.\$\{props\} \/>`/,
    'yields to props.next, falling back to the official bar when there is no next');
  // 创造模式开启 → 让位
  assert.match(src, /const onCreative = \(m\) => setState\(\{ creative: !!m\.on \}\)/, 'm.creativeState is watched');
  assert.match(src, /net\.on\('m\.creativeState', onCreative\)/, 'subscribed to the creative state');
  // 奖励三选一不被覆盖（范围只限休整期商店栏）
  assert.match(src, /const showReward = !!\(props\.reward && Array\.isArray\(props\.reward\.slots\)/, 'reward offers stay official');
});

test('盲盒：卸下插件时把服务器上的模式一并关掉', () => {
  assert.match(src, /MODS_EVENT/, 'listens for the MOD switch event');
  assert.match(src, /modsOffMap\(\)\['blindbox'\] && state\.mode !== 'off'/, 'only when this MOD is off and a box mode is active');
  assert.match(src, /net\.request\('g\.blindBoxSet', \{ mode: 'off' \}\)/, 'unloading turns the server mode off');
});

test('盲盒：注册点（商店覆盖 / 大厅模式选择 / 浮层）与音效接线', () => {
  assert.match(src, /registerShopOverride\(\{ id: 'blindbox-shop', Component: jarOverlaySafe\(BlindShop, 'BlindShop'\) \}\)/, 'the shop override (wrapped in the overlay error boundary)');
  assert.match(src, /registerLobbyEntry\(\{ id: 'blindbox-mode', Component: BlindBoxLobbyCard \}\)/, 'the lobby mode card');
  assert.match(src, /registerOverlay\(jarOverlaySafe\(BlindBoxBrain, 'BlindBoxBrain'\)\)/, 'the headless brain');
  assert.match(src, /registerOverlay\(jarOverlaySafe\(BlindScoutListener, 'BlindScoutListener'\)\)/, 'the scout event listener');
  assert.match(src, /registerOverlay\(jarOverlaySafe\(BlindRevealEnemy, 'BlindRevealEnemy'\)\)/, 'the enemy-reveal effect');
  assert.match(src, /window\.addEventListener\('sp:blind-scout', onScout\)/, 'the MOD listens for the drawer scout event');
  assert.match(drawerSrc, /window\.dispatchEvent\(new CustomEvent\('sp:blind-scout'\)\)/, 'the drawer scout button fires the scout event');
  assert.match(src, /audio\.sfx\('click', \{ volume: 0\.4 \}\)/, 'taps use the native click sfx');
  assert.match(src, /audio\.sfx\('levelup', \{ volume: 0\.5 \}\)/, 'the reveal uses the native levelup sfx');
  assert.match(src, /const BLIND_BOX_BASE = 2;/, 'the blind box has a base price of 2 (level 1 costs 2 资金)');
  assert.match(src, /return Number\.isFinite\(lv\) && lv > 0 \? BLIND_BOX_BASE \+ \(lv - 1\) : BLIND_BOX_BASE;/,
    'price = base + (level - 1): +1 资金 per level');
  assert.match(src, /version: '1\.4\.2'/, 'version');
  // 砸罐子（jar 模式）：大厅模式卡第 5 项、独立模式、不保留商店（JarBar 取代商店栏）
  assert.match(src, /\{ id: 'jar', label: '砸罐子'/, 'lobby card has the jar mode');
  assert.match(src, /const jarOn = \(mode\) => mode === 'jar'/, 'jarOn helper exists');
  assert.match(src, /if \(jarOn\(st\.mode\) && !st\.creative && !props\.collapsed && !showReward\)/, 'jar mode routes to JarBar (no shop kept)');
  assert.match(src, /function JarBar\(props\)/, 'the jar row component');
  assert.match(src, /net\.on\('m\.jarSmashed', onJar\)/, 'listens for the jar reveal');
});

test('砸罐子：商店栏只剩「升级 + 资金」，罐子投影到战场真实格子（每帧跟随活相机）', () => {
  // ① 商店去掉：JarBar 不再有 shopbar__cards / 冻结 / 刷新
  assert.doesNotMatch(src, /function JarBar[\s\S]*?shopbar__cards/, 'the jar bar keeps no shop cards');
  assert.doesNotMatch(src, /function JarBar[\s\S]*?onFreeze/, 'the jar bar has no freeze button');
  assert.doesNotMatch(src, /function JarBar[\s\S]*?onRefresh/, 'the jar bar has no refresh button');
  // 只剩升级（lvcard / LEVEL / upgradePrice）与资金（funds）
  assert.match(src, /function JarBar[\s\S]*?class=\$\{`lvcard\$\{max \? ' is-max' : ''\}`\}/, 'the level card stays');
  assert.match(src, /function JarBar[\s\S]*?class="funds"/, 'the funds block stays');
  assert.match(src, /function JarBar[\s\S]*?shop\.upgradePrice/, 'the upgrade price comes from the server-side shop state');
  // ② 地图罐子：portal 进游戏屏 .gm（z-index 2：战场之上、HUD 之下——花瓶不再盖住任何 UI），按 view.tileScreen(row,col) 投影
  assert.match(src, /registerOverlay\(jarOverlaySafe\(JarField, 'JarField'\)\)/, 'the jar field is a registered overlay');
  assert.match(src, /function JarField\(\)/, 'the jar field component');
  assert.match(src, /view\.tileScreen\(row, col\)/, 'jars are projected onto board tiles via view.tileScreen');
  assert.match(src, /class="jar-slot" data-row=/, 'each jar is an absolutely-positioned slot carrying its board row/col');
  assert.match(src, /document\.querySelector\('\.gm'\)/, 'the jar layer portals into the game screen (.gm)');
  assert.match(src, /position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 2, pointerEvents: 'none'/,
    'inside .gm the layer sits above the battlefield (z 0/1) and below the HUD (z 3)');
  assert.match(src, /position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 80, pointerEvents: 'none'/,
    'fallback: without .gm the layer renders at the root like before');
  // 罐子阵常驻：没有收起 / 展开按钮（jarField 状态已删）
  assert.doesNotMatch(src, /收起战场罐子|展开战场罐子/, 'no collapse / reopen toggle for the jar field');
  assert.doesNotMatch(src, /jarField/, 'no jarField ui state any more');
  // 罐子贴图来自 prts.wiki（彩瓷花瓶），符合萨尔贡陶土罐主题
  assert.match(src, /\/assets\/blindbox-jar\.png/, 'the jar uses the prts.wiki ceramic vase sprite');
  // 罐身上不再叠问号（问号 span 的专属颜色 rgba(255,240,210,.95) 不再出现）
  assert.doesNotMatch(src, /color: 'rgba\(255,240,210,\.95\)'/, 'no question-mark overlay on the jar sprite');
  // 砸罐音效：原生 Arknights 镜面受击声，点击即播
  assert.match(src, /const JAR_SFX_URL = '\/assets\/audio\/sfx\/enemy\/e_imp\/e_imp_mirror\.mp3'/, 'the jar smash sound is the native mirror/glass impact');
  assert.match(src, /audio\._play\(JAR_SFX_URL/, 'smashing a jar plays the glass-break SFX');
  // 已砸开的罐子彻底消失：Jar 返回 null、槽位一并过滤——地上无残骸标识，格子让给部署
  assert.doesNotMatch(src, /is-smashed/, 'no smashed-jar residue marker on the ground');
  assert.match(src, /if \(jar\.smashed\) \{\s*\n\s*\/\/ 已砸开[\s\S]{0,220}return null;/, 'a smashed jar renders nothing');
  assert.match(src, /jars\.filter\(\(j\) => !j\.smashed\)\.map/, 'smashed jars lose their slot too (tile fully clickable)');
  // 敌人罐揭示浮层快速自撤（开战在即，不挡战斗）；点击随时可关
  assert.match(src, /rev\.kind === 'jar' && rev\.jar && rev\.jar\.kind === 'enemy' \? 1600 : 2600/, 'the enemy reveal clears fast (1.6s), others 2.6s');
  // 合并精锐的「晋升奖励」三选一（用户要求保留）：呈现与原生一致——jar 底栏直接复用原生
  // RewardCards（rwtag 头 + 标准干员大卡 + 两段点击 + 「稍后」pill），不再自绘（用户 2026-10-16）
  assert.match(src, /priv\?\.shop\?\.rewardOffer/, 'the jar bar reads the merge reward offer');
  assert.match(src, /pickReward = \(i\) =>[^\n]*g\.reward/, 'picking a reward sends g.reward');
  assert.match(src, /\$\{showReward && !rwMin \? html`<\$\{RewardCards\}/, 'the jar bar reuses the native RewardCards');
  assert.match(src, /\$\{RewardOverlay\} priv=\$\{priv\} minimized/, 'the native reward pill (稍后选择) is mounted too');
  assert.match(src, /const \[armed, setArmed\] = useTwoTap/, 'two-tap confirm like the native shop');
  assert.match(src, /armKey\('r', idx, slot\)/, 'reward slots use the native arm keys');
  assert.match(src, /\$\{js && !showReward \? html`/, 'jar shop cards step aside while a reward offer is up');
  assert.doesNotMatch(src, /jar-reward__card/, 'no self-drawn reward cards any more (native presentation)');
  assert.doesNotMatch(src, /JAR_REWARD_CSS/, 'no self-drawn reward CSS any more');
  // chessPortraitUrl 要吃 rec 对象（读 charId / assets.portrait）——传 id 字符串会静默返回 null，立绘变问号
  assert.match(src, /src = chessPortraitUrl\(assets, rec\); \/\/ 传 rec 对象/, 'the jar reveal overlay passes the record too');
  // 不再有全屏网格常量 / jarGrid
  assert.doesNotMatch(src, /const JAR_ROWS =/, 'no fullscreen-grid rows constant');
  assert.doesNotMatch(src, /st\.jarGrid/, 'no server-side jarGrid any more');
});

test('砸罐子：敌人池铺满stage + 轮流分配 + 本波敌人全禁用（所有怪只能来自罐子）', () => {
  // 敌人池（用户 2026-10-15 强度重做）：全敌人库按回合强度上限过滤（R1-2 仅杂兵 / R3-5 老练 / R6+ 精英），
  // 排除 mode.inactiveEnemyKeys，Fisher–Yates 打乱——前期不出「灵幛」/ 奇美拉这类打不过的精英，种类远超模式模板
  assert.match(src, /function enemyPool\(m, rj\)/, 'the enemy pool builder exists');
  assert.match(src, /function jarEnemyTier\(m, key\)/, 'the strength tier function exists');
  assert.match(src, /const maxTier = cur <= 2 \? 0 : cur <= \(coop \? 3 : 4\) \? 1 : cur <= 9 \? 2 : 3;/, 'the pool unlocks by round (grunts R1 / veterans R3 / elites R5 solo · R4 coop / big bosses R10)');
  assert.match(src, /if \(Number\(e\.stats\.moveSpeed\) === 0\) return 4;/, 'stationary enemies (moveSpeed 0: statues / hovering turrets) never enter jars — they never reach the goal');
  assert.match(src, /if \(s >= 90\) return 3;/, 'walking mega-titans (250 万血) fold into the big-boss tier: R10+, one at a time (2026-10-16 全量口径)');
  assert.match(src, /const wOp = coop \? \(r0 >= 11 \? 0\.12 : r0 >= 6 \? 0\.20 : 0\.28\)\s*\n\s*: \(r0 >= 11 \? 0\.18 : r0 >= 6 \? 0\.30 : 0\.40\);/, 'operator jars thin out in later rounds (solo 40% → 30% → 18%; coop 28% → 20% → 12%)');
  assert.match(src, /const wEn = coop \? \(r0 >= 11 \? 0\.63 : r0 >= 6 \? 0\.55 : 0\.52\)\s*\n\s*: \(r0 >= 11 \? 0\.57 : r0 >= 6 \? 0\.45 : 0\.40\);/, 'enemy jars ramp up in later rounds (solo 40% → 45% → 57%; coop 52% → 55% → 63%)');
  assert.match(src, /m\.gd\.raw && m\.gd\.raw\.enemies/, 'the pool draws from the whole enemy library (variety)');
  assert.match(src, /m\.gd\.inactiveEnemies/, 'inactive enemies are excluded from the pool');
  assert.match(src, /pool\[seq % pool\.length\]/, 'enemy jars take the pool round-robin (variety, no repeats in a row)');
  // 无休整期：罐子生成后 600ms 自动 endPrep 开战——玩家全程在战斗中砸罐 / 部署 / 穿装
  assert.match(src, /m\.sched\.setTimeout\(\(\) => \{ if \(state\(m\)\.mode === 'jar' && m\.phase === PHASE\.PREP\) m\.endPrep\(\); \}, 600\)/,
    'prep auto-ends 600ms after the jars spawn (no prep phase in jar mode)');
  // 本波普通敌人全部禁用：_normalOpts 包装把每个波次 spawn 置 time: Infinity（永不派出、不计 total）
  assert.match(src, /m\._normalOpts = function \(ps\) \{/, 'the MOD wraps the battle options builder');
  assert.match(src, /opts\.spawns = wave\.map\(\(s\) => \(\{ \.\.\.s, time: Infinity \}\)\)/, 'every wave spawn is disabled (time: Infinity)');
  // 锚点 spawn 挂住战斗：没有它 _pending 为空，autoFinish 会在第一拍就宣布 cleared，玩家一局都砸不到。
  // 时限抬到 JAR_BATTLE_LIMIT（引擎硬顶）：本波倒计时的运行逻辑在 jar 不生效（用户要求），回合改由
  // 「最后一罐砸开（撤锚点）+ 敌人清完」自然收尾。
  assert.match(src, /const JAR_BATTLE_LIMIT = 3600;/, 'the jar battle limit sits at the engine hard cap (no wave countdown)');
  assert.match(src, /opts\.timeLimit = JAR_BATTLE_LIMIT;/, 'the jar battle spec overrides the wave timeLimit (countdown logic off)');
  assert.match(src, /countInTotal: false, routeIndex: wave\[0\]/, 'the anchor spawn is not counted in the total');
  assert.match(src, /tag: 'jar-anchor', ownerPlayerId: ps\.playerId,/, 'the anchor is tagged so it can never leak');
  assert.match(src, /time: JAR_BATTLE_LIMIT \+ 600,/, 'the anchor sits far beyond any realistic battle time');
  // 锚点只在还有未砸的罐时才挂（战斗建立前已砸完就无人撤它，战斗自然收尾）
  assert.match(src, /anchorKey && jars\.some\(\(j\) => j && !j\.smashed\)/, 'the anchor is only armed while unsmashed jars remain');
  // 最后一罐砸开 → 延迟撤锚点（b.jarClear 下发 / 服务端 removeSpawnsByTag），战斗恢复自然结束
  assert.match(src, /function clearJarAnchor\(m, ps\) \{/, 'the anchor-clear routine exists');
  assert.match(src, /if \(!list\.some\(\(j\) => j && !j\.smashed\)\) clearJarAnchor\(m, ps\);/, 'smashing the LAST jar schedules the anchor removal');
  assert.match(src, /t: 'b\.jarClear', battleId: f\.battleId/, 'client-run battles get b.jarClear');
  assert.match(src, /f\.battle\.removeSpawnsByTag\('jar-anchor'\)/, 'server-run battles drop the anchor directly');
  // 引擎：buildBattleSpec 直接滤除 time: Infinity 的 spawn（客户端与服务端同一规则，双端都不派不出）
  const spec = read('server/sim/spec.js');
  assert.match(spec, /spawns: \(Array\.isArray\(o\.spawns\) \? o\.spawns : \[\]\)\.filter\(\(x\) => !\(x && Number\(x\.time\) === Infinity\)\)/,
    'buildBattleSpec drops Infinity-time spawns (never dispatched, never counted)');
  // 引擎：锚点超时后按「未生成」丢弃、不计泄漏（DESIGN §5.5）
  const lifecycle = read('server/sim/battle/lifecycle.js');
  assert.match(lifecycle, /this\.unspawned\.push\(\{ enemyKey: p\.enemyKey, time: p\.time, tag: p\.tag \?\? null/,
    'a spawn that never happened is reported unspawned (not a leak)');
  // 干员罐不动阶段（拿到即可部署）
  assert.match(src, /const piece = ps\.acquireChess\(jar\.opId, \{ source: 'jar' \}\)/, 'an operator jar grants the operator into the bench');
  // 引擎：startCombat 原场复用（带 jarSkirmish 标记的场不重建，整波敌人注入同一场战斗，连续作战）
  const combat = read('server/match/match/combat.js');
  assert.match(combat, /f\.jarSkirmish && !f\.done && Array\.isArray\(f\.players\) && f\.players\.includes\(ps\.playerId\)/,
    'startCombat reuses the live field instead of building a new one');
  assert.match(combat, /_jarWaveInject\(f, pid\)/, 'the wave spawns are injected into the reused battle');
  assert.match(combat, /f\.jarSkirmish && Number\.isFinite\(f\.startAt\)\) continue/, 'the reused field keeps its clock (started at the smash)');
  // runner：fieldUnits 供 MOD 把战斗内敌人投影成棋盘标记
  const runner = read('public/js/battle/runner.js');
  assert.match(runner, /fieldUnits\(fieldId\)/, 'the runner exposes the live battle units');
  assert.match(runner, /net\.on\('b\.jarClear', onJarClear\)/, 'the runner applies the anchor removal to its battle');
  // sim：removeSpawnsByTag（锚点撤除的原语）
  const spawnsSrc = read('server/sim/battle/spawns.js');
  assert.match(spawnsSrc, /removeSpawnsByTag\(tag\) \{/, 'the sim can drop pending spawns by tag');
  // 引擎视图：整备区拖拽在战斗中放行——pointerdown 先试拖拽、pointermove 在 pressed 态就转发
  // （只转发 dragging 会死锁：pressed→dragging 的阈值判定就在 pointerMove 里，用户实测「拖不到场上」）
  const appSrc = read('public/js/render/app.js');
  assert.match(appSrc, /if \(jarMode && drag\.pointerDown\(ev\)\) \{/, 'a press on a bench piece starts the native drag in jar combat');
  assert.match(appSrc, /if \(jarMode && drag\.active\) \{ drag\.pointerMove\(ev\); return; \}/,
    'battle-mode pointer moves are forwarded while the piece is merely pressed (the threshold transition lives inside pointerMove)');
  // jar 战斗里拖拽落点等待的超时归位与休整期同一套（被拒 / 替换对话框取消：无 intent、priv 不变）——
  // 不跑超时清理，乐观落在目标格的装备视图永远停在战场（用户 2026-10-16 报告）
  assert.match(appSrc, /if \(jarMode\) expireDropPending\(now\);/, 'jar combat expires the drop-pending map too (a refused drop / cancelled dialog returns the piece to the bench)');
  const dragSrc = read('public/js/render/drag.js');
  assert.match(dragSrc, /get active\(\) \{ return !!st; \}/, 'the drag controller exposes the pressed state as `active`');
  // 资金不清零 + 战斗中可升级：核心规则「休整期结束结余清零（仅结转编队）」对 jar 不适用——
  // 没有商店可花、600ms 休整期来不及点升级，结余留给升级调度中心（决定罐中干员阶数/道具池）。
  assert.match(src, /ps\.endPrep = function \(\) \{/, 'the MOD wraps ps.endPrep');
  assert.match(src, /if \(this\.funds !== keep\) \{ this\.funds = keep; this\.dirty\(\); \}/, 'jar mode keeps the leftover funds at the prep end (no wipe)');
  assert.match(src, /ps\.levelUp = function \(\.\.\.args\)/, 'the MOD wraps ps.levelUp');
  assert.match(src, /this\._gate = \(\) => null;/, 'combat-time level-up bypasses the PREP gate (same trick as jarEquip)');
  // 多余装备的销毁走原生链路：点击待部署区道具出 Underframe 销毁按钮（game.js 放行 hand/temp item 选中），
  // MOD 旁路 g.destroy 的 PREP 门禁——独立道具架（JarItemShelf / g.jarDestroyItem）已按用户要求删除
  assert.doesNotMatch(src, /JarItemShelf/, 'no separate destroy shelf (destroy lives on the item click underframe)');
  assert.doesNotMatch(src, /g\.jarDestroyItem/, 'no dedicated destroy intent (native g.destroy covers it)');
  assert.match(src, /ps\.destroy = function \(\.\.\.args\)/, 'the MOD wraps ps.destroy too');
  const gameSrc = read('public/js/screens/game.js');
  assert.match(gameSrc, /selEntry\.piece\.kind !== 'item' \|\| selEntry\.area === 'hand' \|\| selEntry\.area === 'temp'/,
    'jar combat lets a bench item be selected so its underframe offers 销毁');
});

test('砸罐子：战斗中继续玩——砸罐接进运行中的战斗 + 干员即时部署参战', () => {
  // 服务端：战斗中砸罐合法（COMBAT / UNITE + jar 模式——联防阶段照常操作，用户 2026-10-17）
  assert.match(src, /function jarPhaseOn\(m\) \{\s*const st = state\(m\);\s*return st\.mode === 'jar' && \(m\.phase === PHASE\.COMBAT \|\| m\.phase === PHASE\.UNITE\);/,
    'jarPhaseOn: COMBAT + UNITE are the jar mid-battle phases');
  assert.match(src, /const inCombat = jarPhaseOn\(m\);/, 'smashing jars during COMBAT / UNITE is allowed in jar mode');
  assert.match(src, /if \(m\.phase !== PHASE\.PREP && !inCombat\) return fail\(ERR\.WRONG_PHASE\);/, 'the smash gate accepts PREP and mid-combat');
  // 服务端：战斗已在跑（本波战斗）→ 敌人延后 JAR_LEAD_IN 秒注入正在运行的战斗（不走 bounty，避免下一波重复出现）
  assert.match(src, /function injectJarEnemies\(m, ps, jar\)/, 'mid-combat enemy jars inject into the running battle');
  assert.match(src, /if \(inCombat \|\| liveField\(m, ps\.playerId\)\) \{\s*\n\s*\/\/[^\n]*\n\s*injectJarEnemies\(m, ps, jar\);/,
    'enemy jars inject into any running battle');
  // 延后 5 真实秒：JAR_LEAD_IN = 10 战斗秒（战斗恒 2 倍速）；injectSpawns 的 time 是相对秒数（this.time + time）
  assert.match(src, /const JAR_LEAD_IN = 10;/, 'the lead-in is 10 battle seconds = 5 real seconds at 2x speed');
  assert.match(src, /return \[\{ enemyKey: jar\.enemyKey, count, time: JAR_LEAD_IN, routeIndex, tag: 'bounty', ownerPlayerId: ps\.playerId \}\];/,
    'injected enemies walk out JAR_LEAD_IN seconds after the smash (relative time)');
  assert.match(src, /f\.spec\.spawns\.push\(\{ \.\.\.s, time: gt \+ JAR_LEAD_IN \}\)/, 'the spec copy records the absolute battle time (server rebuild keeps the enemy)');
  assert.match(src, /f\.battle\.injectSpawns\(specs\.map\(\(s\) => \(\{ \.\.\.s, time: JAR_LEAD_IN \}\)\)\)/, 'the direct server call passes the same relative lead-in');
  // 服务端：g.move 旁路（jar 模式）——落格成功即注入；PREP 遭遇战走原生 move 全量校验，COMBAT 走 _moveChessToBoard
  assert.match(src, /ps\.move = function \(uid, to, dir\) \{/, 'the match wraps ps.move');
  assert.match(src, /const live = jarOn && to && to\.area === 'board' \? liveField\(m, this\.playerId\) : null;/,
    'the wrap fires for board placement in jar mode with a running battle');
  // 战斗中主动撤离：to.area === 'hand' 且 COMBAT → 战斗侧移除（retreatToBench）+ 棋子回整备区（绕门禁）
  assert.match(src, /const liveHand = jarOn && to && \(to\.area === 'hand' \|\| to\.area === 'temp'\) && m\.phase === PHASE\.COMBAT \? liveField\(m, this\.playerId\) : null;/,
    'the wrap also handles mid-combat retreats (to the bench, or overflowed to the temp row)');
  assert.match(src, /t: 'b\.jarRetreat', battleId: liveHand\.battleId, playerId: this\.playerId, uid/,
    'client-run battles get b.jarRetreat');
  assert.match(src, /liveHand\.battle\.retreatToBench\(this\.playerId, uid\)/, 'server-run battles retreat the unit directly');
  assert.match(src, /this\._moveChessToBoard\(loc, to\.row, to\.col, dir \?\? to\.dir \?\? undefined\)/, 'the wrap reuses the core placement path');
  assert.match(src, /jarCombatDeploy\(m, this, piece, to\.row, to\.col, dir \?\? to\.dir \?\? null\)/, 'a successful mid-combat placement injects into the running battle');
  // 引擎：Battle.deployFromInput / Battle.injectSpawns（runner 与服务端模拟共用）
  const engine = read('server/sim/battle/players.js') + read('server/sim/battle/spawns.js');
  assert.match(engine, /deployFromInput\(ownerId, inp\)/, 'the Battle can deploy a new operator mid-battle');
  assert.match(engine, /injectSpawns\(list\)/, 'the Battle can inject enemies mid-battle (they walk out of the spawn point)');
  // runner：b.jarSpawn / b.jarDeploy 应用到本地战斗（含 Battle 未建好时的暂存补放）
  const runner = read('public/js/battle/runner.js');
  assert.match(runner, /net\.on\('b\.jarSpawn', onJarSpawn\)/, 'the runner applies mid-combat enemy injections');
  assert.match(runner, /net\.on\('b\.jarDeploy', onJarDeploy\)/, 'the runner applies mid-combat operator deploys');
  assert.match(runner, /net\.on\('b\.jarClear', onJarClear\)/, 'the runner applies the anchor removal');
  assert.match(runner, /net\.on\('b\.jarRetreat', onJarRetreat\)/, 'the runner applies mid-combat retreats to the bench');
  assert.match(runner, /e\.battle\.injectSpawns\(msg\.spawns\)/, 'the injection reaches the local battle');
  assert.match(runner, /e\.battle\.deployFromInput\(dep\.playerId, dep\.unit\)/, 'the deploy reaches the local battle');
  assert.match(runner, /e\.battle\.retreatToBench\(q\.playerId, q\.uid\)/, 'the retreat reaches the local battle');
  // sim：retreatToBench（活的直接移除；被击倒的不再自动上场、倒地占格释放）
  const deploySrc = read('server/sim/battle/deploy.js');
  assert.match(deploySrc, /retreatDown\(unit\) \{/, 'the sim can withdraw a knocked-down operator for good');
  assert.match(deploySrc, /retreatToBench\(ownerId, uid\) \{/, 'the sim retreats an operator to the bench by piece uid');
  // 客户端：罐子阵战斗中仍显示 + 原生待部署区（用户定稿：砸出的干员/道具进项目原生整备区，
  // 不再自建「快速部署」条；商店栏位置也不因开战而变——见 game.js 的 jarCombat/showShop）。
  assert.match(src, /\(phase === 'PREP' \|\| phase === 'COMBAT'\) && jars\.length > 0/, 'the jar field stays up during combat too');
  // jar 战斗：MOD 通知 field view 保持 prep 布局（引擎 / 降级都认 setJarMode），并用 rAF 轮询把砸出的
  // 干员/道具实时灌进原生整备区。board 剥掉——已部署干员由战斗快照渲染，prep 再画会同格重叠。
  assert.match(src, /view\.setJarMode\(on\);/, 'the MOD toggles the field view\'s jar mode (prep bench kept during combat)');
  assert.match(src, /view\.setPrep\(\{ \.\.\.priv, board: \[\] \}, \{ editable: true, canPlace \}\)/,
    'smashed operators/items are pushed into the NATIVE 整备区 (hand/temp only; board stripped); canPlace gates benched redeploy countdown');
  assert.match(src, /requestAnimationFrame\(tick\)/, 'the push is a per-frame poll (game.js stops calling setPrep after the no-prep opening)');
  // 不再自建部署条 / 信息条：两条自定义 UI 都已删除，部署与穿装走原生拖拽链路
  assert.doesNotMatch(src, /class="jar-deploy"/, 'the custom quick-deploy bar is gone (native bench replaces it)');
  assert.doesNotMatch(src, /function CombatDeploy\(/, 'the CombatDeploy component is removed with it');
  assert.doesNotMatch(src, /function JarCombatInfo\(/, 'the bottom-left info chip is gone (the shop bar keeps its native place instead)');
  // 原生拖拽的道具穿装：核心 g.equip 被服务端 _gate() 限休整期，jar 战斗中在 net 层改写成 g.jarEquip
  assert.match(src, /net\.request = \(type, payload\) => \{/, 'the MOD wraps net.request for the jar equip rewrite');
  assert.match(src, /if \(type === 'g\.equip'\) \{/, 'only the equip message is rewritten');
  assert.match(src, /return orig\('g\.jarEquip', \{ itemUid: payload && payload\.itemUid, targetUid: payload && payload\.targetUid, replaceUid: ru \}\)/,
    'mid-combat equips go through the plugin\'s g.jarEquip (ps.equip + battle.equipItem); replaceUid is forwarded for in-combat replacement');
  // consume_on_equip（盟约之币类：装备即销毁生效、不占槽）战斗中放行——效果服务端结算，不挂战斗图标
  assert.match(src, /const consume = typeof rec\.kind === 'string' && rec\.kind\.startsWith\('consume_on_equip'\);/,
    'the MOD recognises consume-on-equip items');
  assert.match(src, /if \(deployed && !consume\) \{/, 'consume items may be equipped onto deployed operators in combat');
  assert.match(src, /if \(deployed && !consume\) \{[\s\S]*?const f = liveField\(m, ps\.playerId\);/, 'a consumed item is not pushed onto the battle unit (no icon, no slot)');
  // 层级：顶部罐子计数 chip 仍要显式 z 60——插件 overlay 是 .app-root 子元素，z-index:auto 会被
  // 游戏屏（.gm z1）连同 WebGL canvas 一起压住。
  const zHits = src.match(/zIndex: 60,/g) || [];
  assert.ok(zHits.length >= 1, `the jar counter chip sits above the game screen (z 60), found ${zHits.length}`);
  // 隐藏战斗倒计时：只限 jar 战斗（.countdown 的样式注入）
  assert.match(src, /hideTimer \? html`<style>\.countdown \{ display: none !important; \}<\/style>` : null/,
    'the battle countdown is hidden in jar combat only');
});

test('砸罐子：罐子里只有「干员 / 敌人 / 道具」三类，内容服务端权威', () => {
  // 三类权重按回合调（用户 2026-10-15：后期减少干员罐；2026-10-16：同盟更容易出怪）
  // 单机：R1-5 40/40/20 → R6-10 30/45/25 → R11+ 18/57/25；同盟：28/52/20 → 20/55/25 → 12/63/25
  assert.match(src, /const wOp = coop \? \(r0 >= 11 \? 0\.12 : r0 >= 6 \? 0\.20 : 0\.28\)\s*\n\s*: \(r0 >= 11 \? 0\.18 : r0 >= 6 \? 0\.30 : 0\.40\);/, 'operator weight tapers by round (coop thins more)');
  assert.match(src, /const wEn = coop \? \(r0 >= 11 \? 0\.63 : r0 >= 6 \? 0\.55 : 0\.52\)\s*\n\s*: \(r0 >= 11 \? 0\.57 : r0 >= 6 \? 0\.45 : 0\.40\);/, 'enemy weight rises by round (coop higher)');
  assert.match(src, /if \(r < wOp\) return 'operator';/, 'operator jars');
  assert.match(src, /if \(r < wOp \+ wEn\) return 'enemy';/, 'enemy jars');
  assert.match(src, /return 'item';/, 'item jars (the remainder)');
  assert.doesNotMatch(src, /\{ kind: 'empty', w:/, 'there is no empty jar any more');
  assert.match(src, /const itemId = m\.pool\.rollItem\(rj, ps\.shop\.level\);/, 'items come from the shop item pool');
  assert.match(src, /ps\.acquireItem\(jar\.itemId, \{ source: 'jar' \}\)/, 'an item jar grants the item');
  // 揭示浮层要认得道具
  assert.match(src, /c\.kind === 'item' && c\.itemId/, 'the reveal overlay names the item');
  assert.match(src, /src = itemIconUrl\(assets, rec\)/, 'the reveal shows the item icon (rec, not the raw itemId key)');
  // 内容仍不下发，但下发格子坐标（客户端用它投影到地图）；仅「已砸开」的罐子才附带 kind/enemyKey/count
  // （用于存档快照恢复放出的敌人），未砸开的罐子视图仍只含 id/smashed/row/col（不泄露敌人种类，保持迷雾）
  assert.match(src, /if \(j\.smashed\) \{\s*o\.kind = j\.kind;/, 'only smashed jars ship their content kind');
  assert.match(src, /o\.enemyKey = j\.enemyKey; o\.count = j\.count;/, 'smashed enemy jars ship enemyKey/count for save-snapshot restore');
  assert.doesNotMatch(src, /view\.jars = st\.jars\[ps\.playerId\]\.map\(\(j\) => \(\{ id: j\.id, smashed: j\.smashed, row: j\.row, col: j\.col, kind: j\.kind \}\)/,
    'un-smashed jars do NOT leak content (fog of war preserved)');
});

test('盲盒：MOD 自有 C2S 两端都注册（浏览器 net.request 会先本地校验）', () => {
  // 服务端 registerMessage 只注入 Node 进程的 C2S；浏览器那份 protocol.js 是另一个实例，
  // 客户端不注册的话 g.blindBoxSet 会在出门前被 validateC2S 拒掉（本地「无效的请求」）→ 盲盒永远不生效。
  assert.match(src, /const C2S_MSGS = \{/, 'the MOD owns one schema table');
  assert.match(src, /'g\.blindBoxSet': \{ mode:/, 'g.blindBoxSet schema');
  assert.match(src, /'g\.blindBoxGet': \{\}/, 'g.blindBoxGet schema');
  assert.match(src, /'g\.scoutWave':/, 'g.scoutWave schema');
  assert.match(src, /'g\.smashJar':/, 'g.smashJar schema');
  const hits = src.match(/api\.registerMessage\(name, schema\)/g) || [];
  assert.equal(hits.length, 2, `registered on both halves (client setup + server(api)), found ${hits.length}`);
});

test('本体：PLUGIN_API 提供 registerMessage（MOD 可往浏览器那份 C2S 注入）', () => {
  assert.match(mainSrc, /import \{ C2S \} from '\.\.\/\.\.\/shared\/protocol\.js';/, 'the client imports the live C2S catalogue');
  assert.match(mainSrc, /registerMessage\(name, schema\) \{/, 'registerMessage is part of the plugin API');
  assert.match(mainSrc, /if \(typeof name === 'string' && name && schema && typeof schema === 'object'\) C2S\[name\] = schema;/,
    'it writes straight into the shared catalogue net.request validates against');
});

test('本体：ShopOverrideHost 改成链式（每个覆盖可让位给 next）', () => {
  assert.match(barSrc, /const chain = \(i\) =>/, 'the overrides form a chain');
  assert.match(barSrc, /\.\.\.\$\{p\} next=\$\{chain\(i \+ 1\)\}/, 'each override receives the next renderer');
  assert.match(barSrc, /cache\[i\] = \(p\) => html`<\$\{ShopBar\} \.\.\.\$\{p\} \/>`/, 'the official bar closes the chain');
});

test('本体：链上的渲染器必须是稳定的组件引用（否则商店买不了东西）', () => {
  // 每次渲染新建匿名函数 → preact 认为组件类型变了 → 卸载重建整条链 → <ShopBar> 的两段确认（useTwoTap armed）
  // 在第一次点击后立刻被重置，第二次点击又变成「第一次」→ 装了任何商店覆盖 MOD 时商店永远无法购买。
  assert.match(barSrc, /const Chain = useMemo\(\(\) => \{/, 'the chain is memoized, not rebuilt per render');
  assert.match(barSrc, /if \(cache\[i\]\) return cache\[i\];/, 'each link of the chain is cached (stable identity)');
  assert.match(barSrc, /\}, \[list\]\);/, 'the chain is rebuilt only when the override list itself changes');
  assert.match(barSrc, /return Chain\(props\);/, 'the host renders the memoized head of the chain');
});

test('创造模式：不接管时也交给 next（两种注册顺序都能共存）', () => {
  const creative = readFileSync(new URL('../../public/mod/创造模式.js', import.meta.url), 'utf8');
  assert.match(creative, /return props\.next \? html`<\$\{props\.next\} \.\.\.\$\{props\} \/>` : html`<\$\{ShopBar\} \.\.\.\$\{props\} \/>`/,
    'the creative shop yields to the next renderer when its own switch is off');
});

test('砸罐子：结算页换 jar 语义（无尽模式无关底/无回合上限，不显示领袖奖牌与领袖伤害）', () => {
  const resultSrc = read('public/js/screens/result.js');
  assert.match(resultSrc, /const isJar = !!useStore\(\(s\) => s\.match\.private\?\.jarShop\);/, 'the result screen detects jar mode');
  assert.match(resultSrc, /isJar \? t\('已被淘汰'\) : t\('模拟失败'\)/, 'defeat reads 已被淘汰 in jar (no final assault)');
  assert.match(resultSrc, /isJar \? t\('生命值耗尽 · 无尽模拟中止'\)/, 'the defeat sub explains the endless run ended');
  assert.match(resultSrc, /isJar \? t\('坚守回合'\) : t\('通过回合'\)/, 'rounds read 坚守回合 in jar');
  assert.match(resultSrc, /\$\{!isJar && r\.roundsPassed <= r\.lastRound/, 'no /lastRound suffix in jar (endless: no round cap)');
  assert.match(resultSrc, /\$\{!isJar && \(boss \|\| hidden\)/, 'boss / hidden-core medals are hidden in jar');
  assert.match(resultSrc, /isJar \? t\('本局报告'\) : t\('同盟成员'\)/, 'the report header reads 本局报告 in jar');
  assert.match(resultSrc, /isJar \? 'BATTLE REPORT' : 'ALLIANCE REPORT'/, 'the report micro label follows');
  assert.match(resultSrc, /\(!jar \|\| k !== 'bossDamage'\)/, 'the 领袖伤害 stat is filtered out in jar');
});

test('砸罐子：高级障碍物与初级共用同一张灰色路障立绘（档位靠等级徽标/金边区分）', () => {
  // 用户 2026-10-17：展示框里高级障碍物不要用地雷样式（jar-shop-obstacleAdvanced.png），要初级的灰色样子。
  assert.match(src, /const src = kind === 'obstacleAdvanced' \? '\/assets\/jar-shop-obstacleBasic\.png' : `\/assets\/jar-shop-\$\{kind\}\.png`;/,
    'the shop card icon for the advanced obstacle reuses the basic grey crate art');
  assert.doesNotMatch(src, /JarShopIcon[\s\S]*?\/assets\/jar-shop-obstacleAdvanced\.png/,
    'the shop card no longer loads the advanced mine art');
  // 整备区部署 chip 与战场贴皮也一并用初级立绘（高级仅多金边/灰度）
  assert.match(src, /tier: 'obstacleAdvanced', icon: '\/assets\/jar-shop-obstacleBasic\.png', adv: true/,
    'the bench deploy chip for the advanced obstacle reuses the basic art');
  assert.doesNotMatch(src, /data-hskin[\s\S]{0,200}src="\/assets\/jar-shop-obstacleAdvanced\.png"/,
    'the battlefield advanced skin no longer uses the mine art');
});

test('砸罐子：同盟模式——随时查看队友（jar 放行 _watchClient）+ AI 队友真正下场', () => {
  // 客户端：observeTarget 的 jar 放行 + game.js 传入 priv.jarShop
  const observe = readFileSync(new URL('../../public/js/battle/observe.js', import.meta.url), 'utf8');
  assert.match(observe, /if \(own\.kind === 'normal' && own\.live !== false && !ownDone && !jar\) return \{ reason: t\('作战中无法查看队友，作战结束后可前往查看'\) \};/,
    'observeTarget blocks mid-combat watching unless jar (砸罐子) mode');
  assert.match(observe, /jar = false \} = \{\}/, 'observeTarget takes the jar flag');
  const game = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(game, /observeTarget\(p, pub, myId, \{ observing: watchingOther, ownDone: localDone, jar: !!priv\?\.jarShop \}\)/,
    'the game screen passes the jar flag from the private view (TeamPanel canObserve)');
  // 两个 observeTarget 调用点都必须带 jar：watchPlayer（真正发起 g.watch 的那条路）漏传的话，
  // 「前往查看」按钮能展开、点了却被「作战中无法查看」拦下（用户 2026-10-17 实测报告的断点）。
  assert.match(game, /observeTarget\(p, L\.pub, L\.myId, \{ observing, ownDone: L\.localDone, jar: !!L\.priv\?\.jarShop \}\)/,
    'watchPlayer (the actual g.watch path) passes the jar flag too');
  assert.match(game, /watchingOther && \(!combat \|\| jarCombat\)/, 'the 只读 banner also shows in jar combat (返回自己)');
  // 联防阶段照常操作（用户 2026-10-17）：客户端 editable / 商店栏 / 插件 overlay 的门都认 UNITE
  assert.match(game, /const jarUnite = phase === PHASE\.UNITE && globalThis\.__SP_JAR_COMBAT__ === true;/, 'game.js derives jarUnite');
  assert.match(game, /\(phase === PHASE\.PREP \|\| jarCombat \|\| jarUnite\) && !!priv && alive/, 'editable covers the unite phase');
  assert.match(src, /const combat = phase === 'COMBAT' \|\| phase === 'UNITE';/, 'the MOD overlay keeps the bench alive in unite');
  assert.match(src, /const combat = !!\(pub && \(pub\.phase === 'COMBAT' \|\| pub\.phase === 'UNITE'\)\);/, 'obstacle drag stays enabled in unite');
  // 服务端：MOD 包 _watchClient 对 jar 放行活人玩家观看队友普通战场
  assert.match(src, /m\.__jarWatchWrapped = true;/, 'the MOD wraps _watchClient once');
  assert.match(src, /if \(f && f\.kind === 'normal' && own && own !== f && f\.live !== false\) \{[\s\S]*?this\.sendTo\(ps\.playerId, this\._startMsg\(f, ps\.playerId, \{ watch: true \}\)\);/, 'jar: a living player may watch a teammate normal field mid-combat');
  // AI 队友：每波战斗建立后驱动（买商店 / 砸罐部署 / 放障碍）
  assert.match(src, /if \(wasJar\) jarBotsPlay\(m\);/, 'the endPrep wrapper drives the AI teammates');
  assert.match(src, /function jarBotsPlay\(m\) \{/, 'jarBotsPlay exists');
  assert.match(src, /function jarBotDeploy\(m, ps\) \{/, 'the AI deploys its operators');
  assert.match(src, /function jarBotObstacles\(m, ps\) \{/, 'the AI places obstacles');
  // 战斗侧同步：有服务端战斗（AI headless / 接管）时直接注入，不再只发客户端消息
  assert.match(src, /if \(f\.battle && typeof f\.battle\.deployFromInput === 'function'\) \{[\s\S]*?\} else if \(m\.clientCombat\) \{\s*sendBattleMsg\(m, f, \{ t: 'b\.jarDeploy'/,
    'a deploy lands in the server battle when there is one (AI teammate headless field)');
});
