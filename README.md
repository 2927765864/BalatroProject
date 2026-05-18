# Balatro Project

一个用 PixiJS v8（WebGPU 优先 / 自动降级 WebGL）实现的 Balatro 风格扑克 Roguelike 原型。
本仓库当前阶段为「重构后的可扩展骨架」：保留原型玩法（抽牌 / 选牌 / 出牌 / 弃牌 / 牌型计分），
并把代码按职责拆分为可独立演进的子系统，为后续小丑牌、消耗品、tag、关卡系统等做铺垫。

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式（默认 http://localhost:5173）
npm run dev

# 3. 类型检查
npm run typecheck

# 4. 构建产物到 dist/
npm run build

# 5. 本地预览构建结果
npm run preview
```

> 浏览器要求：建议 Chrome 113+ / Edge 113+（支持 WebGPU）。不支持时会自动降级 WebGL。

---

## 技术栈

- **PixiJS v8**：渲染引擎，使用 WebGPU 优先模式。
- **TypeScript（strict 全开）**：所有源代码均为 `.ts`，类型契约贯穿事件总线、Store 与 domain 层。
- **Vite 5**：开发服务器 / 构建。`base` 已设为 `'./'`，便于部署到 GitHub Pages 等子路径。
- **零运行时依赖**（除 pixi.js 外）：补间、状态、事件、缩放适配均为自研轻量轮子。

---

## 项目结构

```
src/
├── main.ts              入口：装配 App + GameController
├── core/                与具体游戏无关的基础设施
│   ├── App.ts           PixiJS Application 封装
│   ├── EventBus.ts      类型安全事件总线
│   ├── Store.ts         极简状态容器
│   ├── Scaler.ts        虚拟分辨率（1280×720）等比缩放
│   ├── Layers.ts        渲染层级（zIndex）常量
│   ├── AssetManager.ts  资源管理（占位）
│   └── input/InputManager.ts  全局快捷键（占位）
├── tween/               动效库
│   ├── Easing.ts        缓动函数集
│   ├── Tween.ts         单条补间
│   └── TweenManager.ts  补间调度（接入 App.ticker）
├── domain/              纯逻辑（禁止 import PIXI）
│   ├── types.ts         CardData / HandTypeName / ScoreResult
│   ├── Deck.ts          标准 52 张 + 洗牌 + 抽牌 + 回收
│   ├── HandEvaluator.ts 牌型识别
│   └── Scoring.ts       计分管线（预留小丑牌钩子位）
├── render/              卡牌绘制
│   ├── CardSkin.ts      卡牌视觉参数
│   ├── CardView.ts      单张牌的 PIXI Container
│   ├── HandLayout.ts    手牌扇形排布算法
│   └── DeckView.ts      牌堆显示
├── ui/                  界面 UI
│   ├── theme.ts         全局主题
│   ├── HUD.ts           组装左侧面板 + 底部按钮 + 牌堆位置
│   └── components/      Panel / Button / ScorePanel
├── fx/                  视效
│   ├── CardFx.ts        卡牌移动 / 飞出
│   └── TextFx.ts        弹字（计分爆出的雏形）
└── game/                业务装配层
    ├── config.ts        游戏数值
    ├── events.ts        事件名 + payload 的 TS 契约
    └── GameController.ts 总控
```

更深入的分层职责、数据流与扩展点见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
未来要做的「轮子」清单与状态见 [`ROADMAP.md`](./ROADMAP.md)。

---

## 玩法（当前）

1. 进入即抽 8 张手牌。
2. 最多选 5 张组成牌型；选中后左侧实时显示牌型与"筹码 × 倍率"。
3. 「出牌」消耗一次出牌机会，按当前 `筹码 × 倍率` 累加总分；「弃牌」消耗一次弃牌机会。
4. 选中的牌飞回牌堆底，洗牌后补满 8 张。

---

## 重构相比原型的改动

- 拆分 624 行单文件为分层结构，删除全局变量。
- 引入虚拟分辨率（1280×720）+ 等比缩放：UI 与卡牌坐标不再读 `window.innerWidth`。
- 抽离 `TweenManager`：原来手写在 ticker 中的 lerp 收敛为缓动动画。
- 卡牌"数据（CardData）"与"视图（CardView）"严格解耦，未来加修饰器/小丑牌只动 domain。
- 事件总线（EventBus<GameEvents>）打通子系统通信，不需要相互直接 import。
