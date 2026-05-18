# ROADMAP

按你最初提出的"未来要造的轮子"逐项列出当前状态、对应代码位置、下一步要做的事。
打勾的项已经具备最小可用骨架，可以基于它继续扩展；空格的项需要从零开始。

---

## 规范化

### [x] 屏幕尺寸
- **现状**：`core/Scaler.ts` 提供 1280×720 虚拟分辨率 + contain 等比缩放。UI 与卡牌都使用世界坐标。
- **下一步**：
  - 加 `safeArea` 概念，给未来移动端留刘海/底部 home 条余量。
  - 暴露 `Scaler.worldToScreen / screenToWorld` 工具方法。

### [ ] 分享环境
- **现状**：未实现。当前只是 Vite 默认开发服务。
- **下一步**：
  - 决定分享形式：Cloudflare Pages / Vercel / GitHub Pages 静态部署。
  - 在 README 增加"如何分享一个可玩链接"的章节。

### [ ] git 部署
- **现状**：尚未 `git init`（按用户要求暂缓）。`.gitignore` 已准备好。
- **下一步**：
  - `git init` → 首次提交。
  - 增加 `.github/workflows/deploy.yml` 用 `actions/upload-pages-artifact` 部署到 GitHub Pages。
  - `vite.config.ts` 的 `base: './'` 已兼容子路径。

### [x] 重新对话一文理解项目
- **现状**：本项目根目录已具备三件套：
  - `README.md`：项目介绍 + 快速开始 + 玩法。
  - `ARCHITECTURE.md`：分层、模块职责、数据流、扩展场景、约束。
  - `ROADMAP.md`（本文件）：轮子清单与进度。
- **下一步**：
  - 每完成一个轮子，回来更新本文件的状态与新增的扩展点。

---

## 基础逻辑实现

### [x] 牌库 / 抽牌 / 弃牌 / 计分
- **代码位置**：`domain/Deck.ts`、`domain/HandEvaluator.ts`、`domain/Scoring.ts`、`game/GameController.ts`。
- **现状**：与原型一致；新增"纯数据 + 视图"分离，便于上层扩展。
- **下一步**：
  - 给 `Scoring` 加 `beforeEvaluate / perCard / afterEvaluate` 三个 hook 数组，准备插入小丑牌。
  - 在 `domain` 下加 `Game.ts`：管理回合制（盲注 / 关卡 / 胜负判定）。

---

## 牌的绘制

### [x] 程序化卡面（Graphics + Text）
- **代码位置**：`render/CardView.ts`、`render/CardSkin.ts`。
- **现状**：1 张牌 = 1 个 `Container`，包含背景 / 左上角文字 / 右下角倒置文字 / 中心大花色。
- **下一步**：
  - 把"中心大花色"换成花色 SVG/纹理，让红心方块更像扑克牌。
  - 增加"修饰器层"（Container 上方加 holo / foil / polychrome 等覆盖）。
  - 切到位图素材时改 `AssetManager + CardView`。

---

## 界面 UI 专项

### [x] 基础组件 + 左侧 HUD
- **代码位置**：`ui/components/{Panel,Button,ScorePanel}.ts`、`ui/HUD.ts`、`ui/theme.ts`。
- **现状**：通用 Panel / Button / ScorePanel，按钮已有 normal/hover/down/disabled 状态机。
- **下一步**：
  - 加 `TabBar / Dialog / Tooltip / ProgressBar` 组件。
  - 引入"屏幕"概念：标题屏 / 商店屏 / 结算屏（Container + 进/出场动画）。
  - 主题切换：让 `theme.ts` 支持运行时切换。

---

## 动效库

### [x] Tween + Easing + 调度
- **代码位置**：`tween/{Tween,Easing,TweenManager}.ts`。
- **现状**：链式 API，支持 delay / easing / onUpdate / onComplete；同字段互斥避免抖动。
- **下一步**：
  - 增加 `Timeline`：把多条 tween 串成序列（适合"逐牌计分爆出"）。
  - 增加 `Spring`：物理弹簧用于卡牌"拾起手感"。
  - 由 `App.ticker` 升级为 fixed-step（性能/可重放）。

---

## 卡牌逻辑专项

### [ ] 修饰器 / 强化 / 印记 / 封蜡（Enhancements / Editions / Seals）
- **现状**：未实现。`CardData` 仅含 rank/suit/value/chips。
- **下一步**：
  - 在 `domain/types.ts` 扩展 `CardData`：`enhancement?`, `edition?`, `seal?`。
  - 在 `domain/Scoring.ts` 的 hook 中按字段触发：玻璃牌额外 mult、钢牌额外 chips 等。
  - 视觉层在 `render/CardView` 顶部叠"修饰器层"。

### [ ] 小丑牌系统
- **现状**：未实现。
- **下一步**：
  - `domain/Joker.ts`：抽象 `Joker { id, name, effects: JokerEffect[] }`。
  - 装备槽与持久化（最多 5 个 joker）。
  - 触发时机与 `Scoring` 的 hook 对接。

### [ ] 消耗品 / Tag / Voucher
- **现状**：未实现。先把上面两项搞稳再做。

---

## 卡牌视效专项

### [x] 移动 / 飞出
- **代码位置**：`fx/CardFx.ts`。
- **现状**：`moveTo`、`flyOut` 两个最小动画。
- **下一步**：
  - 选中弹起改为带"轻微旋转 + 阴影"的复合动画。
  - 出牌时按选中顺序"逐张打到中央 → 翻转 → 击爆"的时间线（依赖 tween Timeline）。
  - 修饰器粒子（holo 流光、polychrome 渐变）作为单独 fx 模块。

---

## 文字视效专项

### [x] 弹字雏形
- **代码位置**：`fx/TextFx.ts`。
- **现状**：在指定位置弹出文字 + 上浮淡出。
- **下一步**：
  - "+X chips / X1.5 mult"复合弹字（蓝/红双色，依次出现）。
  - 字符逐字浮现（typewriter）。
  - 与 `Scoring` 的 hook 联动：每张牌触发一次小弹字。

---

## 工程基线

- [x] Vite + TypeScript strict
- [x] 路径别名（`@core/* @domain/*` 等）
- [x] 三件套文档
- [ ] ESLint + Prettier 配置（待加）
- [ ] 单元测试（`domain` 层最先接入，建议 vitest）
- [ ] CI（GitHub Actions：typecheck + build）
