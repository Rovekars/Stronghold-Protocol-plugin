// 赠送 / 求购 插件（MOD）
// ─────────────────────────────────────────────────────────────────────────────
// 两个功能（休整期 PREP）：
//   ① 赠送：每回合一次，把「整备区 / 临时整备区」中的一件干员或道具赠送给指定队友；
//      队友可选择接收或拒绝；队友卡槽（整备区）已满时无法赠送；每回合限一次。
//   ② 求购：资金不够时，可以请队友代付购买自己商店里的某件商品；棋子进自己的手牌
//      （走自己的池子 / 合成 / 购买效果），队友只出钱。队友可拒绝；AI 队友资金够时自动代付。
//
// 实现说明（务必先看）：
//   - 本插件只是客户端 UI + 网络层；真正的转账 / 购买由服务器完成（本项目对局状态由服务器权威模拟）。
//   - 赠送：g.gift / g.giftReply + m.giftOffer / m.giftResolved（server/match/player/gift.js）。
//   - 求购：g.buyReq / g.buyReqReply + m.buyReqOffer / m.buyReqResolved（server/match/player/buyreq.js）。
//   - 赠送在对方接收、求购在队友代付时，服务器才执行转账 / 购买并二次校验——拒绝、回合切换、
//     商店刷新都不会造成悬空或丢失。
//   - AI 队友没有客户端可以确认：赠送立即自动接收；求购在资金足够时立即自动代付。
//   - 启用 / 卸下由游戏本体的 MOD 管理负责：主页左下角「插件 MOD」面板中，每张 MOD 卡片旁有
//     「已启用 / 已卸下」开关（点击卡片可打开 MOD 管理弹窗）；卸下后对局内不渲染本插件的任何 UI。
//
// UI 说明：浮层渲染在应用 DOM 内，直接复用游戏本体的组件类（.btn / .modal / 主题变量），
// 字号与位置一律用游戏的 rem 标度（根字号随视口缩放），因此与本体 UI 同步缩放、风格一致。

import { useState, useEffect } from 'preact/hooks';
import { audio } from '../js/audio.js';

export default {
  name: '赠送 / 求购',
  version: '1.4.0',
  author: 'mod',
  description: '休整期可将自己的干员或道具赠送给队友（对方可拒收，每回合一次）；资金不够时可请队友代付购买商店商品（棋子进自己的手牌，队友只出钱）。可在主页「插件 MOD」面板卸下 / 启用。',
  setup(api) {
    const { store, net, data, html, toast, registerOverlay } = api;

    const nameOf = (kind, id) => {
      try {
        const rec = kind === 'item' ? data.lookup('items', id)
          : kind === 'token' ? data.lookup('tokens', id)
          : data.lookup('chess', id);
        return rec && rec.name ? rec.name : id;
      } catch { return id; }
    };
    const kindLabel = (kind) => (kind === 'chess' ? '干员' : kind === 'item' ? '道具' : kind === 'token' ? '召唤物' : kind);

    const snapshot = () => {
      const s = store.get();
      const me = s.me && s.me.playerId;
      const pub = s.match && s.match.public;
      const priv = s.match && s.match.private;
      const players = (pub && pub.players) || [];
      const peers = players.filter((p) => p.playerId && p.playerId !== me && p.alive)
        .map((p) => ({ playerId: p.playerId, name: p.name, isBot: !!p.isBot }));
      const hand = (priv && priv.hand) || [];
      const temp = (priv && priv.temp) || [];
      const pieces = [...hand, ...temp].filter(Boolean).map((p) => ({ ...p }));
      const shopSlots = ((priv && priv.shop && priv.shop.slots) || []).map((sl, idx) => (sl && !sl.sold ? { idx, ...sl } : null)).filter(Boolean);
      return {
        me, pub, priv, peers, pieces, shopSlots,
        phase: pub && pub.phase,
        round: pub && pub.round,
        inMatch: !!(pub && pub.phase && pub.phase !== 'LOBBY'),
        funds: (priv && priv.funds) || 0,
        giftsUsed: (priv && priv.giftsThisRound) || 0,
        buyReqPending: !!(priv && priv.buyReqPending),
      };
    };

    // ---- 主题令牌（与 game 本体 theme.css 同源；只读变量，不发明新颜色） ----
    const T = {
      line: 'var(--line-2)', mint: 'var(--mint-400)', mintDeep: 'var(--mint-500)',
      dim: 'var(--text-dim)', lo: 'var(--text-lo)', hi: 'var(--text-hi)', amber: 'var(--amber)',
      chipBg: 'rgba(10, 13, 12, .6)',
    };

    function GiftOverlay() {
      const [open, setOpen] = useState(false);
      const [mode, setMode] = useState('gift'); // 'gift' | 'buy'
      const [selPiece, setSelPiece] = useState(null);
      const [selSlot, setSelSlot] = useState(null);
      const [selPeer, setSelPeer] = useState(null);
      const [pending, setPending] = useState(null); // incoming gift offer
      const [pendingBuy, setPendingBuy] = useState(null); // incoming buy request
      const [, force] = useState(0);

      // re-render on any store change (hand / peers / shop / round / funds)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);

      // incoming offers (we are the recipient) + resolutions (we are either side)
      useEffect(() => {
        const me = store.get().me && store.get().me.playerId;
        const onOffer = (m) => {
          setPending({ from: m.from, fromName: m.fromName, uid: m.uid, kind: m.kind, id: m.id, name: m.name });
          toast(`收到 ${m.fromName} 的赠送：${m.name}`, 'info');
        };
        const onResolved = (m) => {
          if (m.from === me) {
            toast(m.accepted ? `队友已接收你的 ${m.name}` : `队友拒绝了你的 ${m.name}`, m.accepted ? 'success' : 'warn');
            setOpen(false); setSelPiece(null); setSelPeer(null);
          } else if (m.to === me) {
            toast(m.accepted ? `你已接收 ${m.name}` : `你拒绝了 ${m.name}`, m.accepted ? 'success' : 'warn');
            setPending(null);
          }
        };
        const onBuyReq = (m) => {
          setPendingBuy({ from: m.from, fromName: m.fromName, kind: m.kind, id: m.id, name: m.name, price: m.price });
          toast(`${m.fromName} 请求你代购：${m.name}`, 'info');
        };
        const onBuyResolved = (m) => {
          if (m.from === me) {
            toast(m.accepted ? `队友已为你代购 ${m.name}` : '队友拒绝了你的代购请求', m.accepted ? 'success' : 'warn');
            setOpen(false); setSelSlot(null); setSelPeer(null);
          } else if (m.to === me) {
            toast(m.accepted ? `你已为对方代购 ${m.name}` : `你拒绝了代购请求`, m.accepted ? 'success' : 'warn');
            setPendingBuy(null);
          }
        };
        net.on('m.giftOffer', onOffer);
        net.on('m.giftResolved', onResolved);
        net.on('m.buyReqOffer', onBuyReq);
        net.on('m.buyReqResolved', onBuyResolved);
        return () => {
          net.off('m.giftOffer', onOffer); net.off('m.giftResolved', onResolved);
          net.off('m.buyReqOffer', onBuyReq); net.off('m.buyReqResolved', onBuyResolved);
        };
      }, []);

      const s = snapshot();
      if (!s.inMatch) return null; // 主页不渲染（启停由本体「插件 MOD」面板的 MOD 管理负责）

      const canOpen = s.phase === 'PREP';
      const switchMode = (m) => { setMode(m); setSelPiece(null); setSelSlot(null); setSelPeer(null); };

      const sendGift = async () => {
        if (!selPiece || !selPeer) return;
        try {
          await net.request('g.gift', { uid: selPiece.uid, to: selPeer.playerId });
          toast('已发送赠送请求，等待队友确认', 'info');
          setOpen(false); setSelPiece(null); setSelPeer(null);
        } catch (e) {
          toast('赠送失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        }
      };
      const sendBuyReq = async () => {
        if (!selSlot || !selPeer) return;
        try {
          await net.request('g.buyReq', { slot: selSlot.idx, to: selPeer.playerId });
          toast(`已向 ${selPeer.name} 发送代购请求`, 'info');
          setOpen(false); setSelSlot(null); setSelPeer(null);
        } catch (e) {
          toast('代购请求失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        }
      };

      const acceptGift = async () => { try { await net.request('g.giftReply', { accept: true }); } catch (e) { toast('接收失败：' + (e && e.message ? e.message : ''), 'error'); } };
      const rejectGift = async () => {
        try { await net.request('g.giftReply', { accept: false }); } catch (e) { /* ignore */ }
        setPending(null);
      };
      const acceptBuy = async () => { try { await net.request('g.buyReqReply', { accept: true }); } catch (e) { toast('代购失败：' + (e && e.message ? e.message : ''), 'error'); } };
      const rejectBuy = async () => {
        try { await net.request('g.buyReqReply', { accept: false }); } catch (e) { /* ignore */ }
        setPendingBuy(null);
      };

      // 选中态芯片：暗底 + 细边框，选中时薄荷色描边（游戏 is-active 的做法）
      const chip = (on) => ({
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.08rem',
        padding: '.08rem .1rem', marginBottom: '.06rem', cursor: 'pointer', fontSize: '.16rem',
        lineHeight: 1.35, border: `1px solid ${on ? T.mintDeep : T.line}`, background: T.chipBg,
        color: on ? T.hi : 'var(--text-md)', boxShadow: on ? 'inset 0 0 0 1px rgba(78, 216, 175, .35)' : 'none',
        textAlign: 'left', width: '100%',
      });
      const tag = {
        flex: 'none', fontSize: '.12rem', letterSpacing: '.04em', color: T.dim,
        border: `1px solid ${T.line}`, padding: '.01rem .06rem', whiteSpace: 'nowrap',
      };
      const colTitle = {
        margin: '0 0 .08rem', fontSize: '.12rem', letterSpacing: '.14em',
        color: T.dim, textTransform: 'uppercase',
      };
      const tabBtn = (on) => ({ flex: '1', textAlign: 'center' });
      const empty = { color: T.dim, fontSize: '.14rem', margin: '0' };

      return html`
        ${canOpen ? html`
          <button class="btn btn--sm" style=${{ position: 'fixed', left: '.12rem', bottom: '.9rem', zIndex: 50 }}
                  onClick=${() => { audio.sfx('click', { volume: 0.4 }); setOpen(true); }}>
            <span class="btn__label" style=${{ color: T.mint }}>🎁 赠送 / 求购</span>
          </button>` : null}

        ${open ? html`
          <div class="modal" onClick=${() => { audio.sfx('back', { volume: 0.5 }); setOpen(false); }}>
            <div class="modal__box" style=${{ width: 'min(7.2rem, 94vw)' }} onClick=${(e) => e.stopPropagation()}>
              <div class="modal__stripe"></div>
              <div class="modal__head">
                <div class="modal__title">赠送 / 求购</div>
                <div style=${{ fontSize: '.13rem', color: T.dim }}>${
                  mode === 'gift'
                    ? '选择一件手牌与一位队友；对方确认后才会转移。'
                    : '选择商店中的一件商品与一位队友；对方代付后商品进入你的手牌。'
                }</div>
                <div style=${{ display: 'flex', gap: '.06rem', marginTop: '.08rem' }}>
                  <button class=${mode === 'gift' ? 'btn btn--sm is-active' : 'btn btn--sm'} style=${tabBtn(mode === 'gift')}
                          onClick=${() => { audio.sfx('tab', { volume: 0.5 }); switchMode('gift'); }}><span class="btn__label">赠送</span></button>
                  <button class=${mode === 'buy' ? 'btn btn--sm is-active' : 'btn btn--sm'} style=${tabBtn(mode === 'buy')}
                          onClick=${() => { audio.sfx('tab', { volume: 0.5 }); switchMode('buy'); }}><span class="btn__label">求购</span></button>
                </div>
              </div>
              <div class="modal__body">
                ${mode === 'gift' ? html`
                  <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.16rem' }}>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>我的手牌 · 点击选择</p>
                      ${s.pieces.length === 0 ? html`<p style=${empty}>整备区为空，无可赠送的棋子。</p>` : null}
                      ${s.pieces.map((p) => html`
                        <button class=${selPiece && selPiece.uid === p.uid ? 'btn is-active' : 'btn'}
                                style=${chip(selPiece && selPiece.uid === p.uid)}
                                onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelPiece(selPiece && selPiece.uid === p.uid ? null : p); }}>
                          <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            ${nameOf(p.kind, p.id)}${p.golden ? ' ★' : ''}
                          </span>
                          <span style=${tag}>${kindLabel(p.kind)}${p.tier ? ' T' + p.tier : ''}</span>
                        </button>`)}
                    </div>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>送给哪位队友</p>
                      ${s.peers.length === 0 ? html`<p style=${empty}>当前没有可赠送的队友。</p>` : null}
                      ${s.peers.map((p) => html`
                        <button class=${selPeer && selPeer.playerId === p.playerId ? 'btn is-active' : 'btn'}
                                style=${chip(selPeer && selPeer.playerId === p.playerId)}
                                onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelPeer(selPeer && selPeer.playerId === p.playerId ? null : p); }}>
                          <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${p.name}</span>
                          <span style=${tag}>${p.isBot ? 'AI · 自动接收' : '队友'}</span>
                        </button>`)}
                    </div>
                  </div>` : html`
                  <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.16rem' }}>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>我的商店 · 选择要代购的商品</p>
                      ${s.shopSlots.length === 0 ? html`<p style=${empty}>商店中没有可购买的商品。</p>` : null}
                      ${s.shopSlots.map((sl) => {
                        const on = selSlot && selSlot.idx === sl.idx;
                        const afford = s.funds >= sl.price;
                        return html`
                          <button class=${on ? 'btn is-active' : 'btn'} style=${chip(on)}
                                  onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelSlot(on ? null : sl); }}>
                            <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              ${nameOf(sl.kind, sl.id)}${sl.frozen ? ' ❄' : ''}
                            </span>
                            <span style=${{ ...tag, ...(afford ? {} : { color: T.amber, borderColor: T.amber }) }}>
                              ${kindLabel(sl.kind)} · ${sl.price}
                            </span>
                          </button>`;
                      })}
                    </div>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>请哪位队友代付</p>
                      ${s.peers.length === 0 ? html`<p style=${empty}>当前没有可求助的队友。</p>` : null}
                      ${s.peers.map((p) => html`
                        <button class=${selPeer && selPeer.playerId === p.playerId ? 'btn is-active' : 'btn'}
                                style=${chip(selPeer && selPeer.playerId === p.playerId)}
                                onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelPeer(selPeer && selPeer.playerId === p.playerId ? null : p); }}>
                          <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${p.name}</span>
                          <span style=${tag}>${p.isBot ? 'AI · 资金够即代付' : '队友'}</span>
                        </button>`)}
                    </div>
                  </div>`}
              </div>
              <div class="modal__actions">
                <span style=${{ marginRight: 'auto', fontSize: '.13rem', color: T.dim }}>${
                  mode === 'gift'
                    ? (s.giftsUsed >= 1 ? '本回合已赠送（1/1）' : '每回合限一次 · 仅休整期')
                    : (s.buyReqPending ? '等待队友处理你的代购请求…' : '代付后商品进入你的手牌 · 仅休整期')
                }</span>
                <button class="btn btn--sm" onClick=${() => { audio.sfx('back', { volume: 0.5 }); setOpen(false); }}>关闭</button>
                ${mode === 'gift'
                  ? html`<button class="btn btn--primary btn--sm" disabled=${!selPiece || !selPeer || s.giftsUsed >= 1} onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); sendGift(); }}>确认赠送</button>`
                  : html`<button class="btn btn--primary btn--sm" disabled=${!selSlot || !selPeer || s.buyReqPending} onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); sendBuyReq(); }}>请求代购</button>`}
              </div>
            </div>
          </div>` : null}

        ${pending ? html`
          <div class="modal">
            <div class="modal__box" style=${{ width: 'min(4.2rem, 92vw)' }}>
              <div class="modal__stripe"></div>
              <div class="modal__head">
                <div class="modal__title">收到一份赠送</div>
              </div>
              <div class="modal__body">
                <p class="modal__text" style=${{ margin: '0', textAlign: 'center' }}>
                  <b style=${{ color: T.hi }}>${pending.fromName}</b> 想赠送你<br/>
                  <b style=${{ color: T.mint }}>${pending.name}</b>
                  <span style=${{ color: T.dim }}>（${kindLabel(pending.kind)}）</span>
                </p>
              </div>
              <div class="modal__actions" style=${{ justifyContent: 'center' }}>
                <button class="btn btn--primary btn--sm" onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); acceptGift(); }}>接收</button>
                <button class="btn btn--sm" onClick=${() => { audio.sfx('back', { volume: 0.5 }); rejectGift(); }}>拒绝</button>
              </div>
            </div>
          </div>` : null}

        ${pendingBuy ? html`
          <div class="modal">
            <div class="modal__box" style=${{ width: 'min(4.6rem, 92vw)' }}>
              <div class="modal__stripe"></div>
              <div class="modal__head">
                <div class="modal__title">代购请求</div>
              </div>
              <div class="modal__body">
                <p class="modal__text" style=${{ margin: '0', textAlign: 'center' }}>
                  <b style=${{ color: T.hi }}>${pendingBuy.fromName}</b> 资金不足，想请你代购<br/>
                  <b style=${{ color: T.mint }}>${pendingBuy.name}</b>
                  <span style=${{ color: T.dim }}>（${kindLabel(pendingBuy.kind)} · 价格 ${pendingBuy.price}）</span><br/>
                  <span style=${{ color: T.dim, fontSize: '.13rem' }}>商品将进入对方的手牌，由你支付费用。</span>
                </p>
              </div>
              <div class="modal__actions" style=${{ justifyContent: 'center' }}>
                <button class="btn btn--primary btn--sm" onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); acceptBuy(); }}>代付 ${pendingBuy.price}</button>
                <button class="btn btn--sm" onClick=${() => { audio.sfx('back', { volume: 0.5 }); rejectBuy(); }}>拒绝</button>
              </div>
            </div>
          </div>` : null}
      `;
    }

    registerOverlay(GiftOverlay);
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'gift';
