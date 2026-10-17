// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始, the language menu
// (中文 | English | every pack in public/i18n/, ui/lang.js; a title in an alphabetic script — English — is the big one and
// the small wordmark above it hides).
//
// Pressing 开始 validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.

import { useMemo, useState, useRef, useEffect } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION, DEV_BUILD } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill, Modal } from '../ui/components.js';
import { audio } from '../audio.js';
import { GuideButton } from '../ui/guide.js';
import { toast } from '../ui/toasts.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, detectFeatures } from '../ui/device.js';
import { LangToggle, useLang } from '../ui/lang.js';
import { t, N_ } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { GIcon } from '../ui/gameComponents.js';
import { SettingsModal } from '../ui/settings.js';
import { modsOffMap, setModOff, onModsChanged, addModsFromFiles, removeUserMod, isPackOff, setPackOff } from '../ui/mods.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: N_('准备连接'), connecting: N_('正在连接服务器'), connected: N_('已连接服务器'), handshaking: N_('正在验证身份'),
  online: N_('已连接服务器'), reconnecting: N_('连接中断，正在重连'), closed: N_('连接已关闭'),
};

/**
 * Plugin / MOD panel on the title screen: lists every plugin the loader discovered in
 * public/mod/ (plus locally added ones) with a per-MOD 启用/卸下 toggle; clicking a MOD opens
 * the MOD manager (ModsModal) to inspect details and add / remove local MODs. Reads the store's
 * `ui.plugins` array that main.js's loadPlugins() populates.
 */
/** Reactive view of the per-MOD unload map (ui/mods.js). @returns {Record<string, boolean>} */
function useModsOff() {
  const [map, setMap] = useState(modsOffMap);
  useEffect(() => onModsChanged(() => setMap({ ...modsOffMap() })), []);
  return map;
}

/**
 * Enable / 卸下 a MOD. Enabling a MOD that declared `conflicts` also unloads the conflicting ones (ui/mods.js
 * returns them) — they cannot run at the same time, and the player is told which ones were switched off.
 * @param {string} id @param {boolean} off @param {Array<{id?: string, file?: string, name?: string}>} plugins
 */
function toggleMod(id, off, plugins) {
  const autoOff = setModOff(id, off) || [];
  if (!autoOff.length) return;
  const nameOf = (mid) => {
    const p = (plugins || []).find((x) => (x.id || x.file) === mid);
    return p && p.name ? p.name : mid;
  };
  const names = autoOff.map(nameOf).join('、');
  toast(t('已自动卸下「{NAMES}」：与「{NAME}」不能同时启用', { NAMES: names, NAME: nameOf(id) }), 'warn');
}

export function PluginPanel() {
  const plugins = useStore((s) => s.ui.plugins) || [];
  const packs = useStore((s) => s.ui.packs) || [];
  const off = useModsOff();
  const [open, setOpen] = useState(false);
  const [mgrOpen, setMgrOpen] = useState(false);
  const standalone = plugins.filter((p) => !p.pack);
  const count = standalone.length;
  const offCount = standalone.filter((p) => off[p.id || p.file]).length;
  return html`<div class=${`plugin-panel${open ? ' is-open' : ''}`}>
    <button type="button" class="plugin-panel__head" onClick=${() => { audio.sfx('click', { volume: 0.4 }); setOpen((o) => !o); }}>
      <${Icon} name="robot" />
      <span class="plugin-panel__label">${t('插件 MOD')}</span>
      <span class="plugin-panel__count">${count}</span>
      ${packs.length ? html`<span class="plugin-panel__count plugin-panel__count--pack" title=${t('整合包')}>${packs.length}</span>` : null}
      <${Icon} name=${open ? 'collapse' : 'expand'} class="plugin-panel__chev" />
    </button>
    ${open ? html`<div class="plugin-panel__body">
      ${(standalone.length === 0 && packs.length === 0)
        ? html`<p class="plugin-panel__empty">${t('未检测到插件。将 .js 插件文件放入 public/mod/ 后刷新本页即可加载，或在 MOD 管理中从本地添加。')}</p>`
        : html`${standalone.map((p) => renderPluginCard(p, off, plugins, () => setMgrOpen(true)))}
            ${packs.map((pk) => renderPackGroup(pk, plugins))}`}
      <p class="plugin-panel__foot">${t('点击 MOD 卡片可打开 MOD 管理 · {OFF}/{COUNT} 已卸下', { OFF: offCount, COUNT: count })}</p>
    </div>` : null}
    <${ModsModal} open=${mgrOpen} onClose=${() => setMgrOpen(false)} />
  </div>`;
}

/** A single standalone MOD card in the title-screen plugin panel. */
function renderPluginCard(p, off, plugins, onOpenMgr) {
  const id = p.id || p.file;
  const isOff = !!off[id];
  return html`<div class=${`plugin-card${isOff ? ' is-off' : ''}`} key=${id}
      title=${t('点击打开 MOD 管理')} onClick=${() => { audio.sfx('click', { volume: 0.4 }); onOpenMgr(); }}>
    <div class="plugin-card__top">
      <span class="plugin-card__name">${p.name || id}</span>
      <span class="plugin-card__ops">
        ${p.user ? html`<span class="plugin-card__badge">${t('本地')}</span>` : null}
        ${p.version ? html`<span class="plugin-card__ver">v${p.version}</span>` : null}
        <button type="button" class=${`plugin-card__toggle${isOff ? ' is-off' : ''}`}
          title=${isOff ? t('已卸下：对局内不显示该 MOD 的界面，点击重新启用') : t('已启用，点击卸下（对局内不再显示）')}
          onClick=${(e) => { e.stopPropagation(); audio.sfx('click', { volume: 0.4 }); toggleMod(id, !isOff, plugins); }}>
          ${isOff ? t('已卸下') : t('已启用')}
        </button>
      </span>
    </div>
    ${p.author ? html`<div class="plugin-card__author">by ${p.author}</div>` : null}
    ${p.description ? html`<div class="plugin-card__desc">${p.description}</div>` : null}
    ${p.error ? html`<div class="plugin-card__err">⚠ ${t('加载失败')}：${p.error}</div>` : null}
  </div>`;
}

/** A 整合包 (integration pack) rendered as one collapsible group with a single master toggle. */
function renderPackGroup(pk, plugins) {
  const isOff = isPackOff(pk.id);
  const members = plugins.filter((p) => p.pack === pk.id);
  const toggle = (e) => {
    e.stopPropagation();
    audio.sfx('click', { volume: 0.4 });
    const next = !isPackOff(pk.id);
    setPackOff(pk.id, next);
    toast(next ? t('已开启整合包「{NAME}」，旗下 {N} 个 MOD 一并启用', { NAME: pk.name || pk.id, N: members.length })
      : t('已关闭整合包「{NAME}」，旗下 {N} 个 MOD 一并卸下', { NAME: pk.name || pk.id, N: members.length }), next ? 'success' : 'info');
  };
  return html`<div class=${`plugin-pack${isOff ? ' is-off' : ''}`} key=${pk.id}>
    <div class="plugin-pack__head">
      <${Icon} name="robot" />
      <span class="plugin-card__name">${pk.name || pk.id}</span>
      <span class="plugin-card__badge">${t('整合包')}</span>
      ${pk.version ? html`<span class="plugin-card__ver">v${pk.version}</span>` : null}
      <span class="plugin-pack__count">${t('内含 {N} 个 MOD', { N: members.length })}</span>
      <button type="button" class=${`plugin-card__toggle${isOff ? ' is-off' : ''}`}
        title=${isOff ? t('已卸下：包内全部 MOD 一并卸下') : t('已启用：包内全部 MOD 一并启用')}
        onClick=${toggle}>${isOff ? t('已卸下') : t('已启用')}</button>
    </div>
    ${pk.author ? html`<div class="plugin-card__author">by ${pk.author}</div>` : null}
    ${pk.description ? html`<div class="plugin-card__desc">${pk.description}</div>` : null}
    <div class="plugin-pack__members">
      ${members.map((m) => html`<div class="plugin-pack__member" key=${m.id || m.file}>
        <span class="plugin-pack__mname">${m.name || m.id}</span>
        ${m.error ? html`<span class="plugin-card__err">⚠ ${t('加载失败')}：${m.error}</span>` : null}
      </div>`)}
    </div>
  </div>`;
}

/** MOD manager: every discovered MOD (and 整合包) with details and an 启用/卸下 switch, plus local-MOD add / remove. */
export function ModsModal({ open, onClose }) {
  const plugins = useStore((s) => s.ui.plugins) || [];
  const packs = useStore((s) => s.ui.packs) || [];
  const off = useModsOff();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const standalone = plugins.filter((p) => !p.pack);
  const addFiles = async (fileList) => {
    const files = [...(fileList || [])].filter((f) => /\.js$/i.test(f.name));
    if (!files.length) return;
    setBusy(true);
    try {
      const n = await addModsFromFiles(files);
      if (n) {
        toast(t('已添加 {N} 个本地 MOD，正在刷新页面生效…', { N: n }), 'success');
        setTimeout(() => location.reload(), 900);
      } else toast(t('未选择 .js 文件'), 'warn');
    } catch (err) {
      toast(String((err && err.message) || err), 'error');
      setBusy(false);
    }
  };
  const removeLocal = (id) => {
    removeUserMod(id);
    toast(t('已移除该本地 MOD，正在刷新页面生效…'), 'info');
    setTimeout(() => location.reload(), 900);
  };
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('MOD 管理')} micro="MODS" width="7.6rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${() => { audio.sfx('back', { volume: 0.5 }); onClose(); }}>${t('完成')}<//>`}>
    <div class="mod-mgr">
      ${(standalone.length === 0 && packs.length === 0) ? html`<p class="plugin-panel__empty">${t('未检测到插件。')}</p>` : null}
      ${standalone.map((p) => {
        const id = p.id || p.file;
        const isOff = !!off[id];
        return html`<div class=${`mod-mgr__row${isOff ? ' is-off' : ''}`} key=${id}>
          <div class="mod-mgr__info">
            <div class="plugin-card__top">
              <span class="plugin-card__name">${p.name || id}</span>
              ${p.user ? html`<span class="plugin-card__badge">${t('本地添加')}</span>` : null}
              ${p.version ? html`<span class="plugin-card__ver">v${p.version}</span>` : null}
              ${p.file && p.file !== '(本地添加)' ? html`<span class="plugin-card__file">${p.file}</span>` : null}
            </div>
            ${p.author ? html`<div class="plugin-card__author">by ${p.author}</div>` : null}
            ${p.description ? html`<div class="plugin-card__desc">${p.description}</div>` : null}
            ${p.error ? html`<div class="plugin-card__err">⚠ ${t('加载失败')}：${p.error}</div>` : null}
          </div>
          <div class="mod-mgr__ops">
            <button type="button" class=${`plugin-card__toggle${isOff ? ' is-off' : ''}`}
              onClick=${() => { audio.sfx('click', { volume: 0.4 }); toggleMod(id, !isOff, plugins); }}>${isOff ? t('已卸下') : t('已启用')}</button>
            ${p.user ? html`<button type="button" class="mod-mgr__del" onClick=${() => { audio.sfx('click', { volume: 0.4 }); removeLocal(id); }}>${t('移除')}</button>` : null}
          </div>
        </div>`;
      })}
      ${packs.map((pk) => {
        const isOff = isPackOff(pk.id);
        const members = plugins.filter((p) => p.pack === pk.id);
        return html`<div class=${`mod-mgr__pack${isOff ? ' is-off' : ''}`} key=${pk.id}>
          <div class="mod-mgr__row">
            <div class="mod-mgr__info">
              <div class="plugin-card__top">
                <span class="plugin-card__name">${pk.name || pk.id}</span>
                <span class="plugin-card__badge">${t('整合包')}</span>
                ${pk.version ? html`<span class="plugin-card__ver">v${pk.version}</span>` : null}
                ${pk.file && pk.file !== '(本地添加)' ? html`<span class="plugin-card__file">${pk.file}</span>` : null}
              </div>
              ${pk.author ? html`<div class="plugin-card__author">by ${pk.author}</div>` : null}
              ${pk.description ? html`<div class="plugin-card__desc">${pk.description}</div>` : null}
            </div>
            <div class="mod-mgr__ops">
              <button type="button" class=${`plugin-card__toggle${isOff ? ' is-off' : ''}`}
                onClick=${() => { audio.sfx('click', { volume: 0.4 }); const next = !isPackOff(pk.id); setPackOff(pk.id, next); toast(next ? t('已开启整合包「{NAME}」，旗下 {N} 个 MOD 一并启用', { NAME: pk.name || pk.id, N: members.length }) : t('已关闭整合包「{NAME}」，旗下 {N} 个 MOD 一并卸下', { NAME: pk.name || pk.id, N: members.length }), next ? 'success' : 'info'); }}>${isOff ? t('已卸下') : t('已启用')}</button>
            </div>
          </div>
          <div class="mod-mgr__pack-members">
            ${t('内含 {N} 个 MOD', { N: members.length })}
            ${members.map((m) => html`<div class="mod-mgr__member" key=${m.id || m.file}>
              <span class="mod-mgr__mname">${m.name || m.id}</span>
              ${m.error ? html`<span class="plugin-card__err">⚠ ${t('加载失败')}：${m.error}</span>` : null}
            </div>`)}
          </div>
        </div>`;
      })}
      <div class="mod-mgr__add">
        <input ref=${fileRef} type="file" accept=".js,text/javascript" multiple hidden
          onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <${Button} variant="secondary" icon="plus" disabled=${busy} onClick=${() => { audio.sfx('click', { volume: 0.4 }); if (fileRef.current) fileRef.current.click(); }}>
          ${t('添加本地 MOD（.js）')}<//>
        <p class="mod-mgr__hint">${t('本地 MOD 只保存在这台浏览器上，刷新 / 重启后仍会加载，仅自己可见。把 .js 文件放进服务器的 public/mod/ 文件夹则对所有玩家生效。卸下的 MOD 不会在对局内显示界面。')}</p>
      </div>
    </div>
  <//>`;
}

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  useLang(); // re-render on a language switch
  const [name, setName] = useState(() => store.get().me.name || identity.loadName() || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);

  const valid = isValidName(name);
  const start = () => {
    if (!valid) { toast(t('请输入博士代号'), 'warn'); return; }
    enterSession(name);
  };

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  // a title in an alphabetic script (English, French …) is the big one in the display face and the wordmark above it
  // hides; a CJK / kana / Hangul title keeps the Chinese layout (shared/i18nPacks.js scriptOf — a pack needs no flag)
  const alphabetic = scriptOf(t('卫戍协议')) === 'alphabetic';
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${`background-image:url("${ridges}")`}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <div>
        <${LangToggle} class="title-lang" />
        <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
      </div>
    </div>

    <main class="title-main">
      <${Emblem} />
      ${alphabetic ? null : html`<div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>`}
      <h1 class=${`title-cn${alphabetic ? ' title-cn--latin' : ''}`}>${t('卫戍协议')}<span class="title-cn__colon">${alphabetic ? ': ' : '：'}</span><em>${t('盟约')}</em></h1>
      <p class="title-tag">${t('调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。')}</p>

      <div class="title-login">
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>${t('收到同盟邀请')}</span><b class="num">${pendingJoin}</b><span class="t-lo">${t('· 输入代号后将自动加入')}</span>
        </div>` : null}
        <${TextField} label=${t('博士代号')} micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
          placeholder=${t('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })} autoFocus=${!touchUi}
          onInput=${setName} onEnter=${start} />
        <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" disabled=${!valid} onClick=${() => { audio.sfx('click', { volume: 0.5 }); start(); }}>${t('开始')}<//>
        <div class="title-conn">
          <span class=${`status-dot ${dotClass}`}></span>
          <span>${STATUS_TEXT[conn.status] ? t(STATUS_TEXT[conn.status]) : conn.status}</span>
          ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          <${GuideButton} class="title-guide" label=${t('玩法说明')} />
          <button type="button" class="title-settings fsbtn tapx" aria-label=${t('设置')} title=${t('设置')}
            onClick=${() => { audio.sfx('click', { volume: 0.4 }); setSettingsOpen(true); }}><${GIcon} name="gear" /></button>
          <${FullscreenButton} class="title-fs" />
        </div>
      </div>
    </main>

    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />

    <${PluginPanel} />

    <footer class="title-foot">
      <span>${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}</span>
      <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
      ${DEV_BUILD ? html`<span class="title-dev" role="note">${t('开发版 · 不稳定，请勿用于公开服务器')}</span>` : null}
    </footer>
  </div>`;
}
