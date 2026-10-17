// 自定义表情包 插件（MOD）
// ─────────────────────────────────────────────────────────────────────────────
// 功能：
//   ① 管理：入口在**游戏本体的「设置」弹窗**里（一行「自定义表情包」→ 点「展开」在弹窗内直接管理），
//      添加本地图片（png / jpeg / webp / **gif**，gif 原样保留动画），最多 12 张；每格右上角两击确认删除；
//   ② 发送：对局内左下角「交流」面板的最后一页「自定义」——本体 ui/emotes.js 的扩展点，点击表情即广播
//      g.customEmote { data }（dataURL），与官方表情共用 1 秒冷却，发送后面板关闭；
//   ③ 展示：所有人（包括自己）在**官方头像气泡**里看到表情——服务端 m.customEmote 由本体 main.js 写进
//      store.emotes，官方 EmoteArt 直接渲染 data: URL，gif 会动。
//
// 实现说明（务必先看）：
//   - 图片以 base64 dataURL 随消息广播：shared/protocol.js isEmoteData 限 2.8M 字符（≈2.1MB 图片），
//     server/http/websocket.js 的帧上限相应为 4 MB。典型表情 GIF（0.5–2MB）直接可用，更大的 gif 拒绝并提示；
//     非 gif 图片超过 600k 字符（≈450KB）先自动缩到 128px 再编码，压不进 2.8M 再拒绝（128px 基本不可能）；
//   - 存储：IndexedDB（配额以百 MB 计）为主，localStorage（全源仅 ~5M 字符，几张就写爆）只作旧数据迁移
//     来源与降级写；两者都失败时表情仍可在本次会话内使用，重启浏览器后丢失；
//   - 服务端 server/match/match/intents.js customEmote：复用官方 emote 的 lastEmoteAt 冷却，防刷；
//   - 协议校验（validateC2S）在接入层，intents 里再自校验一次，直连 handle 也绕不过；
//   - 入口：本体 ui/settings.js 提供的 MOD 行扩展点（main.js 的 api.registerSettingsEntry）。卸下本 MOD 时该行
//     随之消失（与浮层同一套 off 规则）；

import { useState, useEffect, useRef } from 'preact/hooks';
import { loadPref, savePref } from '../js/store.js';
import { audio } from '../js/audio.js';

const PREF_KEY = 'customEmotePack';  // localStorage 键（旧版存储；仅作迁移来源 + 降级写）
const IDB_NAME = 'sp-emotepack';     // IndexedDB 库 / 表 / 键：本插件的持久存储
const IDB_STORE = 'pack';
const IDB_KEY = 'pack';
const MAX_EMOTES = 12;               // 表情包容量
const MAX_DATA_LEN = 2800000;        // 硬上限：与 shared/protocol.js 的 isEmoteData 一致（≈2.1MB 图片）
const SHRINK_ABOVE = 600000;         // 非 gif 图片超过此长度（≈450KB）先自动压缩再入包
const SEND_CD_MS = 1000;             // 与服务器 EMOTE_COOLDOWN_MS 一致的客户端预估冷却

/** Read a File as a data URL. */
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('读取文件失败'));
  r.readAsDataURL(file);
});

// ---- IndexedDB 持久存储（主存储；localStorage 配额太小，装不下几张 base64 表情） ----
// The connection is opened once and reused: a fresh indexedDB.open() per write costs enough that a write issued
// right before the tab closes (delete an emote, then reload) can still be in flight and lost.
let idbPromise = null;
function idbOpen() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error || new Error('IndexedDB 打开失败'));
    }).catch((e) => { idbPromise = null; throw e; }); // a failed open must not be cached
  }
  return idbPromise;
}
const idbGet = async (key) => {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result); // undefined ⇒ 从未写过；[] ⇒ 用户清空过（两者不可混淆）
    rq.onerror = () => reject(rq.error || new Error('IndexedDB 读取失败'));
  });
};
const idbPut = async (key, value) => {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
};

/**
 * Shrink an oversized still picture: canvas-scale it to ≤128px and re-encode (png first for transparency, then jpeg).
 * GIFs must be rejected by the caller — canvas re-encoding would kill the animation.
 */
function shrinkImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 128 / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round((img.width || 1) * scale));
      const h = Math.max(1, Math.round((img.height || 1) * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      let out = cv.toDataURL('image/png');
      if (out.length > MAX_DATA_LEN) out = cv.toDataURL('image/jpeg', 0.85);
      resolve(out);
    };
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = dataUrl;
  });
}

export default {
  name: '自定义表情包',
  version: '1.3.0',
  author: 'mod',
  description: '添加本地图片 / GIF 作为自定义表情（单张上限约 2MB）。管理入口在游戏本体「设置」弹窗；对局内在「交流」面板最后一页「自定义」直接点击发送，所有人在官方头像气泡里看到它（GIF 会动）。最多 12 张，与官方表情共用 1 秒冷却。',
  setup(api) {
    const { store, net, html, toast } = api;

    // ---- 主题令牌（只读变量，不发明新颜色） ----
    const T = {
      mint: 'var(--mint-400)', dim: 'var(--text-dim)', hi: 'var(--text-hi)', line: 'var(--line-2)', amber: 'var(--amber)',
    };

    const loadPack = () => {
      const v = loadPref(PREF_KEY, []);
      return Array.isArray(v) ? v.filter((e) => e && typeof e.data === 'string' && e.data.startsWith('data:image/')).slice(0, MAX_EMOTES) : [];
    };
    // 写两处：IndexedDB 永远写（主存储）；localStorage 也试着写（写爆配额会被 savePref 静默吞掉，无害——
    // IDB 才是恢复来源）。首次挂载时若 IDB 从未写过而 localStorage 有旧数据，则迁移进 IDB。
    // packCache 是给「交流」面板的自定义页用的同步快照（本体 registerCustomEmotes 的 provider 是同步调用）。
    let packCache = loadPack();
    const packLoaded = idbGet(IDB_KEY).then((saved) => {
      if (Array.isArray(saved)) {
        packCache = saved.filter((e) => e && typeof e.data === 'string' && e.data.startsWith('data:image/')).slice(0, MAX_EMOTES);
      } else if (packCache.length) {
        idbPut(IDB_KEY, packCache).catch((e) => console.warn('[emotepack] IDB 迁移失败', e));
      }
      return packCache;
    }).catch((e) => { console.warn('[emotepack] IDB 读取失败', e); return packCache; });
    const savePack = (pack) => {
      packCache = pack;
      idbPut(IDB_KEY, pack).catch((e) => console.warn('[emotepack] IDB 写入失败', e));
      savePref(PREF_KEY, pack);
    };

    // 对局内「交流」面板的最后一页（本体 ui/emotes.js 扩展点）：点这里的表情即发 g.customEmote
    api.registerCustomEmotes(() => packCache.map((e) => ({ id: e.data, name: e.name })));

    /** The panel shown inside the game's 设置 dialog (registered at the bottom of setup). */
    function EmotePackPanel() {
      const [pack, setPack] = useState(loadPack);
      const [armedDel, setArmedDel] = useState(null); // two-tap delete: emote id
      const [cooling, setCooling] = useState(false);
      const lastSent = useRef(-Infinity);
      const fileRef = useRef(null);
      const [, force] = useState(0);

      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);

      // 启动时以 IndexedDB 为准校正本地状态（与上方 setup 层的 packCache 共用同一次读取）
      useEffect(() => {
        let alive = true;
        packLoaded.then((p) => { if (alive) setPack(p); });
        return () => { alive = false; };
      }, []);

      // two-tap delete auto-disarms
      useEffect(() => {
        if (!armedDel) return undefined;
        const t = setTimeout(() => setArmedDel(null), 1800);
        return () => clearTimeout(t);
      }, [armedDel]);

      // the cooldown mirrors the server's chatCD, counted from the send so a remount keeps it
      useEffect(() => {
        if (!cooling) return undefined;
        const t = setTimeout(() => setCooling(false), Math.max(0, lastSent.current + SEND_CD_MS - Date.now()));
        return () => clearTimeout(t);
      }, [cooling]);

      const s = store.get();
      const pub = s.match && s.match.public;
      const inMatch = !!(pub && pub.phase && pub.phase !== 'LOBBY'); // 设置弹窗主页也能开：只有对局内才发送

      const addFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
        if (!files.length) { toast('仅支持 png / jpg / webp / gif 图片', 'error'); return; }
        const room = MAX_EMOTES - pack.length;
        if (room <= 0) { toast(`表情包已满（上限 ${MAX_EMOTES} 张）`, 'error'); return; }
        const accepted = [];
        for (const f of files.slice(0, room)) {
          try {
            let dataUrl = await readAsDataUrl(f);
            if (f.type !== 'image/gif' && dataUrl.length > SHRINK_ABOVE) {
              dataUrl = await shrinkImage(dataUrl);
              toast(`「${f.name}」已自动压缩后加入`, 'success');
            }
            if (dataUrl.length > MAX_DATA_LEN) {
              toast(`「${f.name}」超出单张上限（约 2MB），请压缩后再试`, 'error');
              continue;
            }
            accepted.push({ id: `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name: f.name, data: dataUrl });
          } catch (e) {
            toast(`「${f.name}」添加失败：${e && e.message ? e.message : '未知错误'}`, 'error');
          }
        }
        if (accepted.length) {
          const next = [...pack, ...accepted].slice(0, MAX_EMOTES);
          setPack(next);
          savePack(next);
          toast(`已添加 ${accepted.length} 张自定义表情`, 'success');
        }
        if (fileRef.current) fileRef.current.value = ''; // re-selecting the same file fires change again
      };

      const removeEmote = (id) => {
        const next = pack.filter((e) => e.id !== id);
        setPack(next);
        savePack(next);
        setArmedDel(null);
      };

      const send = async (emote) => {
        if (!inMatch) { toast('进入对局后才能发送表情（现在可以先添加）', 'error'); return; }
        if (cooling || Date.now() - lastSent.current < SEND_CD_MS) return;
        lastSent.current = Date.now();
        setCooling(true);
        audio.sfx('emote', { volume: 0.6 });
        try {
          await net.request('g.customEmote', { data: emote.data });
          // 面板保持展开：连发几张时不必重新点开
        } catch (e) {
          toast('发送失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        }
      };

      const cell = {
        position: 'relative', width: '.56rem', height: '.56rem', padding: '.04rem', cursor: 'pointer',
        border: `1px solid ${T.line}`, background: 'rgba(10, 13, 12, .6)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      };
      const delBtn = (armed) => ({
        position: 'absolute', top: 0, right: 0, width: '.18rem', height: '.18rem', lineHeight: 1,
        fontSize: '.12rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${armed ? T.amber : T.line}`, color: armed ? T.amber : T.dim,
        background: 'rgba(10, 13, 12, .8)', cursor: 'pointer', padding: 0,
      });

      const hint = {
        margin: '0 0 .08rem', fontSize: '.13rem', color: T.dim, lineHeight: 1.7,
      };
      const grid = { display: 'flex', flexWrap: 'wrap', gap: '.08rem' };
      const actions = { display: 'flex', alignItems: 'center', gap: '.1rem', marginTop: '.1rem' };

      return html`
        <div>
          <p style=${hint}>
            ${inMatch
    ? `点击表情即发送给所有人（官方头像气泡展示，GIF 会动）· 与「交流」共用 1 秒冷却 · ${pack.length}/${MAX_EMOTES} 张`
    : `进入对局后点击表情即可发送，现在可以先添加 · ${pack.length}/${MAX_EMOTES} 张`}
          </p>
          ${pack.length === 0 ? html`<p style=${hint}>还没有自定义表情，点下方「＋ 添加图片」（png / jpg / webp / gif）。</p>` : null}
          <div style=${grid}>
            ${pack.map((em) => html`
              <div key=${em.id} class="scard" role="button" tabIndex=${0}
                   onClick=${() => send(em)}
                   aria-label=${`发送 ${em.name}`} title=${`${em.name}${cooling ? '（冷却中…）' : ''}`}
                   style=${{ ...cell, opacity: cooling ? 0.45 : 1, cursor: cooling ? 'wait' : 'pointer' }}>
                <img src=${em.data} alt=${em.name} draggable=${false}
                     style=${{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                <span style=${delBtn(armedDel === em.id)}
                      onClick=${(e) => { e.stopPropagation(); if (armedDel === em.id) { audio.sfx('back', { volume: 0.5 }); removeEmote(em.id); } else { audio.sfx('click', { volume: 0.4 }); setArmedDel(em.id); } }}
                      title=${armedDel === em.id ? '再点一次确认删除' : '删除'}>
                  ${armedDel === em.id ? '✓' : '×'}
                </span>
              </div>`)}
          </div>
          <div style=${actions}>
            <input ref=${fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple
                   style=${{ display: 'none' }} onChange=${(e) => addFiles(e.target && e.target.files)} />
            <button class="btn btn--sm" style=${{ color: T.mint }}
                    onClick=${() => { audio.sfx('click', { volume: 0.4 }); fileRef.current && fileRef.current.click(); }}>＋ 添加图片</button>
          </div>
        </div>`;
    }

    // 入口挂在本体「设置」弹窗里（ui/settings.js 的 MOD 行扩展点）：主页与对局内都能打开
    api.registerSettingsEntry({
      id: 'customEmotePack',
      label: '自定义表情包',
      micro: 'EMOTES',
      Panel: EmotePackPanel,
    });
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'emotepack';
