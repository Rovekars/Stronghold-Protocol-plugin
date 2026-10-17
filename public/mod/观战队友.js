// 我抢！ 插件（MOD）
// ─────────────────────────────────────────────────────────────────────────────
// 功能（休整期 PREP）：
//   ① 原生观战链路：用本体左侧成员卡片的「前往查看」走到队友阵地时，底部会以**本体商店
//      的原样 UI**（同一套卡片组件：干员卡 / 道具卡 / SOLD OUT）显示队友的商店——等级、
//      商品、价格、冻结、已售状态一目了然；
//   ② 代买：点击商品（两击确认，和本体商店一致）即可购买队友商店里的商品——钱从你的资金
//      扣，商品进你的手牌（走你自己的合成 / 购买效果），队友只是失去那个商店槽位。
//   ③ 自选（DIY）干员是队友的个人库存，不对外出售。
//
// 实现说明（务必先看）：
//   - 本插件只是客户端 UI + 网络层；商店数据与购买由服务器完成（本项目对局状态由服务器权威模拟）。
//   - 观战：g.peerShop → 服务器推送 m.peerShop 商店快照（server/match/player/peershop.js）。
//   - 购买：g.peerBuy，服务器在买家身上执行完整购买校验（资金 / 手牌 / 卡池），主人商店标记 sold。
//   - 「前往查看」的观战目标由本体 game.js 同步到 store.ui.watching（playerId 或 null）；
//     插件监听它，进入观战即拉取商店快照，返回自己 / 开战即收起商店栏。
//   - 商店栏复用本体 public/js/ui/shopBar.js 的 ChessCard / ItemCard / SoldCard 组件——浏览器里
//     import map 把 preact 全部指向 vendor 同一实例，插件与本体组件共享同一个渲染器，可直接混用。
//   - 卡片 priv 传 null：合成进度点 / 技能调配是主人（或我）的私有数据，服务器不下发，显示中性卡。
//   - 启用 / 卸下由游戏本体的 MOD 管理负责：主页左下角「插件 MOD」面板；卸下后不渲染本插件的任何 UI。

import { useState, useEffect, useRef } from 'preact/hooks';
import { ChessCard, ItemCard, SoldCard } from '../js/ui/shopBar.js';

export default {
  name: '我抢！',
  version: '1.2.1',
  author: 'mod',
  description: '休整期观战队友时，可代买其商店商品：钱从你账户扣，商品进你的手牌。',
  setup(api) {
    const { store, net, data, html, toast, registerOverlay } = api;

    const snapshot = () => {
      const s = store.get();
      const me = s.me && s.me.playerId;
      const pub = s.match && s.match.public;
      const priv = s.match && s.match.private;
      const players = (pub && pub.players) || [];
      const peers = players.filter((p) => p.playerId && p.playerId !== me && p.alive)
        .map((p) => ({ playerId: p.playerId, name: p.name, isBot: !!p.isBot }));
      const hand = (priv && priv.hand) || [];
      const handFree = hand.filter((x) => x == null).length;
      return {
        me, peers, priv,
        phase: pub && pub.phase,
        inMatch: !!(pub && pub.phase && pub.phase !== 'LOBBY'),
        funds: (priv && priv.funds) || 0,
        handFree,
        watching: (s.ui && s.ui.watching) || null,
      };
    };

    function PeerShopOverlay() {
      const [shop, setShop] = useState(null); // last m.peerShop snapshot
      const [armed, setArmed] = useState(null); // two-tap: armed card key
      const [busy, setBusy] = useState(false);
      const watchRef = useRef(null); // the peer whose shop we display (guards stale snapshots)
      const [, force] = useState(0);

      const s0 = snapshot();
      const watchPid = s0.watching; // 观战目标只来自本体「前往查看」（game.js 同步到 store.ui.watching）

      // re-render on any store change (watching / phase / funds / hand)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);

      // the shop snapshot pushed by the server in reply to g.peerShop
      useEffect(() => {
        const onShop = (m) => {
          const w = watchRef.current;
          if (!w || m.from !== w) return;
          setShop(m);
        };
        net.on('m.peerShop', onShop);
        return () => { net.off('m.peerShop', onShop); };
      }, []);

      // a stale watching id from an earlier match must not leak into a new one
      useEffect(() => {
        if (!s0.inMatch && s0.watching) { store.patch('ui', { watching: null }); }
      }, [s0.inMatch]);

      // entering a watch (or the phase turning PREP) pulls a fresh snapshot; leaving it clears the bar
      useEffect(() => {
        watchRef.current = watchPid || null;
        setShop(null);
        setArmed(null);
        if (watchPid && s0.phase === 'PREP') {
          net.request('g.peerShop', { to: watchPid }).catch(() => {});
        }
      }, [watchPid, s0.phase === 'PREP']);

      const buy = async (idx) => {
        if (!watchPid) return;
        setArmed(null);
        setBusy(true);
        try {
          await net.request('g.peerBuy', { slot: idx, to: watchPid });
          toast('已购买队友商店的商品', 'success');
        } catch (e) {
          toast('购买失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        } finally {
          setBusy(false);
          // 购买后拉一份新快照，把已售槽位刷掉
          if (watchRef.current) net.request('g.peerShop', { to: watchRef.current }).catch(() => {});
        }
      };

      const s = snapshot();
      if (!s.inMatch) return null; // 主页不渲染（启停由本体「插件 MOD」面板的 MOD 管理负责）

      const isPrep = s.phase === 'PREP';
      const showBar = isPrep && !!watchPid;
      const peersOfShop = shop && s.peers.find((p) => p.playerId === shop.from);
      const shopName = shop ? (peersOfShop ? peersOfShop.name : shop.name) : null;

      // two-tap like the own shop: a tap outside a card disarms (Escape too)
      useEffect(() => {
        if (!armed) return undefined;
        const onDown = (e) => { if (e.target && e.target.closest && !e.target.closest('.scard')) setArmed(null); };
        const onKey = (e) => { if (e.key === 'Escape') setArmed(null); };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
      }, [armed]);

      /** The reason a card cannot be bought right now (mirrors the server's checks), null when it can. */
      const reasonOf = (sl) => {
        if (!sl) return null;
        if (data.lookup && sl.kind === 'chess') {
          const rec = data.lookup('chess', sl.id);
          if (rec && rec.isDiy) return '自选干员不对外出售';
        }
        if (s.handFree <= 0) return '整备区已满，无法购入';
        if (s.funds < sl.price) return '资金不足';
        return null;
      };
      const tapCard = (kind, idx, sl, reason) => {
        const key = `${kind}:${idx}:${sl.id}`;
        if (armed !== key) { setArmed(key); return; }
        if (reason || busy) { setArmed(null); return; }
        buy(idx);
      };

      const slots = (shop && shop.slots) || [];

      return html`
        ${showBar ? html`
          <section class=${`shopbar${shop ? '' : ' is-locked'}`}
                   style=${{ position: 'fixed', right: '.26rem', bottom: '.2rem', zIndex: 40 }}
                   aria-label="观战 · 队友商店">
            <div class="shopbar__tools">
              <span class="shopbar__remain" style=${{ pointerEvents: 'auto' }}>
                👁 ${shopName || '…'} 的商店${shop ? html` · LV <b class="num">${shop.level}</b>` : ''}
              </span>
            </div>
            <div class="shopbar__row">
              <div class="shopbar__cards">
                ${shop ? slots.map((sl, i) => (sl && sl.kind !== 'item' ? (sl.sold ? html`<${SoldCard} key=${`s${i}`} />` : (() => {
                  const reason = reasonOf(sl);
                  const key = `c:${i}:${sl.id}`;
                  return html`<${ChessCard} key=${key} slot=${sl} idx=${i} priv=${null} frozen=${sl.frozen}
                    reason=${reason} armed=${armed === key} onTap=${(idx) => tapCard('c', idx, sl, reason)}
                    onBuy=${() => {}} onDetail=${() => {}} />`;
                })()) : html`<${SoldCard} key=${`s${i}`} />`)) : null}
              </div>
              <div class="shopbar__item">
                ${shop ? (() => {
                  const items = slots.map((sl, i) => ({ sl, i })).filter(({ sl }) => sl && sl.kind === 'item');
                  if (!items.length) return html`<${SoldCard} item=${true} />`;
                  return items.map(({ sl, i }) => (sl.sold ? html`<${SoldCard} key=${`i${i}`} item=${true} />` : (() => {
                    const reason = reasonOf(sl);
                    const key = `i:${i}:${sl.id}`;
                    return html`<${ItemCard} key=${key} slot=${sl} idx=${i} frozen=${sl.frozen}
                      reason=${reason} armed=${armed === key} onTap=${(idx) => tapCard('i', idx, sl, reason)}
                      onBuy=${() => {}} onDetail=${() => {}} />`;
                  })()));
                })() : null}
              </div>
              <div class="funds">
                <div class="funds__hex"><b class="funds__num num">${s.funds}</b></div>
                <span class="funds__label">我的资金</span>
              </div>
            </div>
          </section>` : null}
      `;
    }

    registerOverlay(PeerShopOverlay);
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'peershop';
