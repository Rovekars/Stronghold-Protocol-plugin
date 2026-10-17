// 音乐盒 插件（MOD）
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 功能：
//   ① 替换 BGM：打开开关后，游戏里所有阶段（主页 / 房间 / 休整 / 作战 / BOSS）的背景音乐换成你选的曲子——
//      它走的是本体音频系统的 BGM 通道，所以本体设置里的「背景音乐」音量照样管得住它；关掉开关立刻还原原版 BGM；
//   ② 曲库：内置 PRTS「音乐鉴赏 / 独立单曲」的全部曲目（185 首，塞壬唱片官方单曲），按年份分组、可搜索；
//   ③ 上传：本地音频文件（mp3 / wav / ogg / m4a / flac…）存进 IndexedDB，和曲库一样可选、可删；
//   ④ 控制：上一首 / 下一首 / 暂停 + 播放模式（➡️ 顺序：按列表播完即停 / 🔁 循环：当前曲目反复 / 🔀 随机），
//      当前曲目与开关状态持久化，刷新后继续放。
//
// 实现说明（务必先看）：
//   - 本体扩展点：public/js/audio.js 的 setBgmOverride —— fn({ key, track }) 返回 { intro?, loop } 即接管 BGM；
//     插件只需要在曲目变化时调 api.refreshBgm()。冷却 / 淡入淡出 / 音量 / 标签页隐藏暂停全部由本体照管；
//   - 网易云的曲子不能直接从浏览器抓：music.163.com 的 302 跳转不带 CORS 头，页面里 fetch 会 Failed to fetch
//     （它跳到的 *.music.126.net CDN 反倒是 *）。所以插件把曲库里的 song id 拼成同源地址
//     `/media/netease/<id>`，由 server/http/media.js 代取后回吐字节（主机白名单只有网易云，不是任意代理）；
//     局域网 / 离线时曲库曲目会拉不到，本体照旧静音处理，上传的本地文件不受影响；
//   - 入口在游戏本体「设置」弹窗里的一行（registerSettingsEntry），主页和对局内都能开；
//     卸下本 MOD 时，BGM 覆写随之一并撤销（main.js 按 modsOffMap 过滤），不会留下一首关不掉的背景音乐。
//
// 曲库来源：https://prts.wiki/w/音乐鉴赏/独立单曲（抓取时点 2026-10；标题 / 年份分组 / song id 均取自该页面）。

import { useState, useEffect, useRef } from 'preact/hooks';
import { loadPref, savePref } from '../js/store.js';
import { audio } from '../js/audio.js';

const PREF_KEY = 'musicbox';          // { on, playing, shuffle, cur: { kind, id, name } }
const IDB_NAME = 'sp-musicbox';
const IDB_STORE = 'tracks';
const MAX_LOCAL = 24;                 // 本地上传上限（IndexedDB 装得下更多，但列表会很难翻）
const MAX_LOCAL_BYTES = 40 * 1024 * 1024;
const LIST_STEP = 60;                 // 曲库一次最多渲染多少行（搜索可缩小范围）

/** 内置曲库：{ t 标题, g 分组（Y-7…Y-0 / 早期 / 站内）, n 网易云 song id | u 直链 } —— 见文件头。 */
const CATALOG = [
  { t: "Innocence", g: "Y-7", n: "3375918502" },
  { t: "All by My Design", g: "Y-7", n: "3376569082" },
  { t: "Don't Miss It", g: "Y-7", n: "3376714297" },
  { t: "夏日远去之后", g: "Y-7", n: "3390243136" },
  { t: "悖反构成", g: "Y-7", n: "3403363830" },
  { t: "What an Electromagnetic Night", g: "Y-7", n: "3407412711" },
  { t: "女士的游戏", g: "Y-7", n: "3407893951" },
  { t: "酸橙色信笺", g: "Y-7", n: "3410744228" },
  { t: "Every Road is a Yes", g: "Y-7", n: "3413850102" },
  { t: "Summer Calling", g: "Y-7", n: "3420832272" },
  { t: "月明人间", g: "Y-7", n: "3440193682" },
  { t: "Heavenly Me", g: "Y-6", n: "2699629221" },
  { t: "Sanctuary Inside", g: "Y-6", n: "2699626075" },
  { t: "Still the Same", g: "Y-6", n: "2699921361" },
  { t: "The After", g: "Y-6", n: "2709403466" },
  { t: "Grow on My Time", g: "Y-6", n: "2712336626" },
  { t: "Mare Natus", g: "Y-6", n: "2719304071" },
  { t: "惊蛰时", g: "Y-6", n: "2723357459" },
  { t: "Summer Fizz Pop", g: "Y-6", n: "2728405343" },
  { t: "Undaunted", g: "Y-6", n: "2731345249" },
  { t: "Little Wish", g: "Y-6", n: "2731325796" },
  { t: "碧い瞳の中に", g: "Y-6", n: "2742468679" },
  { t: "Sealed", g: "Y-6", n: "2751379003" },
  { t: "Paper Boat", g: "Y-6", n: "2755406555" },
  { t: "The Walk", g: "Y-6", n: "3312932682" },
  { t: "Follow Your Heart", g: "Y-6", n: "3312937331" },
  { t: "Stardust on Me", g: "Y-6", n: "3312321567" },
  { t: "Secret Escape", g: "Y-6", n: "3320047162" },
  { t: "Just Another Inch Higher", g: "Y-6", n: "3324518630" },
  { t: "Slowly Flow, Hearthlight Glow", g: "Y-6", n: "3332141362" },
  { t: "Wanna Know Me? (Too Bad)", g: "Y-6", n: "3336875557" },
  { t: "铁花飞", g: "Y-6", n: "3342981041" },
  { t: "无名策", g: "Y-6", n: "3348083045" },
  { t: "花街迎春", g: "Y-6", n: "3349298940" },
  { t: "Oath", g: "Y-6", n: "3356429632" },
  { t: "One Fight", g: "Y-6", n: "3366069939" },
  { t: "In Due Time", g: "Y-6", n: "3368494293" },
  { t: "Arsonist", g: "Y-5", n: "2151202025" },
  { t: "Whistle Stop", g: "Y-5", n: "2151215639" },
  { t: "Echoism", g: "Y-5", n: "2151230759" },
  { t: "I Will Touch the Sky", g: "Y-5", n: "2158229087" },
  { t: "Vows of the Sea", g: "Y-5", n: "2163240287" },
  { t: "Chase the Light", g: "Y-5", n: "2163262921" },
  { t: "Warm and Small Light", g: "Y-5", n: "2603903847" },
  { t: "Mystic Light Quest", g: "Y-5", n: "2612747239" },
  { t: "Nightmare's Descent", g: "Y-5", n: "2612754800" },
  { t: "Reforge", g: "Y-5", n: "2634494722" },
  { t: "Unmask", g: "Y-5", n: "2641866088" },
  { t: "Bloodstained Oath", g: "Y-5", n: "2641892207" },
  { t: "Figure It Out", g: "Y-5", n: "2641910121" },
  { t: "Sailing For", g: "Y-5", n: "2653069255" },
  { t: "WE", g: "Y-5", n: "2657389215" },
  { t: "Tranquil Snow", g: "Y-5", n: "2659584604" },
  { t: "滋味常", g: "Y-5", n: "2668038573" },
  { t: "烛影暖", g: "Y-5", n: "2667701653" },
  { t: "此时圆", g: "Y-5", n: "2668992231" },
  { t: "Epilogue", g: "Y-5", n: "2674117618" },
  { t: "Final Embrace", g: "Y-5", n: "2681372601" },
  { t: "Skeletal Wings", g: "Y-5", n: "2691003687" },
  { t: "From Ash to Fire", g: "Y-5", n: "2694550945" },
  { t: "Morning Dew", g: "Y-4", n: "2042849489" },
  { t: "Dormant Craving", g: "Y-4", n: "2042872786" },
  { t: "The cure", g: "Y-4", n: "2042920491" },
  { t: "Stained", g: "Y-4", n: "2051793162" },
  { t: "Before Summer", g: "Y-4", n: "2051789190" },
  { t: "Before & After", g: "Y-4", n: "2058566896" },
  { t: "Mortal Eye", g: "Y-4", n: "2060731820" },
  { t: "Miss You", g: "Y-4", n: "2068111443" },
  { t: "Missy", g: "Y-4", n: "2069005111" },
  { t: "Beautiful & Lovely", g: "Y-4", n: "2074366900" },
  { t: "Water Quench", g: "Y-4", n: "2078070386" },
  { t: "Settle Into Ash", g: "Y-4", n: "2088472839" },
  { t: "Best Moments of...", g: "Y-4", n: "2091885618" },
  { t: "Revealing", g: "Y-4", n: "2095549817" },
  { t: "Illuminate", g: "Y-4", n: "2095246083" },
  { t: "Lessing", g: "Y-4", n: "2095181378" },
  { t: "Blade Catcher", g: "Y-4", n: "2102690163" },
  { t: "Snow Parade", g: "Y-4", n: "2110359806" },
  { t: "(Believed Believes) Believing", g: "Y-4", n: "2111780858" },
  { t: "Winged Step", g: "Y-4", n: "2114750011" },
  { t: "浸春芜", g: "Y-4", n: "2122534120" },
  { t: "清平乐", g: "Y-4", n: "2122595714" },
  { t: "Yanking", g: "Y-4", n: "2124421466" },
  { t: "ONE BY ONE", g: "Y-4", n: "2143964670" },
  { t: "Awaken", g: "Y-3", n: "1941653825" },
  { t: "Rapier", g: "Y-3", n: "1941656969" },
  { t: "Bluish Light", g: "Y-3", n: "1941658812" },
  { t: "Hunter's Song", g: "Y-3", n: "1945303958" },
  { t: "Your Star", g: "Y-3", n: "1953860839" },
  { t: "Ständchen", g: "Y-3", n: "1953863738" },
  { t: "Magic Theorem", g: "Y-3", n: "1960301055" },
  { t: "A Long Vacation", g: "Y-3", n: "1962337725" },
  { t: "All hail Savior!", g: "Y-3", n: "1971060661" },
  { t: "Undertopia", g: "Y-3", n: "1971052096" },
  { t: "Ensheath", g: "Y-3", n: "1978870845" },
  { t: "A Sweet Rendez-vous", g: "Y-3", n: "1985324290" },
  { t: "Stainless Heart", g: "Y-3", n: "1985642223" },
  { t: "Rekindle", g: "Y-3", n: "1988460950" },
  { t: "Running In The Dark", g: "Y-3", n: "1990154664" },
  { t: "Thorns In You", g: "Y-3", n: "1992988615" },
  { t: "Sentenced", g: "Y-3", n: "1993340899" },
  { t: "Go My Way", g: "Y-3", n: "1994485658" },
  { t: "Flame Shadow", g: "Y-3", n: "2006550948" },
  { t: "Snowy Night", g: "Y-3", n: "2008728404" },
  { t: "A Cold Call", g: "Y-3", n: "2009965933" },
  { t: "定风波", g: "Y-3", n: "2013735452" },
  { t: "近尘烟", g: "Y-3", n: "2013746250" },
  { t: "兔兔在哪里？", g: "Y-3", n: "2013933995" },
  { t: "春岚", g: "Y-3", n: "2021168484" },
  { t: "Squad Unknown", g: "Y-3", n: "2035913457" },
  { t: "Voices", g: "Y-2", n: "1840981141" },
  { t: "Immutable", g: "Y-2", n: "1840976599" },
  { t: "Real Me", g: "Y-2", n: "1847970242" },
  { t: "Heart Forest", g: "Y-2", n: "1850210271" },
  { t: "Keep the torch", g: "Y-2", n: "1855194364" },
  { t: "Across the wind", g: "Y-2", n: "1865098460" },
  { t: "Y1K", g: "Y-2", n: "1865105781" },
  { t: "Towards Her Light", g: "Y-2", n: "1876956006" },
  { t: "Bridge to the Dawn", g: "Y-2", n: "1886668990" },
  { t: "Proof of being alive", g: "Y-2", n: "1888874634" },
  { t: "Radiant", g: "Y-2", n: "1890402858" },
  { t: "Field in the Light", g: "Y-2", n: "1890404817" },
  { t: "Heal the World", g: "Y-2", n: "1903164950" },
  { t: "Melting White", g: "Y-2", n: "1903957351" },
  { t: "Silver Lining", g: "Y-2", n: "1907801055" },
  { t: "醉飞尘", g: "Y-2", n: "1913463815" },
  { t: "却阑珊", g: "Y-2", n: "1913876873" },
  { t: "将进酒", g: "Y-2", n: "1914891754" },
  { t: "随意随意呀", g: "Y-2", n: "1913466746" },
  { t: "Spark for Dream", g: "Y-2", n: "1919486276" },
  { t: "Прощание", g: "Y-2", n: "1922349072" },
  { t: "Eternal Flame", g: "Y-2", n: "1927441611" },
  { t: "March On!", g: "Y-2", n: "1936324213" },
  { t: "A Grand Adventure", g: "Y-2", n: "1939239925" },
  { t: "Speed of Light", g: "Y-0", n: "1403774122" },
  { t: "Zone 10⁻⁸", g: "Y-0", n: "1406452570" },
  { t: "Boiling Blood", g: "Y-0", n: "1411527086" },
  { t: "示岁", g: "Y-0", n: "1417483463" },
  { t: "Operation Barrenland (W&W Soundtrack Mix)", g: "Y-0", n: "1428299645" },
  { t: "故乡的风", g: "Y-0", n: "1431593851" },
  { t: "春弦", g: "Y-0", n: "1436614177" },
  { t: "Curtain Call", g: "Y-0", n: "1442033701" },
  { t: "Renegade", g: "Y-0", n: "1444493657" },
  { t: "Requiem", g: "Y-0", n: "1444493780" },
  { t: "Sparkling Hydraulics", g: "Y-0", n: "1444503072" },
  { t: "Reversed Time", g: "Y-0", n: "1451700083" },
  { t: "УраУра", g: "Y-0", n: "1456166166" },
  { t: "Everything's Alright", g: "Y-0", n: "1460626792" },
  { t: "Lily of the Valley", g: "Y-0", n: "1462342505" },
  { t: "夏浪", g: "Y-0", n: "1467848445" },
  { t: "El Brillo Solitario", g: "Y-0", n: "1470071584" },
  { t: "Evolutionary Mechanization", g: "Y-0", n: "1473615377" },
  { t: "ALIVE", g: "Y-0", n: "1473615924" },
  { t: "Reconnection", g: "Y-0", n: "1481447983" },
  { t: "秋绪", g: "Y-0", n: "1485858993" },
  { t: "Stay Gold", g: "Y-0", n: "1488275299" },
  { t: "CONFRONT", g: "Y-0", n: "1491495554" },
  { t: "Lullabye", g: "Y-0", n: "1491503292" },
  { t: "LITHOS", g: "Y-0", n: "1491511460" },
  { t: "Crystallize", g: "Y-0", n: "1499781983" },
  { t: "Tipsy", g: "Y-0", n: "1804654314" },
  { t: "Rock the Night Away", g: "Y-0", n: "1806528693" },
  { t: "冬涤", g: "Y-0", n: "1809781249" },
  { t: "尽波澜", g: "Y-0", n: "1817667813" },
  { t: "更阑影", g: "Y-0", n: "1818074345" },
  { t: "观心", g: "Y-0", n: "1822538485" },
  { t: "Daydaydream", g: "Y-0", n: "1828858733" },
  { t: "Gearing Up", g: "Y-0", n: "1837237665" },
  { t: "Hold Onto The Light", g: "Y-0", n: "1839205789" },
  { t: "Feels", g: "Y-0", n: "1839207650" },
  { t: "After It All", g: "早期", n: "1444021416" },
  { t: "Last Of Me", g: "早期", n: "1457694617" },
  { t: "Come to Light", g: "早期", n: "1806172146" },
  { t: "End Like This", g: "早期", n: "1807756571" },
  { t: "Never Give Up", g: "早期", n: "1940330897" },
  { t: "Lean On", g: "早期", n: "2010173461" },
  { t: "I Believe In Us", g: "早期", n: "1898207965" },
  { t: "Two Feet On The Ground", g: "早期", n: "1940330748" },
  { t: "Ain't Seen Nothing Like This", g: "早期", n: "1940327964" },
  { t: "Wildfire", g: "早期", n: "2009755514" },
  { t: "Keep Holding On", g: "早期", n: "2010174550" },
  { t: "We Will Rise", g: "早期", n: "2010175755" },
  { t: "Day By Day", g: "早期", n: "2032510846" },
  { t: "Unbreakable", g: "早期", n: "2134764293" },
  { t: "嚣", g: "站内", u: "https://media.prts.wiki/f/fb/%E5%9A%A3.mp3?v=at3rc4o5941jvbwer81w3k3k9lalo76" },
];

/** 曲库展开成播放列表：网易云的走同源代理，站内直链原样用。 */
const TRACKS = CATALOG.map((c, i) => ({
  id: c.n ? `n${c.n}` : `u${i}`,
  name: c.t,
  group: c.g || '',
  url: c.n ? `/media/netease/${c.n}` : c.u,
}));

// ---- IndexedDB（本地上传）---------------------------------------------------------------------------------------------
let idbPromise = null;
function idbOpen() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(IDB_STORE)) rq.result.createObjectStore(IDB_STORE); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error || new Error('IndexedDB 打开失败'));
    });
  }
  return idbPromise;
}
const idbTx = async (mode, run) => {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    let out;
    try { out = run(tx.objectStore(IDB_STORE)); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 操作失败'));
  });
};
const idbAll = () => idbTx('readonly', (st) => {
  const list = [];
  st.openCursor().onsuccess = (e) => {
    const c = e.target.result;
    if (!c) return;
    list.push(c.value);
    c.continue();
  };
  return list; // settled by oncomplete
}).catch((e) => { console.warn('[musicbox] 读取本地音乐失败', e); return []; });
const idbPut = (rec) => idbTx('readwrite', (st) => st.put(rec, rec.id)).catch((e) => { console.warn('[musicbox] 保存失败', e); });
const idbDel = (id) => idbTx('readwrite', (st) => st.delete(id)).catch((e) => { console.warn('[musicbox] 删除失败', e); });

export default {
  id: 'musicbox',
  name: '音乐盒',
  version: '1.1.0',
  author: 'mod',
  description: '用自己选的曲子替换游戏 BGM：内置 PRTS「音乐鉴赏 / 独立单曲」185 首塞壬唱片单曲，也可上传本地音频。入口在「设置」里。',

  setup(api) {
    const { html, toast, setBgmOverride, refreshBgm, registerSettingsEntry } = api;

    const T = {
      line: 'var(--line-2)', mint: 'var(--mint-400)', mintDeep: 'var(--mint-500)',
      dim: 'var(--text-dim)', md: 'var(--text-md)', hi: 'var(--text-hi)', amber: 'var(--amber)',
    };

    // ---- 状态：模块级单例（BGM 覆写要在组件挂载之外也读得到） --------------------------------------------------------
    /** @type {{ on: boolean, playing: boolean, mode: 'order'|'loop'|'shuffle', cur: { kind: 'cat'|'local', id: string, name: string, url: string } | null, playId: number }} */
    let box = { on: false, playing: true, mode: 'loop', cur: null, playId: 0 };
    let locals = [];                  // 本地上传：{ id, name, url }（url 是 blob 的 object URL）
    const blobUrls = new Map();       // id → object URL（只在删除 / 覆盖时 revoke）
    const listeners = new Set();
    const saved = loadPref(PREF_KEY, null);

    if (saved && typeof saved === 'object') {
      // v1.0 存的是 shuffle 布尔——照旧认得；mode 只认三态里的合法值，其余回落单曲循环（v1.0 的实际行为）
      const mode = saved.mode === 'order' || saved.mode === 'shuffle' ? saved.mode : saved.shuffle ? 'shuffle' : 'loop';
      box = { ...box, on: !!saved.on, playing: saved.playing !== false, mode, cur: null };
      const c = saved.cur;
      if (c && typeof c.id === 'string') {
        if (c.kind === 'cat') {
          const t = TRACKS.find((x) => x.id === c.id);
          if (t) box.cur = { kind: 'cat', id: t.id, name: t.name, url: t.url };
        } else box.cur = { kind: 'local', id: c.id, name: c.name || '本地音乐', url: '' }; // url 等 IDB 读出来再补
      }
    }

    const persist = () => savePref(PREF_KEY, {
      on: box.on, playing: box.playing, mode: box.mode,
      cur: box.cur ? { kind: box.cur.kind, id: box.cur.id, name: box.cur.name } : null,
    });
    const notify = () => { for (const f of listeners) f(); };

    // 接管 BGM：开着 + 没暂停 + 有曲子 ⇒ 播它，否则交还给本体。
    // 单曲循环用本体原生 loop（播完从头再来）；顺序 / 随机走 noLoop + onEnded——曲目自然播完一次后由
    // onTrackEnded 接下一首（audio.js 的 token 守卫保证只有「自然播完」才回调，淡出 / 切歌不算）。
    // playId 是每次开播的自增流水号：同一首曲子重新开播（如顺序模式列表只有一首）也能重启而不是被
    // 「同 URL 不重启」的短路挡掉。
    let playSeq = 0;
    const onTrackEnded = () => {
      if (!box.on || !box.playing || !box.cur || box.mode === 'loop') return;
      const list = box.cur.kind === 'local' ? locals : TRACKS;
      const at = list.findIndex((x) => x.id === box.cur.id);
      if (box.mode === 'order' && at >= list.length - 1) {
        commit({ playing: false });   // 顺序播放放完最后一首：停下，本体原版 BGM 回来（与关开关同一机制）
        return;
      }
      step(1);
    };
    setBgmOverride(() => {
      if (!(box.on && box.playing && box.cur && box.cur.url)) return null;
      if (box.mode === 'loop') return { loop: box.cur.url };
      return { loop: box.cur.url, noLoop: true, playId: box.playId, onEnded: onTrackEnded };
    });

    const urlOf = (rec) => {
      let u = blobUrls.get(rec.id);
      if (!u) { u = URL.createObjectURL(rec.blob); blobUrls.set(rec.id, u); }
      return u;
    };

    // 启动时读本地音乐；若记住的正是本地曲目，把它的 URL 补上再开播
    idbAll().then((recs) => {
      locals = recs.filter((r) => r && r.id && r.blob).map((r) => ({ id: r.id, name: r.name || '本地音乐', url: urlOf(r) }));
      if (box.cur && box.cur.kind === 'local') {
        const hit = locals.find((l) => l.id === box.cur.id);
        if (hit) box.cur = { ...box.cur, url: hit.url };
        else box.cur = null; // 文件已被删掉
      }
      notify();
      refreshBgm();
    });

    /** 改状态 → 持久化 → 立刻生效 → 面板重绘 */
    const commit = (patch) => { Object.assign(box, patch); persist(); refreshBgm(); notify(); };

    const playTrack = (tr) => commit({ on: true, playing: true, cur: tr, playId: ++playSeq });

    const step = (dir) => {
      const list = box.cur && box.cur.kind === 'local' ? locals : TRACKS;
      if (!list.length) return;
      if (box.mode === 'shuffle' && list.length > 1) {
        let i = Math.floor(Math.random() * list.length);
        const at = box.cur ? list.findIndex((x) => x.id === box.cur.id) : -1;
        if (i === at) i = (i + 1) % list.length;
        playTrack(list[i]);
        return;
      }
      const at = box.cur ? list.findIndex((x) => x.id === box.cur.id) : -1;
      const next = list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length];
      playTrack(next);
    };

    const addFiles = async (fileList) => {
      const files = Array.from(fileList || []).filter((f) => /^audio\//.test(f.type) || /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i.test(f.name));
      if (!files.length) { toast('请选择音频文件（mp3 / wav / ogg / m4a / flac…）', 'error'); return; }
      const room = MAX_LOCAL - locals.length;
      if (room <= 0) { toast(`本地音乐已满（上限 ${MAX_LOCAL} 首）`, 'error'); return; }
      let added = 0;
      for (const f of files.slice(0, room)) {
        if (f.size > MAX_LOCAL_BYTES) { toast(`「${f.name}」超过 40MB，换个小一点的文件`, 'error'); continue; }
        const id = `mb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const rec = { id, name: f.name.replace(/\.[^.]+$/, ''), blob: f, at: Date.now() };
        await idbPut(rec);
        locals = [...locals, { id, name: rec.name, url: urlOf(rec) }];
        added += 1;
      }
      if (added) { persist(); notify(); toast(`已添加 ${added} 首本地音乐`, 'success'); }
      if (fileRef.current) fileRef.current.value = '';
    };

    const removeLocal = async (id) => {
      await idbDel(id);
      const u = blobUrls.get(id);
      if (u) { URL.revokeObjectURL(u); blobUrls.delete(id); }
      locals = locals.filter((l) => l.id !== id);
      if (box.cur && box.cur.id === id) commit({ cur: null });
      else { persist(); notify(); }
    };

    const fileRef = { current: null };

    // ---- 面板（挂在本体「设置」弹窗里） -------------------------------------------------------------------------------
    function MusicBoxPanel() {
      const [, force] = useState(0);
      const [tab, setTab] = useState('cat');
      const [q, setQ] = useState('');
      const [more, setMore] = useState(LIST_STEP);
      const [armed, setArmed] = useState(null);
      const inputRef = useRef(null);
      useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);
      useEffect(() => {
        if (!armed) return undefined;
        const t = setTimeout(() => setArmed(null), 1800);
        return () => clearTimeout(t);
      }, [armed]);
      fileRef.current = inputRef.current;

      const ql = q.trim().toLowerCase();
      const found = ql ? TRACKS.filter((t) => t.name.toLowerCase().includes(ql) || t.group.toLowerCase().includes(ql)) : TRACKS;
      const shown = found.slice(0, more);

      const row = (on) => ({
        display: 'flex', alignItems: 'center', gap: '.08rem', width: '100%', textAlign: 'left',
        padding: '.07rem .1rem', marginBottom: '.04rem', cursor: 'pointer', fontSize: '.14rem', lineHeight: 1.35,
        border: `1px solid ${on ? T.mintDeep : T.line}`, background: on ? 'rgba(78, 216, 175, .10)' : 'rgba(10, 13, 12, .6)',
        color: on ? T.hi : T.md,
      });
      const pill = (on) => ({
        flex: 'none', padding: '.03rem .1rem', fontSize: '.12rem', cursor: 'pointer',
        border: `1px solid ${on ? T.mintDeep : T.line}`, background: on ? 'rgba(78, 216, 175, .14)' : 'transparent',
        color: on ? T.mint : T.dim,
      });
      const hint = { margin: '0 0 .08rem', fontSize: '.12rem', color: T.dim, lineHeight: 1.7 };
      const curName = box.cur ? box.cur.name : '未选择';

      return html`
        <div>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '.08rem', marginBottom: '.08rem' }}>
            <button type="button" style=${pill(box.on)} onClick=${() => { audio.sfx('click', { volume: 0.4 }); commit({ on: !box.on }); }}>
              ${box.on ? '已替换 BGM' : '使用原版 BGM'}
            </button>
            <span style=${{ fontSize: '.12rem', color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ${curName}
            </span>
          </div>

          <div style=${{ display: 'flex', alignItems: 'center', gap: '.06rem', rowGap: '.04rem', flexWrap: 'wrap', marginBottom: '.1rem' }}>
            <button type="button" style=${pill(true)} onClick=${() => { audio.sfx('click', { volume: 0.4 }); step(-1); }} title="上一首">⏮</button>
            <button type="button" style=${pill(true)} onClick=${() => { audio.sfx('click', { volume: 0.4 }); box.cur ? commit({ playing: !box.playing }) : step(1); }}
                    title=${box.playing ? '暂停' : '继续'}>${box.playing ? '⏸' : '▶️'}</button>
            <button type="button" style=${pill(true)} onClick=${() => { audio.sfx('click', { volume: 0.4 }); step(1); }} title="下一首">⏭</button>
            <button type="button" style=${pill(box.mode === 'order')} onClick=${() => { audio.sfx('tab', { volume: 0.4 }); commit({ mode: 'order' }); }}
                    title="顺序播放：按列表顺序播，放完最后一首即停">➡️ 顺序</button>
            <button type="button" style=${pill(box.mode === 'loop')} onClick=${() => { audio.sfx('tab', { volume: 0.4 }); commit({ mode: 'loop' }); }}
                    title="单曲循环：当前曲目反复播放">🔁 循环</button>
            <button type="button" style=${pill(box.mode === 'shuffle')} onClick=${() => { audio.sfx('tab', { volume: 0.4 }); commit({ mode: 'shuffle' }); }}
                    title="随机播放：播完随机跳一首">🔀 随机</button>
            ${box.cur && box.cur.kind === 'local' ? null : html`<span style=${{ fontSize: '.11rem', color: T.dim }}>曲库曲目需要联网</span>`}
          </div>

          <div style=${{ display: 'flex', gap: '.06rem', marginBottom: '.08rem' }}>
            <button type="button" style=${pill(tab === 'cat')} onClick=${() => { audio.sfx('tab', { volume: 0.5 }); setTab('cat'); }}>曲库 ${TRACKS.length}</button>
            <button type="button" style=${pill(tab === 'local')} onClick=${() => { audio.sfx('tab', { volume: 0.5 }); setTab('local'); }}>我的音乐 ${locals.length}</button>
          </div>

          ${tab === 'cat' ? html`
            <input value=${q} onInput=${(e) => { setQ(e.currentTarget.value); setMore(LIST_STEP); }}
                   placeholder="搜索曲名 / 年份（如 Y-2）"
                   style=${{ width: '100%', marginBottom: '.08rem', padding: '.05rem .08rem', fontSize: '.13rem',
                             color: T.hi, background: 'rgba(10, 13, 12, .6)', border: `1px solid ${T.line}` }} />
            ${shown.map((t) => html`
              <button key=${t.id} type="button" style=${row(!!box.cur && box.cur.id === t.id)} onClick=${() => { audio.sfx('pick', { volume: 0.5 }); playTrack(t); }}>
                <span style=${{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${t.name}</span>
                <span style=${{ flex: 'none', fontSize: '.11rem', color: T.dim }}>${t.group}</span>
              </button>`)}
            ${found.length > shown.length ? html`
              <button type="button" style=${{ ...row(false), justifyContent: 'center' }} onClick=${() => { audio.sfx('click', { volume: 0.4 }); setMore(more + LIST_STEP); }}>
                还有 ${found.length - shown.length} 首 · 显示更多
              </button>` : null}
            ${!found.length ? html`<p style=${hint}>没有匹配的曲目。</p>` : null}
          ` : html`
            <p style=${hint}>
              本地音频存在浏览器里（IndexedDB），不上传、不占服务器空间；删掉浏览器数据会一并清掉。
            </p>
            <input ref=${inputRef} type="file" accept="audio/*" multiple style=${{ display: 'none' }}
                   onChange=${(e) => addFiles(e.target && e.target.files)} />
            <button type="button" style=${{ ...row(false), justifyContent: 'center', color: T.mint, marginBottom: '.08rem' }}
                    onClick=${() => { audio.sfx('click', { volume: 0.4 }); inputRef.current && inputRef.current.click(); }}>+ 添加本地音乐</button>
            ${locals.map((l) => html`
              <div key=${l.id} style=${row(!!box.cur && box.cur.id === l.id)}>
                <span style=${{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onClick=${() => { audio.sfx('pick', { volume: 0.5 }); playTrack(l); }}>${l.name}</span>
                <button type="button" style=${{ ...pill(armed === l.id), color: armed === l.id ? T.amber : T.dim,
                                                borderColor: armed === l.id ? T.amber : T.line }}
                        onClick=${(e) => { e.stopPropagation(); if (armed === l.id) { audio.sfx('back', { volume: 0.5 }); removeLocal(l.id); } else { audio.sfx('click', { volume: 0.4 }); setArmed(l.id); } }}
                        title=${armed === l.id ? '再点一次删除' : '删除'}>${armed === l.id ? '✓' : '×'}</button>
              </div>`)}
            ${!locals.length ? html`<p style=${hint}>还没有上传过音乐。</p>` : null}
          `}
        </div>
      `;
    }

    registerSettingsEntry({ id: 'musicbox', label: '音乐盒', micro: 'MUSIC BOX', Panel: MusicBoxPanel });
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'musicbox';
