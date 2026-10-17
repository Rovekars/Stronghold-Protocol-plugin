// 创造模式 插件（MOD）
// ─────────────────────────────────────────────────────────────────────────────
// 功能：
//   ① 大厅启用卡片：主界面「01 模拟方式」两张模式卡下方出现「创造模式」卡片，点一下即开关；
//      偏好存本地（localStorage），进入模拟后自动向服务器应用（g.creativeSet）。
//   ② 对局内（休整期 PREP）：创造模式开启后，底部整个调度中心（冻结/刷新/升级/商店卡/资金）
//      替换为一个「商店」大按钮；点开即全目录面板——干员、道具全部可选，两下免费领取，
//      加入卡槽（走服务端 g.creativePick { id, kind }，从共享池扣、3 合 1 / 道具 2 合 1 照常）。
//      面板内还可设本局盟约叠层上限（默认 999，1 … 99999）。
//   ③ 创造模式关闭时原样渲染本体商店栏（ShopBar 透传）；晋升奖励等免费选择出现时也回退本体
//      商店栏，绝不挡住官方的选一拿三。
//   ④ UI 用本体设计令牌（--bg-2/--line/--mint-500/.brackets/display 字体），与整体风格一致。
//
// 实现说明（务必先看）：
//   - 本插件只是客户端 UI；发放干员 / 道具与上限裁剪全部由服务器权威执行（server/match/player/creative.js、
//     match/intents.js creativeSet、layerGainRoom 的 cap 参数）。
//   - 状态同步：g.creativeSet 广播 m.creativeState { on, layerCap }；进入对局后插件发 g.creativeGet 拉一次。
//   - 启用 / 卸下由游戏本体的 MOD 管理负责：主页左下角「插件 MOD」面板；卸下后商店栏自动回本体。
//   - 本体扩展点：api.registerShopOverride({ id, Component })（ui/shopBar.js）——Component 收到本体 ShopBar 的
//     全部 props，渲染 <${ShopBar} …props/> 即原商店栏，渲染别的即替换。
//   - 音效：面板内各按钮走本体音效（audio.sfx，../js/audio.js），与本体按钮同一套。
//   - 注意：MOD 可能以 Blob URL 加载（本地添加）；对本体模块的 '../js/…' 相对导入与 musicbox / operatorskin 等既有 MOD 一致，均可正常解析。

import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { ShopBar } from '/js/ui/shopBar.js';
import { Img, RichText } from '/js/ui/gameComponents.js';
import { chessPortraitUrl, itemIconUrl } from '/js/ui/assetUrls.js';
import { audio } from '../js/audio.js';

const PREF_KEY = 'sp.creativemode.pref'; // { on: boolean, cap: number, infiniteFunds: boolean } — 大厅开关的本地持久化

/** Local pref of the lobby switch (survives reloads; applied to the server at every match start). */
function loadPref() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return {
      on: !!(v && v.on),
      cap: Number.isFinite(v && v.cap) && v.cap >= 1 ? Math.floor(v.cap) : 999,
      infiniteFunds: !!(v && v.infiniteFunds),
    };
  } catch { return { on: false, cap: 999, infiniteFunds: false }; }
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

const PROFESSION_ZH = {
  PIONEER: '先锋', GUARD: '近卫', DEFENDER: '重装', SNIPER: '狙击', CASTER: '术师',
  MEDIC: '医疗', SUPPORTER: '辅助', SPECIALIST: '特种', MISC: '特殊',
};

// ── module-level shared sandbox state (the overlay "brain" keeps it in sync; every consumer reads it) ──
const creative = { on: false, layerCap: 999, infiniteFunds: false };
const creativeListeners = new Set();
function setCreative(patch) {
  Object.assign(creative, patch);
  creativeListeners.forEach((f) => f());
}
/** Hook: subscribe to the shared sandbox state (m.creativeState). */
function useCreative() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    creativeListeners.add(f);
    return () => { creativeListeners.delete(f); };
  }, []);
  return creative;
}

export default {
  name: '创造模式',
  version: '1.3.3',
  author: 'mod',
  // 与「盲盒模式」互斥：两者都接管休整期商店栏与对局 UI，同时启用会互相打架。启用本插件会自动卸下盲盒（反之亦然）。
  conflicts: ['blindbox'],
  description: '开启后，休整期商店变为全目录面板，干员与道具可免费自取；并可自定义本局盟约叠层上限。进模拟自动生效。',
  setup(api) {
    const { store, net, data, html, toast, registerOverlay, registerShopOverride, registerLobbyEntry } = api;

    const snapshot = () => {
      const s = store.get();
      const pub = s.match && s.match.public;
      const phase = pub && pub.phase;
      return { inMatch: !!(phase && phase !== 'LOBBY'), phase, me: s.me && s.me.playerId };
    };

    /** Headless brain: keeps the shared sandbox state in sync and auto-applies the lobby pref at match start. */
    function CreativeBrain() {
      const [, force] = useState(0);
      const s0 = snapshot();

      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);

      // the server's sandbox state (broadcast on g.creativeSet, unicast on g.creativeGet)
      useEffect(() => {
        const onState = (m) => setCreative({ on: !!m.on, layerCap: m.layerCap ?? 999, infiniteFunds: !!m.infiniteFunds });
        net.on('m.creativeState', onState);
        return () => { net.off('m.creativeState', onState); };
      }, []);

      // entering a match: pull the current sandbox state once (page reload / late join)
      useEffect(() => {
        if (s0.inMatch) net.request('g.creativeGet', {}).catch(() => {});
      }, [s0.inMatch]);

      // the lobby switch: apply the local pref at every match start (inMatch false → true). A reload
      // mid-match starts with inMatch already true → no re-apply; g.creativeGet shows the real state.
      const wasInMatch = useRef(false);
      useEffect(() => {
        if (s0.inMatch && !wasInMatch.current) {
          const pref = loadPref();
          // 进入模拟即把本地偏好应用到服务器：创造模式（免费目录 + 叠层上限）与「无限资金」各自独立，任一开启都发送
          if (pref.on || pref.infiniteFunds) net.request('g.creativeSet', { on: pref.on, layerCap: pref.cap, infiniteFunds: pref.infiniteFunds }).catch(() => {});
        }
        wasInMatch.current = s0.inMatch;
      }, [s0.inMatch]);

      return null; // no UI of its own — the shop override renders everything
    }

    /** The full catalog: every operator and every item, two-tap free pick into the hand (卡槽). */
    function CatalogPanel({ onClose, capRow, infiniteFunds }) {
      const [tab, setTab] = useState('chess'); // 'chess' | 'item'
      const [query, setQuery] = useState('');
      const [prof, setProf] = useState('ALL');
      const [bond, setBond] = useState('ALL'); // 盟约筛选：bondId 或 'ALL'
      const [rarity, setRarity] = useState(-1); // -1 = all
      const [tier, setTier] = useState(-1);
      const [armed, setArmed] = useState(null); // two-tap: armed id
      const [busy, setBusy] = useState(false);
      const [layerVal, setLayerVal] = useState(''); // 当前叠层输入（空 = 不改，占位显示当前值）
      const assets = data.get('assets');

      // re-render on store changes: the bond layers below come from m.private (pushed after g.creativeLayers)
      const [, forceRender] = useState(0);
      useEffect(() => store.subscribe(() => forceRender((n) => n + 1)), []);

      // two-tap disarm: a tap outside a card, or Escape closes the panel
      useEffect(() => {
        const onDown = (e) => { if (e.target && e.target.closest && !e.target.closest('.crv-card')) setArmed(null); };
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
      }, [onClose]);

      const chessAll = useMemo(() => {
        const list = (data.list('chess') || []).filter((c) => c && c.chessId && c.visible && !c.isDiy);
        // 只保留进阶（金色）状态：某干员存在进阶版时，未进阶的基础版不再出现在目录里
        const advanced = new Set(list
          .filter((c) => c.isGolden && (c.baseId || c.chessId))
          .map((c) => c.baseId || c.chessId));
        const withGoldenId = new Set(list.filter((c) => c.goldenId).map((c) => c.chessId));
        return list
          .filter((c) => c.isGolden || (!advanced.has(c.chessId) && !withGoldenId.has(c.chessId)))
          .sort((a, b) => (b.rarity - a.rarity) || String(a.name).localeCompare(String(b.name), 'zh'));
      }, []);
      const itemAll = useMemo(() => (data.list('items') || [])
        .filter((it) => it && it.id)
        .sort((a, b) => ((b.tier || 0) - (a.tier || 0)) || String(a.name).localeCompare(String(b.name), 'zh'))
      , []);

      const chessShown = useMemo(() => chessAll.filter((c) => {
        if (prof !== 'ALL' && c.profession !== prof) return false;
        if (bond !== 'ALL' && !(Array.isArray(c.bonds) && c.bonds.includes(bond))) return false;
        if (rarity >= 0 && c.rarity !== rarity) return false;
        if (query) {
          const q = query.toLowerCase();
          const hay = `${c.name || ''} ${c.appellation || ''} ${c.subProfessionName || ''} ${c.chessId}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }), [chessAll, prof, bond, rarity, query]);

      // 盟约下拉分组：常驻在前、赛季在后（bonds.json 的 bondType / bondOrder）
      const bondGroups = useMemo(() => {
        const bl = (data.list('bonds') || []).filter((b) => b && b.bondId && b.name);
        const byType = (t) => bl.filter((b) => (b.bondType || 'REGULAR') === t)
          .sort((a, b) => ((a.bondOrder ?? 99) - (b.bondOrder ?? 99)) || String(a.name).localeCompare(String(b.name), 'zh'));
        return [['常驻盟约', byType('REGULAR')], ['赛季盟约', byType('SEASON')]].filter(([, l]) => l.length);
      }, []);

      const itemShown = useMemo(() => itemAll.filter((it) => {
        if (tier >= 0 && (it.tier ?? 0) !== tier) return false;
        if (query) {
          const q = query.toLowerCase();
          const hay = `${it.name || ''} ${it.id}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }), [itemAll, tier, query]);

      const pick = async (kind, id) => {
        if (busy) return;
        setBusy(true);
        try {
          await net.request('g.creativePick', { id, kind });
          const rec = kind === 'item' ? data.lookup('items', id) : data.lookup('chess', id);
          toast(`已领取 ${rec && rec.name ? rec.name : id}（已加入卡槽）`, 'success');
        } catch (e) {
          toast('领取失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        } finally {
          setBusy(false);
        }
      };

      /** 当前叠层：把选中的盟约直接设为 N 层（服务端 g.creativeLayers，PREP 且创造模式开启时才接受）。 */
      const applyLayers = async () => {
        if (bond === 'ALL') { toast('先在「全部盟约」里选一个盟约，再设置它的叠层', 'warn'); return; }
        const n = parseInt(layerVal, 10);
        if (!Number.isInteger(n) || n < 0) { toast('叠层需为 0 及以上的整数', 'warn'); return; }
        setBusy(true);
        try {
          await net.request('g.creativeLayers', { bondId: bond, layers: n });
          const bn = (data.list('bonds') || []).find((b) => b.bondId === bond);
          toast(`【${bn && bn.name ? bn.name : bond}】叠层已设为 ${n}`, 'success');
          setLayerVal('');
        } catch (e) {
          toast('设置失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        } finally { setBusy(false); }
      };

      // 选中盟约的当前层数（m.private bonds[]；设置后服务端 markPrivate 推新值，store 订阅触发重渲染）
      const privBonds = (store.get().match && store.get().match.private && store.get().match.private.bonds) || [];
      const curBond = bond !== 'ALL' ? privBonds.find((b) => b && b.bondId === bond) : null;
      const curLayers = curBond ? Number(curBond.layers) || 0 : null;

      const tapCard = (kind, id) => {
        const key = `${kind}:${id}`;
        if (armed !== key) { audio.sfx('click', { volume: 0.4 }); setArmed(key); return; }
        setArmed(null);
        audio.sfx('pick', { volume: 0.5 });
        pick(kind, id);
      };

      const professions = ['ALL', ...[...new Set(chessAll.map((c) => c.profession).filter(Boolean))]];
      const inputStyle = { padding: '.04rem .08rem', background: THEME.bg, border: `1px solid ${THEME.border2}`, color: THEME.text, fontSize: '.12rem' };
      const tabBtn = (id, label) => html`
        <button type="button" onClick=${() => { audio.sfx('tab', { volume: 0.5 }); setTab(id); setArmed(null); }}
          style=${{ padding: '.05rem .16rem', cursor: 'pointer', fontFamily: THEME.display, fontSize: '.13rem', letterSpacing: '.1em',
            border: `1px solid ${tab === id ? THEME.accent : THEME.border}`,
            background: tab === id ? THEME.accentA10 : 'none', color: tab === id ? THEME.accent : THEME.dim }}>${label}</button>`;

      return html`
        <section class="brackets" aria-label="创造模式·全目录"
          style=${{ position: 'fixed', left: '50%', bottom: '2.6rem', transform: 'translateX(-50%)', zIndex: 60,
            width: '9rem', maxWidth: '94vw', maxHeight: '72vh', display: 'flex', flexDirection: 'column',
            background: THEME.panel, border: `1px solid ${THEME.border}`,
            boxShadow: '0 .18rem .5rem rgba(0,0,0,.45)', pointerEvents: 'auto' }}>
          <header style=${{ display: 'flex', alignItems: 'baseline', gap: '.1rem', padding: '.12rem .14rem .08rem',
            borderBottom: `1px solid ${THEME.border}` }}>
            <span style=${{ fontFamily: THEME.display, fontSize: '.18rem', letterSpacing: '.1em', color: THEME.text }}>商店</span>
            <span style=${{ fontFamily: THEME.display, fontSize: '.1rem', letterSpacing: '.14em', color: THEME.dim2 }}>CREATIVE SHOP</span>
            <span style=${{ flex: 1 }}></span>
            ${capRow}
            ${infiniteFunds ? html`<span style=${{ fontFamily: THEME.display, fontSize: '.1rem', letterSpacing: '.12em', color: THEME.gold, border: `1px solid ${THEME.gold}`, padding: '.02rem .08rem', borderRadius: '.03rem' }}>∞ 资金</span>` : null}
            <button type="button" onClick=${() => { audio.sfx('back', { volume: 0.5 }); onClose(); }}
              style=${{ background: 'none', border: 'none', color: THEME.dim, cursor: 'pointer', fontSize: '.14rem' }}>✕</button>
          </header>

          <div style=${{ display: 'flex', alignItems: 'center', gap: '.08rem', padding: '.1rem .14rem', flexWrap: 'wrap',
            borderBottom: `1px solid ${THEME.border}` }}>
            ${tabBtn('chess', '干员')}
            ${tabBtn('item', '道具')}
            <input type="search" placeholder=${tab === 'chess' ? '搜索干员…' : '搜索道具…'} value=${query}
              onInput=${(e) => setQuery(e.target.value)} style=${{ flex: 1, minWidth: '1.2rem', ...inputStyle }} />
            ${tab === 'chess' ? html`
              <select value=${prof} onChange=${(e) => setProf(e.target.value)}
                style=${{ padding: '.04rem .06rem', background: THEME.bg, border: `1px solid ${THEME.border2}`, color: THEME.md, fontSize: '.11rem' }}>
                ${professions.map((p) => html`<option key=${p} value=${p}>${p === 'ALL' ? '全部职业' : (PROFESSION_ZH[p] || p)}</option>`)}
              </select>
              <select value=${bond} onChange=${(e) => { setBond(e.target.value); setArmed(null); }}
                style=${{ padding: '.04rem .06rem', background: THEME.bg, border: `1px solid ${THEME.border2}`, color: THEME.md, fontSize: '.11rem' }}>
                <option key="ALL" value="ALL">全部盟约</option>
                ${bondGroups.map(([label, list]) => html`
                  <optgroup key=${label} label=${label}>
                    ${list.map((b) => html`<option key=${b.bondId} value=${b.bondId}>${b.name}</option>`)}
                  </optgroup>`)}
              </select>
              <span style=${{ display: 'flex', alignItems: 'center', gap: '.04rem' }}>
                <span style=${{ color: THEME.dim, fontSize: '.11rem' }}>当前叠层</span>
                <input type="number" min="0" max="99999" value=${layerVal} placeholder=${String(curLayers ?? 0)}
                  title=${bond === 'ALL' ? '先选一个盟约' : '设为该盟约的当前层数（0 … 上限）'}
                  onInput=${(e) => setLayerVal(e.target.value)}
                  onKeyDown=${(e) => { if (e.key === 'Enter') applyLayers(); e.stopPropagation(); }}
                  onClick=${(e) => e.stopPropagation()}
                  style=${{ width: '.52rem', padding: '.03rem .05rem', background: THEME.bg, border: `1px solid ${THEME.border2}`,
                    color: THEME.text, fontSize: '.12rem' }} />
                <button type="button" disabled=${busy || bond === 'ALL'} onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); applyLayers(); }}
                  title=${bond === 'ALL' ? '先选一个盟约' : '把该盟约的当前叠层设为这个值'}
                  style=${{ padding: '.03rem .08rem', cursor: bond === 'ALL' ? 'not-allowed' : 'pointer',
                    background: bond === 'ALL' ? THEME.panel2 : THEME.accent,
                    color: bond === 'ALL' ? THEME.dim2 : THEME.onAccent, border: 'none',
                    fontFamily: THEME.display, fontSize: '.11rem', letterSpacing: '.08em' }}>设置</button>
                ${curLayers !== null ? html`<span style=${{ color: THEME.dim2, fontSize: '.11rem' }}>现 ${curLayers}</span>` : null}
              </span>
              ${[-1, 5, 4, 3, 2, 1, 0].map((r) => html`
                <button type="button" key=${r} onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setRarity(r); }}
                  style=${{ padding: '.03rem .07rem', cursor: 'pointer', fontSize: '.11rem',
                    border: `1px solid ${rarity === r ? THEME.accent : THEME.border}`,
                    background: rarity === r ? THEME.accentA10 : 'none', color: rarity === r ? THEME.accent : THEME.dim }}>
                  ${r < 0 ? '全' : '★'.repeat(r) || '☆'}
                </button>`)}
            ` : html`
              ${[-1, 5, 4, 3, 2, 1].map((r) => html`
                <button type="button" key=${r} onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setTier(r); }}
                  style=${{ padding: '.03rem .07rem', cursor: 'pointer', fontSize: '.11rem',
                    border: `1px solid ${tier === r ? THEME.accent : THEME.border}`,
                    background: tier === r ? THEME.accentA10 : 'none', color: tier === r ? THEME.accent : THEME.dim }}>
                  ${r < 0 ? '全' : 'T' + r}
                </button>`)}
            `}
          </div>

          ${tab === 'chess' ? html`
            <div style=${{ overflowY: 'auto', padding: '.1rem .14rem .14rem', display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(1.5rem, 1fr))', gap: '.08rem', alignContent: 'start' }}>
              ${chessShown.map((c) => {
                const isArmed = armed === `chess:${c.chessId}`;
                const golden = !!c.isGolden;
                return html`
                  <button type="button" key=${c.chessId} class="crv-card" disabled=${busy}
                    onClick=${() => tapCard('chess', c.chessId)}
                    title="${c.name}${c.subProfessionName ? ' · ' + c.subProfessionName : ''}${golden ? ' · 金色' : ''}"
                    style=${{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '.03rem',
                      padding: '.06rem', cursor: 'pointer', textAlign: 'left', position: 'relative',
                      background: isArmed ? THEME.accentA10 : THEME.panel2,
                      border: `1px solid ${isArmed ? THEME.accent : (golden ? THEME.gold : THEME.border)}`,
                      boxShadow: isArmed ? `inset 0 0 0 1px ${THEME.accent}` : 'none' }}>
                    <span style=${{ position: 'relative', display: 'block', height: '.72rem', overflow: 'hidden', background: THEME.bg }}>
                      <${Img} src=${chessPortraitUrl(assets, c)} style=${{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: '50% 0%' }} />
                      <span style=${{ position: 'absolute', top: '.03rem', left: '.03rem', fontSize: '.09rem',
                        color: c.rarity >= 5 ? THEME.accent : THEME.md, textShadow: '0 0 .06rem #000' }}>
                        ${'★'.repeat(Math.max(0, c.rarity || 0))}</span>
                      ${golden ? html`<span style=${{ position: 'absolute', top: '.03rem', right: '.03rem', fontSize: '.09rem',
                        fontFamily: THEME.display, color: THEME.gold, textShadow: '0 0 .06rem #000' }}>金色</span>` : null}
                    </span>
                    <b style=${{ fontSize: '.12rem', color: golden ? THEME.gold : (c.rarity >= 5 ? THEME.accent : THEME.text),
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${c.name || c.chessId}</b>
                    <span style=${{ fontSize: '.1rem', color: THEME.dim, whiteSpace: 'nowrap', overflow: 'hidden',
                      textOverflow: 'ellipsis' }}>${PROFESSION_ZH[c.profession] || c.profession || ''}${c.subProfessionName ? ' · ' + c.subProfessionName : ''}</span>
                    ${isArmed ? html`<span style=${{ fontSize: '.1rem', color: THEME.accent, fontFamily: THEME.display }}>再点一次领取</span>` : null}
                  </button>`;
              })}
              ${chessShown.length === 0 ? html`<span style=${{ gridColumn: '1 / -1', color: THEME.dim, fontSize: '.12rem', padding: '.1rem 0' }}>没有匹配的干员</span>` : null}
            </div>
          ` : html`
            <div style=${{ overflowY: 'auto', padding: '.1rem .14rem .14rem', display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(2.1rem, 1fr))', gap: '.08rem', alignContent: 'start' }}>
              ${itemShown.map((it) => {
                const isArmed = armed === `item:${it.id}`;
                return html`
                  <button type="button" key=${it.id} class="crv-card" disabled=${busy}
                    onClick=${() => tapCard('item', it.id)} title="${it.name || it.id}"
                    style=${{ display: 'flex', alignItems: 'flex-start', gap: '.07rem', padding: '.07rem',
                      cursor: 'pointer', textAlign: 'left',
                      background: isArmed ? THEME.accentA10 : THEME.panel2,
                      border: `1px solid ${isArmed ? THEME.accent : THEME.border}`,
                      boxShadow: isArmed ? `inset 0 0 0 1px ${THEME.accent}` : 'none' }}>
                    <span style=${{ flex: 'none', width: '.44rem', height: '.44rem', display: 'grid', placeItems: 'center',
                      background: THEME.bg, border: `1px solid ${THEME.border2}`, overflow: 'hidden' }}>
                      <${Img} src=${itemIconUrl(assets, it)} fallback=${html`<span style=${{ color: THEME.dim2, fontSize: '.1rem' }}>?</span>`}
                        style=${{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    </span>
                    <span style=${{ display: 'flex', flexDirection: 'column', gap: '.02rem', minWidth: 0, flex: 1 }}>
                      <b style=${{ fontSize: '.12rem', color: THEME.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        ${it.name || it.id}<span style=${{ color: THEME.dim, fontSize: '.1rem' }}> · T${it.tier ?? 1}</span></b>
                      <span style=${{ fontSize: '.1rem', color: THEME.dim, lineHeight: 1.5, display: '-webkit-box',
                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        <${RichText} text=${it.descRaw || it.desc || ''} />
                      </span>
                      ${isArmed ? html`<span style=${{ fontSize: '.1rem', color: THEME.accent, fontFamily: THEME.display }}>再点一次领取</span>` : null}
                    </span>
                  </button>`;
              })}
              ${itemShown.length === 0 ? html`<span style=${{ gridColumn: '1 / -1', color: THEME.dim, fontSize: '.12rem', padding: '.1rem 0' }}>没有匹配的道具</span>` : null}
            </div>
          `}
        </section>`;
    }

    /**
     * The shop-bar replacement (registerShopOverride). Receives the exact props of the default <ShopBar>.
     * Creative off, or a promotion / special reward waiting: the official bar renders untouched. Creative on:
     * the whole bar becomes one 商店 button (card-row height) that opens the full catalog.
     */
    function CreativeShop(props) {
      const cr = useCreative();
      const [open, setOpen] = useState(false);
      const [capDraft, setCapDraft] = useState('999');
      const [busy, setBusy] = useState(false);
      const s0 = snapshot();
      const isPrep = s0.phase === 'PREP';

      useEffect(() => { setCapDraft(String(cr.layerCap ?? 999)); }, [cr.layerCap]);

      // reward offers (晋升奖励 / 定向投放 …) render their pick-one cards inside the official bar — never cover them
      const showReward = !!(props.reward && Array.isArray(props.reward.slots) && props.reward.slots.length);
      // 不接管时交给链上的下一个（props.next：另一个 MOD 的商店覆盖，链尾是官方商店栏）——创造模式与「盲盒」因此
      // 可以共存，谁该接管由各自的开关决定，而不是由注册顺序决定。
      if (!cr.on || showReward) {
        return props.next ? html`<${props.next} ...${props} />` : html`<${ShopBar} ...${props} />`;
      }

      const applyCap = async () => {
        const n = parseInt(capDraft, 10);
        if (!Number.isInteger(n) || n < 1 || n > 99999) { toast('上限需为 1 … 99999 的整数', 'warn'); return; }
        setBusy(true);
        try {
          await net.request('g.creativeSet', { on: true, layerCap: n });
          toast(`盟约叠层上限已设为 ${n}`, 'success');
        } catch (e) {
          toast('设置失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        } finally { setBusy(false); }
      };

      const capRow = html`
        <label style=${{ color: THEME.dim, fontSize: '.11rem' }}>盟约叠层上限</label>
        <input type="number" min="1" max="99999" value=${capDraft}
          onInput=${(e) => setCapDraft(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') applyCap(); e.stopPropagation(); }}
          onClick=${(e) => e.stopPropagation()}
          style=${{ width: '.62rem', padding: '.03rem .05rem', background: THEME.bg, border: `1px solid ${THEME.border2}`,
            color: THEME.text, fontSize: '.12rem' }} />
        <button type="button" disabled=${busy} onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); applyCap(); }}
          style=${{ padding: '.03rem .09rem', cursor: 'pointer', background: THEME.accent, color: THEME.onAccent,
            border: 'none', fontFamily: THEME.display, fontSize: '.11rem', letterSpacing: '.08em' }}>应用</button>`;

      return html`
        ${open ? html`<${CatalogPanel} onClose=${() => setOpen(false)} capRow=${capRow} infiniteFunds=${cr.infiniteFunds} />` : null}
        <section class=${'shopbar'} aria-label=${'创造模式·商店'} ref=${props.barRef}>
          <div class="shopbar__row" style=${{ justifyContent: 'center' }}>
            <button type="button" class="brackets" onClick=${() => { audio.sfx('click', { volume: 0.4 }); setOpen(true); }}
              style=${{ '--bk-c': THEME.accent, display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: '.06rem', height: '2.1rem', minWidth: '5.5rem', padding: '0 .5rem',
                cursor: 'pointer', background: 'linear-gradient(180deg, rgba(28, 34, 31, .92), rgba(13, 16, 15, .94))',
                border: `1px solid ${THEME.accent}`,
                boxShadow: '0 0 0 1px rgba(78, 216, 175, .22), 0 0 .44rem rgba(23, 249, 183, .13), inset 0 0 .7rem rgba(23, 249, 183, .05)' }}>
              <span style=${{ fontFamily: THEME.display, fontSize: '.11rem', letterSpacing: '.22em', color: THEME.accent }}>SHOP</span>
              <span style=${{ fontFamily: THEME.display, fontSize: '.34rem', fontWeight: 900, letterSpacing: '.18em',
                color: THEME.text, lineHeight: 1 }}>商店</span>
              <span style=${{ fontSize: '.11rem', color: THEME.dim }}>创造模式 · 全部干员与道具免费领取</span>
            </button>
          </div>
          ${isPrep ? null : null}
        </section>`;
    }

    /** The lobby card under the 01 模拟方式 mode cards: the enable switch (local pref, auto-applied at match start). The
     *  创造模式 switch (free catalog + layer cap) and the 无限资金 switch are independent sandbox toggles — either may be
     *  on without the other; both are applied to the server at match start via g.creativeSet. */
    function CreativeLobbyCard() {
      const [pref, setPref] = useState(loadPref);
      const on = pref.on;
      const inf = pref.infiniteFunds;

      const toggle = () => {
        const next = { ...pref, on: !on };
        setPref(next);
        savePref(next);
        toast(next.on
          ? `创造模式已开启：进入模拟后自动生效（叠层上限 ${next.cap}）`
          : '创造模式已关闭：之后的模拟不再生效', next.on ? 'success' : 'info');
      };

      const toggleInf = () => {
        const next = { ...pref, infiniteFunds: !inf };
        setPref(next);
        savePref(next);
        toast(next.infiniteFunds
          ? '无限资金已开启：购买 / 刷新 / 升级不再消耗资金'
          : '无限资金已关闭：之后的模拟恢复正常经济', next.infiniteFunds ? 'success' : 'info');
      };

      // the pill switch (shared by both toggles). stop MUST be true for both: the main row is itself a
      // <button>, so a bubbling pill click would run toggle twice in the same event (toast ×2).
      const switchEl = (active, onClick, stop) => html`
        <button type="button" aria-pressed=${active ? 'true' : 'false'}
          onClick=${(e) => { if (stop) e.stopPropagation(); onClick(); }}
          style=${{ position: 'relative', display: 'block', width: '.52rem', height: '.26rem', flex: 'none',
            border: `1px solid ${active ? THEME.accent : THEME.border2}`, background: active ? THEME.accentA10 : THEME.bg,
            cursor: 'pointer', transition: 'all var(--t-med)' }}>
          <span style=${{ position: 'absolute', top: '2px', left: active ? 'calc(100% - .2rem - 2px)' : '2px',
            width: '.18rem', height: '.16rem', background: active ? THEME.accent : THEME.dim2,
            transition: 'left var(--t-med) var(--ease-out)' }}></span>
        </button>`;

      return html`
        <div class="brackets" style=${{ '--bk-c': on ? 'var(--mint-400)' : 'var(--line-2)', display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(28, 34, 31, .92), rgba(13, 16, 15, .94))',
          border: `1px solid ${on ? 'var(--mint-700)' : 'var(--line)'}`,
          boxShadow: on ? '0 0 0 1px rgba(78, 216, 175, .22), 0 0 .44rem rgba(23, 249, 183, .13), inset 0 0 .7rem rgba(23, 249, 183, .05)' : 'none',
          transition: 'border-color var(--t-med), box-shadow var(--t-med)' }}>
          <button type="button" onClick=${toggle} aria-pressed=${on ? 'true' : 'false'}
            style=${{ display: 'flex', alignItems: 'center', gap: '.22rem', width: '100%',
              padding: '.2rem .32rem', textAlign: 'left', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' }}>
            <span aria-hidden="true" style=${{ flex: 'none', width: '.56rem', height: '.56rem', display: 'grid', placeItems: 'center',
              background: on ? 'var(--mint-500)' : '#0c0f0e', border: `1px solid ${on ? 'var(--mint-400)' : 'var(--line-2)'}`,
              color: on ? 'var(--text-on-mint)' : 'var(--text-md)',
              clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)' }}>
              <svg viewBox="0 0 24 24" style=${{ width: '.28rem', height: '.28rem' }} aria-hidden="true">
                <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill="currentColor" />
              </svg>
            </span>
            <span style=${{ display: 'flex', flexDirection: 'column', gap: '.05rem', minWidth: 0, flex: 1 }}>
              <span style=${{ fontFamily: THEME.display, fontSize: '.11rem', letterSpacing: '.18em',
                color: on ? THEME.accent : THEME.dim2 }}>CREATIVE MODE</span>
              <span style=${{ fontFamily: THEME.display, fontSize: '.24rem', fontWeight: 900, letterSpacing: '.08em',
                lineHeight: 1.1, color: THEME.text }}>创造模式</span>
              <span style=${{ fontSize: '.15rem', color: THEME.dim, lineHeight: 1.65 }}>
                开启后进入模拟自动生效：休整期商店变为「商店」按钮，点开即全目录——所有干员与道具免费领取加入卡槽（3 合 1 照常），并可自定义本局盟约叠层上限（当前 ${pref.cap}）。
              </span>
            </span>
            ${switchEl(on, toggle, true)}
          </button>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '.14rem', padding: '.12rem .32rem',
            borderTop: `1px solid ${THEME.border2}` }}>
            <span style=${{ flex: 1, display: 'flex', flexDirection: 'column', gap: '.02rem', minWidth: 0 }}>
              <span style=${{ fontSize: '.15rem', color: THEME.text }}>无限资金</span>
              <span style=${{ fontSize: '.11rem', color: THEME.dim, lineHeight: 1.5 }}>开启后资金不再减少：可随意购买 / 刷新 / 升级（独立于创造模式）。</span>
            </span>
            ${switchEl(inf, toggleInf, true)}
          </div>
        </div>`;
    }

    registerLobbyEntry({ id: 'creative-mode', Component: CreativeLobbyCard });
    registerOverlay(CreativeBrain);
    registerShopOverride({ id: 'creative-shop', Component: CreativeShop });
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'creativemode';
