// 干员时装 插件（MOD）
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 功能：
//   ① 在「干员调配」的干员详情弹窗头部（恢复默认按钮左边）新增一个「👗 时装」按钮；
//   ② 点击弹出该干员自己的时装面板，点缩略图立即更换（再点一次取消回默认），详情立绘/头像即时刷新；
//   ③ 面板底部可打开完整时装回廊（520+ 套，支持搜索 / 系列筛选）；
//   ④ 应用皮肤后：调配列表头像、详情立绘、局内头像/立绘都会显示皮肤图；
//   ⑤ 有 PRTS 骨骼数据的皮肤，战斗棋盘上的干员模型也会换成该皮肤（正面/背面）；
//   ⑥ 选择持久化到 localStorage，刷新后仍然生效。
//
// 实现说明：
//   - 数据：构建期脚本 tools/fetch-prts-costumes.mjs（图片）与 tools/fetch-prts-spine.mjs（骨骼模型，
//     数据源 torappu.prts.wiki/assets/char_spine，CORS 全开）分别生成 data/costumes.json 与
//     data/costume-spine.json；插件运行时 fetch 这两个 JSON（同源），图片 URL 直接给 <img> 热链；
//   - 皮肤覆盖：public/js/skinState.js（共享状态）+ ui/assetUrls.js（DOM 头像/立绘拦截）+
//     assets.js（战斗渲染：spineEntry 换骨骼模型、unitPictureUrl 换棋盘头像钻石）；
//   - 入口：本体扩展点 api.registerDetailAction（由 public/js/main.js + screens/loadout.js 提供，
//     onClick 会收到当前选中的干员 chess 记录）。
//
// 数据来源：https://prts.wiki/w/时装回廊（抓取时点 2026-10）。

import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { loadPref, savePref } from '../js/store.js';
import { audio } from '../js/audio.js';
import { setSkinOverride, clearSkinOverride } from '../js/ui/assetUrls.js';
import { modsOffMap, MODS_EVENT } from '../js/ui/mods.js';

const PREF_KEY = 'operatorskin';
const DATA_URL = '/data/costumes.json';
const SPINE_URL = '/data/costume-spine.json';
const LIST_STEP = 40; // 分页/虚拟滚动步长

const THEME = {
  // 本体设计令牌（public/css/theme.css）：绿灰面板 + 薄荷绿点缀 + display 字体，不再自带配色。
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
};

function cx(...p) { return p.flat().filter(Boolean).join(' '); }

/** Deep-equality for arrays of strings. */
function eqSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function loadSelections() {
  try {
    const raw = loadPref(PREF_KEY);
    if (raw && typeof raw === 'object') return raw;
  } catch { /* ignore */ }
  return {};
}

function saveSelections(map) {
  savePref(PREF_KEY, map);
}

/** Apply a costume to every charId whose chess name matches the operator. */
function applyCostume(costume, chessMap, spineData) {
  if (!costume) return;
  for (const [charId, rec] of Object.entries(chessMap || {})) {
    if (rec.name !== costume.operator) continue;
    const sp = spineData?.chars?.[charId]?.[costume.skinName] || null;
    setSkinOverride(charId, {
      avatar: costume.head,
      portrait: costume.bust,
      spineFront: sp?.front || null,
      spineBack: sp?.back || null,
    });
  }
}

/** Remove the override for an operator from every matching charId. */
function unapplyCostume(operator, chessMap) {
  for (const [charId, rec] of Object.entries(chessMap || {})) {
    if (rec.name === operator) clearSkinOverride(charId);
  }
}

/** Build a quick operator -> charIds index from the chess data module when available. */
function indexChess(dataModule) {
  const map = {};
  try {
    const list = dataModule?.list ? dataModule.list('chess') : [];
    for (const c of list) if (c && c.charId && c.name) map[c.charId] = c;
  } catch { /* data may not be loaded yet */ }
  return map;
}

export default function setup(api) {
  const { html, registerDetailAction, data, toast } = api;

  function SkinGallery({ costumes, seriesList, selections, spineKeys, onPick, onClose }) {
    const [query, setQuery] = useState('');
    const [series, setSeries] = useState('全部');
    const [page, setPage] = useState(1);
    const scrollRef = useRef(null);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      return costumes.filter((c) => {
        if (series !== '全部' && c.series !== series) return false;
        if (!q) return true;
        return (c.operator + c.skinName + c.series + c.brandEn).toLowerCase().includes(q);
      });
    }, [costumes, query, series]);

    const pageCount = Math.ceil(filtered.length / LIST_STEP);
    const shown = filtered.slice(0, page * LIST_STEP);

    // reset page when filter changes
    useEffect(() => { setPage(1); }, [query, series]);

    // infinite scroll
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return undefined;
      const onScroll = () => {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && page < pageCount) setPage((p) => p + 1);
      };
      el.addEventListener('scroll', onScroll);
      return () => el.removeEventListener('scroll', onScroll);
    }, [pageCount, page]);

    return html`<div class="oskin-modal" style=${{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style=${{ position: 'absolute', inset: 0, background: 'rgba(5, 8, 7, 0.72)' }} onClick=${() => { audio.sfx('back', { volume: 0.5 }); onClose(); }}></div>
    <div class="brackets" style=${{ position: 'relative', width: 'min(900px, 92vw)', height: 'min(760px, 88vh)', background: THEME.panel, border: `1px solid ${THEME.border2}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 0.4rem 1.2rem rgba(0, 0, 0, 0.55)' }}>
      <header style=${{ display: 'flex', alignItems: 'center', gap: '0.1rem', padding: '0.13rem 0.18rem', borderBottom: `1px solid ${THEME.border}`, flexWrap: 'wrap' }}>
        <i style=${{ width: '0.05rem', height: '0.2rem', background: THEME.accent, flex: 'none' }}></i>
        <b style=${{ color: THEME.text, fontSize: '0.2rem', fontWeight: 900, letterSpacing: '0.08em', marginRight: '0.04rem' }}>时装回廊</b>
        <span style=${{ fontFamily: THEME.display, fontSize: '0.11rem', letterSpacing: '0.18em', color: 'var(--mint-700)', textTransform: 'uppercase' }}>COSTUME GALLERY</span>
        <input type="text" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)}
          placeholder="搜索干员 / 皮肤 / 系列" style=${{ flex: 1, minWidth: '2rem', marginLeft: '0.1rem', padding: '0.07rem 0.12rem', background: THEME.bg, border: `1px solid ${THEME.border2}`, color: THEME.text, fontSize: '0.13rem' }} />
        <select value=${series} onChange=${(e) => setSeries(e.currentTarget.value)}
          style=${{ padding: '0.07rem 0.12rem', background: THEME.bg, border: `1px solid ${THEME.border2}`, color: THEME.text, fontSize: '0.13rem' }}>
          <option value="全部">全部系列</option>
          ${seriesList.map((s) => html`<option value=${s}>${s}</option>`)}
        </select>
        <button type="button" onClick=${() => { audio.sfx('back', { volume: 0.5 }); onClose(); }} style=${{ padding: '0.07rem 0.14rem', background: 'transparent', border: `1px solid ${THEME.border2}`, color: THEME.dim, cursor: 'pointer', fontSize: '0.12rem', letterSpacing: '0.08em' }}>关闭</button>
      </header>
      <div ref=${scrollRef} style=${{ flex: 1, overflow: 'auto', padding: '0.14rem' }}>
        <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(1.4rem, 1fr))', gap: '0.12rem' }}>
          ${shown.map((c) => {
            const active = selections[c.operator] === c.id;
            const hasModel = spineKeys.has(`${c.operator}\u0000${c.skinName}`);
            return html`<button type="button" key=${c.id} onClick=${() => { audio.sfx('pick', { volume: 0.5 }); onPick(c); }}
              title=${`${c.operator} · ${c.skinName}`}
              style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.06rem', padding: '0.1rem', background: active ? THEME.accentA10 : THEME.panel2, border: `1px solid ${active ? THEME.accent : THEME.border}`, borderRadius: '0.02rem', cursor: 'pointer', transition: 'border-color .15s, background .15s' }}>
              <div style=${{ width: '1.1rem', height: '1.1rem', overflow: 'hidden', background: THEME.bg, border: `1px solid ${THEME.border}` }}>
                <img src=${c.head || c.bust} loading="lazy" style=${{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError=${(e) => { e.currentTarget.style.display = 'none'; }} />
              </div>
              <span style=${{ fontSize: '0.12rem', color: active ? THEME.accent : THEME.text, fontWeight: 700, textAlign: 'center', lineHeight: 1.2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${c.skinName}</span>
              <span style=${{ fontFamily: THEME.display, fontSize: '0.1rem', letterSpacing: '0.1em', color: hasModel ? THEME.accent : THEME.dim2, textAlign: 'center' }}>${hasModel ? '⚔ 战斗模型' : c.operator}</span>
              ${active ? html`<span style=${{ fontSize: '0.1rem', color: THEME.accent, letterSpacing: '0.08em' }}>✓ 当前</span>` : null}
            </button>`;
          })}
        </div>
        ${shown.length < filtered.length ? html`<div style=${{ textAlign: 'center', padding: '0.16rem', color: THEME.dim2 }}>向下滚动加载更多…</div>` : null}
        ${!shown.length ? html`<div style=${{ textAlign: 'center', padding: '0.4rem', color: THEME.dim2 }}>没有匹配的时装</div>` : null}
      </div>
      <footer style=${{ padding: '0.1rem 0.18rem', borderTop: `1px solid ${THEME.border}`, color: THEME.dim2, fontSize: '0.12rem', display: 'flex', justifyContent: 'space-between' }}>
        <span>共 <b class="num" style=${{ color: THEME.md }}>${filtered.length}</b> 套 · 已选 <b class="num" style=${{ color: THEME.md }}>${Object.keys(selections).length}</b> 名干员</span>
        <span style=${{ fontFamily: THEME.display, fontSize: '0.1rem', letterSpacing: '0.14em', color: THEME.dim2 }}>PRTS 时装回廊</span>
      </footer>
    </div>
  </div>`;
}

/** Quick-swap panel for ONE operator: every costume of theirs, click to apply/cancel instantly. */
function SkinPanel({ operator, costumes, selections, spineKeys, onPick, onClose, onBrowseAll }) {
  const mine = useMemo(() => costumes.filter((c) => c.operator === operator), [costumes, operator]);
  return html`<div class="oskin-panel" style=${{ position: 'fixed', inset: 0, zIndex: 201 }}>
    <div style=${{ position: 'absolute', inset: 0, background: 'rgba(5, 8, 7, 0.5)' }} onClick=${() => { audio.sfx('back', { volume: 0.5 }); onClose(); }}></div>
    <div class="brackets" style=${{ position: 'absolute', top: '0.7rem', right: '0.18rem', width: 'min(3.6rem, 86vw)', maxHeight: '72vh', display: 'flex', flexDirection: 'column', background: THEME.panel, border: `1px solid ${THEME.border2}`, boxShadow: '0 0.3rem 1rem rgba(0, 0, 0, 0.55)', overflow: 'hidden' }}>
      <header style=${{ display: 'flex', alignItems: 'center', gap: '0.1rem', padding: '0.11rem 0.14rem', borderBottom: `1px solid ${THEME.border}` }}>
        <i style=${{ width: '0.05rem', height: '0.18rem', background: THEME.accent, flex: 'none' }}></i>
        <b style=${{ color: THEME.text, fontSize: '0.15rem', fontWeight: 900, letterSpacing: '0.06em' }}>${operator} 的时装</b>
        <span style=${{ fontFamily: THEME.display, fontSize: '0.1rem', letterSpacing: '0.18em', color: 'var(--mint-700)', textTransform: 'uppercase' }}>COSTUME</span>
        <span style=${{ marginLeft: 'auto', color: THEME.dim2, fontSize: '0.11rem' }}>点击更换</span>
        <button type="button" onClick=${() => { audio.sfx('back', { volume: 0.5 }); onClose(); }} style=${{ width: '0.26rem', height: '0.26rem', display: 'grid', placeItems: 'center', background: 'transparent', border: `1px solid ${THEME.border2}`, color: THEME.dim, cursor: 'pointer', fontSize: '0.12rem' }}>✕</button>
      </header>
      <div style=${{ flex: 1, overflow: 'auto', padding: '0.12rem' }}>
        <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(1.05rem, 1fr))', gap: '0.1rem' }}>
          ${mine.map((c) => {
            const active = selections[c.operator] === c.id;
            const hasModel = spineKeys.has(`${c.operator}\u0000${c.skinName}`);
            return html`<button type="button" key=${c.id} onClick=${() => { audio.sfx('pick', { volume: 0.5 }); onPick(c); }} title=${c.skinName}
              style=${{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.04rem', padding: '0.07rem', background: active ? THEME.accentA10 : THEME.panel2, border: `1px solid ${active ? THEME.accent : THEME.border}`, borderRadius: '0.02rem', cursor: 'pointer', transition: 'border-color .15s, background .15s' }}>
              <div style=${{ width: '0.8rem', height: '0.8rem', overflow: 'hidden', background: THEME.bg, border: `1px solid ${THEME.border}` }}>
                <img src=${c.head || c.bust} loading="lazy" style=${{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError=${(e) => { e.currentTarget.style.display = 'none'; }} />
              </div>
              <span style=${{ fontSize: '0.11rem', color: active ? THEME.accent : THEME.text, fontWeight: 700, textAlign: 'center', lineHeight: 1.2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${c.skinName}</span>
              ${hasModel ? html`<span style=${{ position: 'absolute', top: '0.04rem', left: '0.06rem', fontSize: '0.1rem' }} title="含战斗骨骼模型">⚔</span>` : null}
              ${active ? html`<span style=${{ position: 'absolute', top: '-0.07rem', right: '-0.05rem', width: '0.2rem', height: '0.2rem', borderRadius: '50%', background: THEME.accent, color: THEME.onAccent, fontSize: '0.12rem', lineHeight: '0.2rem', textAlign: 'center', fontWeight: 900 }}>✓</span>` : null}
            </button>`;
          })}
        </div>
        ${!mine.length ? html`<div style=${{ textAlign: 'center', padding: '0.24rem', color: THEME.dim2 }}>时装数据加载中，或该干员暂无时装</div>` : null}
      </div>
      <footer style=${{ padding: '0.08rem 0.14rem', borderTop: `1px solid ${THEME.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style=${{ color: THEME.dim2, fontSize: '0.11rem' }}>共 <b class="num" style=${{ color: THEME.md }}>${mine.length}</b> 套</span>
        <button type="button" onClick=${() => { audio.sfx('click', { volume: 0.4 }); onBrowseAll(); }} style=${{ padding: '0.04rem 0.1rem', background: 'transparent', border: `1px solid ${THEME.border2}`, color: THEME.accent, cursor: 'pointer', fontSize: '0.11rem', letterSpacing: '0.08em' }}>浏览全部时装 ›</button>
      </footer>
    </div>
  </div>`;
}

let costumes = [];
  let seriesList = [];
  let chessMap = {};
  let spineData = null;
  let selections = loadSelections();

  // 卸下（off）状态判定：本 MOD 被「卸下」时不应应用任何皮肤，且应清除已应用覆盖，
  // 让所有干员立刻回到原本皮肤。
  const MOD_ID = 'operatorskin';
  const isOff = () => { try { return !!modsOffMap()[MOD_ID]; } catch { return false; } };

  const applyAll = () => {
    if (isOff()) return; // 卸下时不应用任何皮肤
    const map = {};
    for (const c of costumes) if (selections[c.operator] === c.id) map[c.operator] = c;
    for (const costume of Object.values(map)) applyCostume(costume, chessMap, spineData);
  };

  // Try to grab chess data as soon as possible; if not ready, the initial apply will be a no-op and we rely on user action.
  try { chessMap = indexChess(data); } catch { /* ignore */ }

  // Re-apply when chess data eventually loads.
  try {
    const unsub = data?.subscribe?.((name) => { if (name === 'chess') { chessMap = indexChess(data); applyAll(); } });
    if (typeof unsub === 'function') window.addEventListener('beforeunload', unsub);
  } catch { /* ignore */ }

  // Battle spine data is optional: a failed/absent load only means board models keep the base look.
  fetch(SPINE_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((payload) => { spineData = payload && payload.chars ? payload : null; applyAll(); })
    .catch(() => { spineData = null; });

  fetch(DATA_URL)
    .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
    .then((payload) => {
      costumes = (payload?.costumes || []);
      seriesList = Array.from(new Set(costumes.map((c) => c.series))).sort();
      try { chessMap = indexChess(data); } catch { /* ignore */ }
      applyAll();
    })
    .catch((err) => { console.error('[operator-skin] failed to load costumes', err); });

  let galleryRoot = null;
  const closeGallery = () => {
    if (galleryRoot) { galleryRoot.remove(); galleryRoot = null; }
  };
  /** Costumes that carry a PRTS battle model for at least one matching charId. */
  const computeSpineKeys = () => {
    const spineKeys = new Set();
    if (spineData) {
      for (const c of costumes) {
        for (const [charId, rec] of Object.entries(chessMap)) {
          if (rec.name === c.operator && spineData.chars?.[charId]?.[c.skinName]) { spineKeys.add(`${c.operator}\u0000${c.skinName}`); break; }
        }
      }
    }
    return spineKeys;
  };
  const pickCostume = (c, after) => {
    const next = { ...selections };
    if (next[c.operator] === c.id) {
      delete next[c.operator];
      unapplyCostume(c.operator, chessMap);
    } else {
      next[c.operator] = c.id;
      // remove old override for this operator first to avoid stale charIds
      unapplyCostume(c.operator, chessMap);
      applyCostume(c, chessMap, spineData);
    }
    selections = next;
    saveSelections(next);
    if (typeof after === 'function') after();
    toast(`${c.operator} · ${c.skinName} ${next[c.operator] ? '已应用' : '已取消'}`, 'success');
  };
  const openGallery = () => {
    if (galleryRoot) return;
    if (!costumes.length) { toast('时装数据仍在加载中，请稍后再试', 'warn'); return; }
    try { chessMap = indexChess(data); } catch { /* ignore */ }
    galleryRoot = document.createElement('div');
    document.body.appendChild(galleryRoot);
    const render = () => {
      if (!galleryRoot) return;
      // NB: destructure as `draw` — destructuring `render` here would shadow this closure, and the gallery's
      // onPick would then hand preact's render() to pickCostume as its re-render hook (`after()` called with
      // no args → TypeError inside preact → no re-render, no toast: picking a costume "did nothing").
      import('../vendor/preact.module.js').then(({ render: draw, h }) => {
        draw(h(SkinGallery, {
          costumes,
          seriesList,
          selections,
          spineKeys: computeSpineKeys(),
          onPick: (c) => pickCostume(c, render),
          onClose: closeGallery,
        }), galleryRoot);
      });
    };
    render();
  };

  // ---- quick-swap panel: one operator, opened from the detail dialog header ------------------------------
  let panelRoot = null;
  let panelOperator = null;
  const closePanel = () => {
    if (panelRoot) { panelRoot.remove(); panelRoot = null; }
    panelOperator = null;
  };
  const openPanel = (chess) => {
    if (!chess?.name) return;
    if (!costumes.length) { toast('时装数据仍在加载中，请稍后再试', 'warn'); return; }
    try { chessMap = indexChess(data); } catch { /* ignore */ }
    if (panelRoot) { panelRoot.remove(); }
    panelOperator = chess.name;
    panelRoot = document.createElement('div');
    document.body.appendChild(panelRoot);
    const render = () => {
      if (!panelRoot) return;
      // NB: destructure as `draw` — `render` here would shadow this closure (see openGallery): onPick would pass
      // preact's render() to pickCostume, whose after() crashes preact and the panel never re-renders (the
      // "cancel back to the original skin" click looked dead — the state flipped but the panel stayed stale).
      import('../vendor/preact.module.js').then(({ render: draw, h }) => {
        draw(h(SkinPanel, {
          operator: panelOperator,
          costumes,
          selections,
          spineKeys: computeSpineKeys(),
          onPick: (c) => pickCostume(c, render),
          onClose: closePanel,
          onBrowseAll: () => { closePanel(); openGallery(); },
        }), panelRoot);
      });
    };
    render();
  };
  const togglePanel = (chess) => {
    if (panelRoot && panelOperator === chess?.name) closePanel();
    else openPanel(chess);
  };

  registerDetailAction({
    id: 'operatorskin-open',
    label: '时装',
    icon: 'shirt',
    title: '更换该干员的时装',
    onClick: (chess) => { audio.sfx('click', { volume: 0.4 }); togglePanel(chess); },
  });

  // 卸下 / 重新启用监听：卸下时装插件时清除全部皮肤覆盖，所有干员立即恢复原本皮肤；
  // 重新启用时再自动把已保存的选择重新应用（localStorage 选择保留，不丢失）。
  try {
    window.addEventListener(MODS_EVENT, () => {
      if (isOff()) clearSkinOverride(); // 无参 = 清除全部 charId 的皮肤覆盖
      else { try { chessMap = indexChess(data); } catch { /* ignore */ } applyAll(); }
    });
  } catch { /* ignore */ }

  return { id: 'operatorskin', name: '干员时装', version: '1.2.1', author: 'mod', description: '为干员更换时装：详情页即时预览，支持 520+ 套皮肤搜索与筛选；带 Spine 数据的皮肤局内模型同步生效。选择自动保存。' };
}

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'operatorskin';
