# 插件（MOD）目录 · mod/

把你的插件文件放进这个文件夹，**刷新页面**就会自动加载，无需重启服务器、无需改任何代码。

## 放文件的方式

支持两种形态，任选其一：

1. **单文件**：`mod/my-mod.js`
2. **目录式**（多文件）：`mod/my-mod/index.js`

> 文件名就是插件 id（**可以用中文**，方便一眼认出：如 `盲盒模式.js`、`音乐盒.js`、`干员时装.js`）。
> 点开头的文件（如 `.gitkeep`）、`node_modules`、`README*`、`manifest.json` 会被自动忽略。
> 服务器每次刷新都会重新扫描本目录，所以新丢进去的文件下次进页面就生效。
>
> 想让 id **不受改名影响**，插件里加一行 `export const id = 'my-mod';`：声明之后，本体的「启用 / 卸下」记录、
> 设置行 / 按钮位归属、服务端每局状态键都以这个 id 为准（本目录自带的插件都已声明，所以改名不会丢设置）。

## 插件长什么样

每个插件的**默认导出（default export）** 可以是下面两种之一：

### A. 一个 setup 函数

```js
// mod/hello.js
export default function (api) {
  // api 里能拿到本游戏的全部运行态，见下方「API 速查」
  api.toast('插件已加载：你好，博士！', 'success');

  // 返回一个对象即可在首页「插件 MOD」面板里显示元信息
  return {
    name: '示例问候插件',
    version: '1.0.0',
    author: 'your-name',
    description: '进入游戏时弹一条欢迎提示。',
  };
}
```

### B. 一个描述对象（带 setup）

```js
// mod/hello.js
export default {
  name: '示例问候插件',
  version: '1.0.0',
  author: 'your-name',
  description: '进入游戏时弹一条欢迎提示。',
  setup(api) {
    api.toast('插件已加载：你好，博士！', 'success');
  },
};
```

返回/声明的 `name / version / author / description` 会显示在标题页左下角的「插件 MOD」面板里；
如果加载失败，面板也会标红提示具体错误，方便排查。

## 真正能干嘛：API 速查

`setup(api)` 或函数里收到的 `api` 对象包含：

| 成员 | 用途 |
|---|---|
| `api.store` | 全局状态。`api.store.get()` 读、`api.store.patch('ui',{...})` 改、`api.store.subscribe(fn)` 订阅变化 |
| `api.net` | 套接字/网络层（发请求、监听服务器消息） |
| `api.data` | 游戏数据模块（干员、敌人、技能等静态表） |
| `api.html` | 模板标签：`api.html\`<div class="x">\${val}</div>\``，写 UI 超方便 |
| `api.h` | preact 的 `createElement`（高级用法） |
| `api.t` | 翻译函数：`api.t('msgid', { 参数 })` → 当前语言文本 |
| `api.toast` | 弹提示：`api.toast('文本', 'info'|'success'|'warn'|'error')` |
| `api.registerOverlay(Comp)` | 注册一个**全局浮层组件**（可用 hooks），会渲染在最上层 |
| `api.registerMessage(name, schema)` | **只在你的插件要自己发明一条上行消息时才需要**（例如 `g.myThing`）。浏览器发消息前会先用共享协议表本地校验，服务端那边由 `server(api)` 的 `api.registerMessage` 注入——**两边都要注册**，否则消息在出门前就被拒（本地「无效的请求」）。只用本体已有消息（干员调配 / 商店 / 表情 …）的插件不用管 |
| `api.registerSettingsEntry({ id, label, micro?, Panel? })` | 在游戏本体的**「设置」弹窗**里加一行：`label` / `micro` 是标题与小字，`Panel` 是可展开的组件（点击「展开」渲染）。适合「管理类」界面，不用在对局画面上占一块地方。卸下本 MOD 时该行自动消失 |
| `api.registerCustomEmotes(get)` | 在对局内**「交流」面板**加最后一页「自定义」：`get()` 返回 `[{ id, name? }]`，`id` 是图片的 dataURL（点击即发送，官方头像气泡展示）。卸下本 MOD 时该页自动消失 |
| `api.setBgmOverride(fn)` | 接管 **BGM**：`fn({ key, track })` 返回 `{ intro?, loop }` 就播它（两个字段是音频 URL，`loop` 会循环），返回 `null` 则沿用本体的曲子。换曲 / 暂停后调 `api.refreshBgm()` 立刻生效；`fn(null)` 交还本体。**卸下本 MOD 时自动撤销**，不会留下一首关不掉的背景音乐 |
| `api.registerLoadoutAction({ id, label, icon?, onClick, title?, variant?, size? })` | 在**「干员调配」顶栏**加一个按钮（`icon` 必须是 `ui/components.js` 的 `ICONS` 里的 key，否则没有图标）。卸下本 MOD 时自动消失 |
| `api.registerDetailAction({ id, label, icon?, onClick(chess), title?, variant?, size? })` | 在**「干员调配」详情头部**（「恢复默认」左边）加一个按钮：`onClick` 收到当前选中的干员记录，适合做「针对这一名干员」的入口（时装、技能开关都在这里）。卸下本 MOD 时自动消失 |
| `api.registerLobbyEntry({ id, Component })` | 在主界面**「01 模拟方式」两张模式卡下方**加一张自己的卡片（`Component` 自己管状态） |
| `api.registerShopOverride({ id, Component })` | 接管对局的**商店栏**：`Component` 收到本体 `ShopBar` 的全部 props；渲染 `<${ShopBar} ...${props} />`（从 `/js/ui/shopBar.js` 导入）即原样显示本体，渲染别的即替换 |
| `api.refreshBgm()` | 让本体按当前状态重新解析一次 BGM（配合 `setBgmOverride`：换曲、暂停、开关都用得上） |

### 在插件里用 React 式 hooks

因为页面已经配好 importmap，插件文件里可以直接：

```js
import { useState, useEffect } from 'preact/hooks';

export default {
  name: '计数器浮层',
  version: '1.0.0',
  setup(api) {
    api.registerOverlay(function Counter() {
      const [n, setN] = useState(0);
      return api.html`<div style=${{ position: 'fixed', right: '12px', top: '12px', zIndex: 9999, padding: '8px 12px', background: '#0c0f0e', color: '#4ed8af', border: '1px solid #2a5' }}
        >点击了 ${n} 次 <button onClick=${() => setN(n + 1)}>+1</button></div>`;
    });
  },
};
```

### 监听游戏状态变化

```js
export default {
  name: '进入房间提示',
  version: '1.0.0',
  setup(api) {
    api.store.subscribe((s) => {
      if (s.room && !s.room.__noticed) {
        api.toast('已进入同盟：' + (s.room.code || ''), 'info');
        s.room.__noticed = true; // 简易去重
      }
    });
  },
};
```

## 整合包（把多个插件打包成一个）

如果你有一组常一起开的插件（比如「新手友好包」= 盲盒模式 + 音乐盒 + 观战队友），可以把它们做成一个**整合包**，在标题页的「插件 MOD」面板里显示为**一个分组、一个总开关**——开包=旗下所有插件全开，关包=全关（原子切换，成员不可单独开关）。

做法：在 `public/mod/` 下建一个文件夹，放进各插件的 `.js` 文件，再写一个 `pack.json`：

```
public/mod/新手友好包/
├── pack.json          ← 整合包描述
├── 盲盒模式.js          ← 普通插件，和单独放时一模一样
├── 音乐盒.js
└── 观战队友.js
```

`pack.json` 最小写法：

```json
{
  "name": "新手友好包",
  "author": "your-name",
  "description": "盲盒模式 + 音乐盒 + 观战队友，一键开整。",
  "mods": ["盲盒模式", "音乐盒", "观战队友"]
}
```

字段说明：

| 字段 | 作用 |
|---|---|
| `name` / `author` / `description` / `version` | 显示在整合包分组头上的元信息（同单个插件的 `name` 等） |
| `id` | 可选；不写则回落文件夹名。改名不影响各成员的启用记录（成员仍按自己的 `id` 记） |
| `mods` | **成员列表**：字符串数组，每个是文件夹内某个 `.js` 的文件名（不含 `.js`；也支持 `某个目录/index.js` 这种子目录式插件）。不存在的文件会被跳过 |
| `conflicts` | 可选；填其它整合包的 `id`，开启本包时会自动关掉冲突包（与单个插件的 `conflicts` 同机制、同张互斥表） |

规则：

- 整合包文件夹里的成员**不会**再被当成独立插件散列在列表里——它们只以「整合包成员」出现。
- 整合包对所有玩家生效（放进服务器 `public/mod/` 即全员可见），刷新页面即可加载，无需重启服务器。
- 整合包是**纯分组 + 总开关**：成员本身是普通插件，照样能各自声明 `setup` / `server` 钩子、互斥等。
- 本地 MOD（在「MOD 管理」里拖 `.js` 添加）暂不支持打进整合包；整合包走文件夹方式。

## 注意事项

- 插件在浏览器里以原生 ES 模块运行，**可以直接 `import` 项目已有的模块**（例如 `import { t } from '/js/...'`），也能用 `import { useState } from 'preact/hooks'`。
- 一个插件抛错**不会**影响其他插件或游戏本体，只会在首页面板里标红。
- 插件只能改**客户端**表现（UI、提示、数据展示）。战斗结果由服务器确定性模拟得出，客户端 mod 无法改动对局数值——这正是本作「公平可回放」的设计。
- 这是为方便大家做 MOD / 二次创作而加的本地扩展点；对外分发修改后的版本时，请遵守项目的 GPL-3.0 与游戏 IP 相关约定。

把你的第一个 `.js` 丢进来，刷新，看到左下角「插件 MOD」面板里多出它，就说明整套机制通了。
