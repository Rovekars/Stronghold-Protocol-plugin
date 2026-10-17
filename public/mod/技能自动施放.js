// 技能自动 插件（MOD）
// ─────────────────────────────────────────────────────────────────────────────
// 功能：干员调配界面头部一个统一的开关「技能自动施放」，只作用于原本需要手动开启的技能（MANUAL）：
//   · 关（默认）：手动技能不自动释放——照常攒技力、保持就绪，由你在局内点开干员详情卡、点击技能图标手动施放
//     （本体 v0.2.1 起支持，普攻照常）；原本自动触发的技能（AUTO，如备用军粮、医疗无人机等）与被动完全不受影响。
//   · 开：与原版一致，技能由官方策略自动施放（挂机模式，所有技能自动开）。
//   · 开关文案以「技能是否自动施放」为准（关 = 不自动开技能），与服务器的实际行为一致；v1.1.0 的开关方向
//     与直觉相反、且提示文案写反，实战里极易误关（玩家报告 2026-10-10）；v1.1.3 把默认挡改为「关」（手动优先），
//     并换用新的偏好键（v2）——旧键里存的挡位一次性作废。
//   · 开关存本地（localStorage），进入模拟时自动向服务器应用；在休整期（PREP）改动则本局下一次战斗即生效。
//   · UI 用本体设计令牌（--bg-2/--line/--mint-500/.brackets/display 字体），原生 <Button> 风格，与整体一致、不冲突。
//
// 实现说明：
//   - 插件只做 UI 与本地持久化；是否真的关闭自动施放由服务器权威执行（g.setSkillAuto → server/match/player/
//     skilltoggle.js 写 this.noAutoSkill → battleInput 的 unit.noAutoSkill → server/sim/battle/players.js 给
//     SkillRuntime 打 noAuto → server/sim/skills.js 抑制 manual 技能的三种自动施放路径）。
//   - 头部按钮读 m.private.skillAuto 显示服务器实际应用的开关（本地偏好只是副本）。
//   - 本体扩展点：api.registerLoadoutAction（干员调配头部原生按钮位，自动套用 <Button> 样式，互不覆盖）、
//     api.registerOverlay（无头 brain，进对局自动下发）、api.unregisterLoadoutActions（刷新按钮文案/状态）。
//   - MOD 可能以 Blob URL 加载（本地添加），因此对本体模块一律用绝对路径导入（'/js/…'）。

import { useState, useEffect } from 'preact/hooks';
import { audio } from '../js/audio.js';

const PREF_KEY = 'sp.skillauto.pref.v2'; // { on: boolean } — on=true = 抑制自动施放（默认；v1.1.3 起换键，旧偏好作废）

/** Local pref: whether manual skills auto-cast. Default ON-suppression (关): manual skills wait for a hand cast. */
function loadPref() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.on === 'boolean' ? v.on : true;
  } catch { return true; }
}
function savePref(on) {
  try { globalThis.localStorage && globalThis.localStorage.setItem(PREF_KEY, JSON.stringify({ on })); } catch { /* ignore */ }
}

const BOLT = 'M13.2 2 5 13.6h5.1L9 22l9.2-12.2h-5.4z';

export default {
  name: '技能自动',
  version: '1.1.3',
  author: 'mod',
  description: '干员调配界面头部一个统一开关「技能自动施放」，只作用于原本需要手动开启的技能：关（默认）= 手动技能不自动释放，照常攒技力、保持就绪，由你在局内详情卡点击技能图标手动施放（原本自动触发的技能与被动完全不受影响）；开 = 与原版一致，所有技能自动施放（挂机）。开关存本地，进入模拟自动生效，休整期改动本局下一次战斗即生效。服务端权威。',
  setup(api) {
    const { store, net, html, toast, registerOverlay, registerLoadoutAction, unregisterLoadoutActions } = api;

    // ── shared state (the brain keeps it in sync; the header button reads it) ──
    const st = { on: loadPref(), failed: false, inMatch: false, applied: null };
    const listeners = new Set();
    const notify = () => { for (const f of listeners) f(); };

    /** Send the flag to the server (authoritative). */
    async function push(on) {
      try {
        await net.request('g.setSkillAuto', { on });
        st.failed = false;
        notify();
        return true;
      } catch {
        st.failed = true;
        notify();
        return false;
      }
    }

    /** Flip the switch and apply it (persisted locally; pushed to the server when a match is running). */
    function setOn(next) {
      const willOn = !!next;
      st.on = willOn;
      savePref(willOn);
      refreshBtn();
      notify();
      if (!st.inMatch) {
        // 文案以「技能是否自动施放」为准：willOn=true 是关掉自动施放（服务端 noAutoSkill=true）
        toast(`技能自动施放：${willOn ? '关 — 手动技能不自动开（局内点击施放），进入模拟自动生效' : '开 — 所有技能自动施放（挂机），进入模拟自动生效'}`, 'success');
        return;
      }
      (async () => {
        const ok = await push(willOn);
        toast(ok
          ? `技能自动施放：${willOn ? '关（不自动开技能）' : '开（自动施放）'}，本局下一次战斗生效`
          : `本地已保存，但同步到本局失败（下一局会自动重试）`, ok ? 'success' : 'warn');
      })();
    }

    // ── headless brain: apply the local pref at every match start, mirror what the server applied ──
    function SkillBrain() {
      const [, force] = useState(0);
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      const s = store.get();
      const pub = s.match && s.match.public;
      const phase = pub && pub.phase;
      const inMatch = !!(phase && phase !== 'LOBBY');
      const applied = s.match && s.match.private && typeof s.match.private.skillAuto === 'boolean' ? s.match.private.skillAuto : null;

      useEffect(() => {
        if (inMatch && !st.inMatch) push(st.on).catch(() => {});
        st.inMatch = inMatch;
        if (!inMatch) st.applied = null;
        notify();
      }, [inMatch]);

      const key = applied === null ? '' : String(applied);
      useEffect(() => { st.applied = applied; notify(); }, [key]);

      return null;
    }

    // ── the single unified header button (native <Button> style from the loadout host) ──
    // Label reads "是否自动施放": st.on=true（服务端 noAutoSkill=true，抑制自动施放）显示「关」。
    const entry = {
      id: 'skillauto-toggle',
      label: `技能自动施放：${st.on ? '关' : '开'}`,
      icon: 'bolt',
      variant: st.on ? 'secondary' : 'primary',
      title: '关（默认）：手动技能不自动开，由你在局内详情卡点击技能图标手动施放（自动触发的技能照常）；开：所有技能自动施放（挂机）',
      onClick: () => { audio.sfx('click', { volume: 0.4 }); setOn(!st.on); },
    };
    /** Re-render the header button with the current state (unregister + re-register refreshes its label/variant). */
    function refreshBtn() {
      entry.label = `技能自动施放：${st.on ? '关' : '开'}`;
      entry.variant = st.on ? 'secondary' : 'primary';
      try { unregisterLoadoutActions(); } catch { /* ignore */ }
      registerLoadoutAction(entry);
    }

    registerOverlay(SkillBrain);
    refreshBtn();

    return { id: 'skilltoggle', name: '技能自动', version: '1.1.3' };
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'skilltoggle';
