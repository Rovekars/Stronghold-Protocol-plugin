# 卫戍协议：盟约 · Ausevay 改版

> 基于 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)（原版）的改版，由 B 站 UP 主 **Ausevay** 维护与增强。
> 原版玩法的一切都在：浏览器即开即玩的《明日方舟》「卫戍协议：盟约」同人复刻，单人或 1–4 人联机合作。

![license](https://img.shields.io/badge/code%20license-GPL--3.0--or--later-blue)
![node](https://img.shields.io/badge/node-22%20%7C%2024-339933)

## 🆕 在原版基础上新增

| 新增 | 说明 |
|---|---|
| **砸罐子（盲盒）模式** | 全新快节奏玩法：敌人全装在罐子里，砸开随机出敌人 / 道具 / 干员；无休整期，全程边作战边砸罐、部署与穿装。敌人按回合与权重动态刷新（同盟更容易出怪），R10+ 出现大首领，漏过小型首领额外扣 5 点目标生命值 |
| **全量敌人池 2137 种** | 原版 249 种 → **2137 种**，按移速 / 评分 / 模型可用性自动分层归档，罐子池随回合逐步解锁 |
| **AI 队友真实作战** | AI 队友会实际部署与作战（不再空场）；同盟模式下随时可点开队友战场观战，联防阶段照常自由操作 |
| **战斗中自由操作** | 砸罐子模式下晋升奖励随时可领、装备战斗中穿装 / 换装 / 退装、同名合成实时同步战斗单位、被击倒干员可主动撤离（保留再部署倒计时） |
| **插件与整合包系统** | `public/mod/` 下的插件即插即用；多个 MOD 可打包成文件夹式整合包（`pack.json`），标题页面板一键整体启停 + 冲突互斥 |
| **观战增强** | 战斗点击 uid 反查兜底、读档地形原样还原、装备拖拽取消自动回位等大量细节修复 |

## 原版功能

完整的一局流程（策略轮选 → 14 回合 → 结算称号）、4 种难度、112 名干员与 283 个技能、23 个盟约、装备与机变、自动作战（技能策略 / 阻挡接力 / 元素损伤）、联防、最终攻势与隐秘核心、断线重连、手机触屏支持等——细节见[原版 README](https://github.com/sganggs/Stronghold-Protocol#readme)。

## 快速开始

**环境**：Node.js 22 或 24（LTS）；素材约 460 MB 首次自动下载。

```bash
git clone https://github.com/Rovekars/Stronghold-Protocol-plugin.git
cd Stronghold-Protocol-plugin
npm install        # 安装依赖
npm run setup      # 检查环境并下载美术 / 音频素材（可中断、续传）
npm start          # 启动服务器：http://localhost:3000
```

- Windows 也可直接双击 `scripts\start-windows.bat`（首次自动装依赖、下载素材、开浏览器）。
- **联机**：把启动窗口列出的局域网地址（`http://192.168.x.x:3000`）或 4 位同盟密钥发给朋友即可；跨网络联机方式见 [docs/DEPLOY.md](docs/DEPLOY.md)。
- **常见问题**：`npm run doctor` 一键诊断（Node 版本 / 素材完整性 / 端口 / 防火墙）。

## 插件与整合包

把 `.js` 插件文件（或含 `index.js` 的文件夹）放进 `public/mod/`，标题页插件面板即可启用。多个 MOD 可以打包成整合包：建一个文件夹放 `pack.json`：

```json
{
  "name": "我的整合包",
  "author": "Ausevay",
  "mods": ["modA.js", "modB.js"]
}
```

整合包作为整体一键启停（成员不可单独开关），并与散装 MOD 共用冲突互斥表。详见 [public/mod/README.md](public/mod/README.md)。

## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与鹰角网络（Hypergryph）、Yostar **没有任何关系**，未获其授权或认可。
> - 《明日方舟》相关的名称、美术、音乐、音效、文本与数据版权归原权利人所有，**不适用** GPL；GPL 只覆盖本项目自己编写的代码。本仓库**不含任何素材文件**，运行前需通过 `npm run setup` 从公开镜像下载，仅限个人学习使用。
> - 仅供学习交流与个人非商业使用，**严禁任何形式的盈利**。权利人如认为侵权，请提 Issue，将**立即删除**相关内容。

## 致谢

- 原版项目：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 及其全部贡献者——本改版站在它的肩膀上。
- 游戏数据：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)；素材镜像：[yuanyan3060/ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource) 等；规则核对：[PRTS Wiki](https://prts.wiki/)。
- 库：PixiJS、pixi-spine、three.js、Preact + htm、ws（均 MIT）。完整清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 许可证

代码以 **GPL-3.0-or-later** 发布（[LICENSE](LICENSE)）；游戏素材不在许可范围内，使用限制见上方声明。
