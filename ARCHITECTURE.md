# 架构说明（ARCHITECTURE）

本文给新会话 / 新协作者一份"读完即可接手"的项目地图。读完应该能回答：

- 一帧画面是怎么从数据走到像素的？
- 想加一张新的小丑牌、新牌型、新动效，应该改哪几个文件？
- 什么时候用事件、什么时候直接调用？

---

## 1. 分层总览

```
                   ┌────────────────────────────┐
   用户输入 ───→   │   game/  GameController     │   ← 唯一持有"游戏怎么玩"的语义
                   └─────┬────────────┬──────────┘
              emit/on    │            │  调用
                ┌────────▼──┐   ┌─────▼──────────┐
                │  core/EventBus   ui/ HUD/Button │
                │  core/Store      render/CardView│
                └────────────┘   └────────────────┘
                                      │ 视觉
                                      ▼
                          ┌──────────────────┐
                          │  tween/  fx/      │
                          └────────┬──────────┘
                                   │ 写入 x/y/rotation
                                   ▼
                          ┌──────────────────┐
                          │  PixiJS Stage     │  ← core/App + Scaler
                          └──────────────────┘

   纯数据：domain/{Deck, HandEvaluator, Scoring}  ← 禁止 import PIXI
```

层与层之间的依赖只能"向下"：
- `game` 可以用 `core / tween / domain / render / ui / fx`
- `ui / render / fx` 可以用 `core / tween`
- `domain` 不能用任何上层
- `core` 不能用任何上层

---

## 2. 模块职责速查

| 路径                          | 职责                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `core/App.ts`                 | 创建 PIXI.Application、worldRoot、ticker、resize 钩子                |
| `core/Scaler.ts`              | 虚拟分辨率（1280×720）→ 屏幕等比缩放（contain）                       |
| `core/EventBus.ts`            | 类型安全订阅/广播；事件名见 `game/events.ts`                          |
| `core/Store.ts`               | 极简中心化状态容器（setState + subscribe）                            |
| `core/Layers.ts`              | zIndex 常量（Background/Deck/Hand/Card/UI/Fx/Popup）                  |
| `tween/Tween.ts`              | 单条补间；只操作目标对象的数值字段                                   |
| `tween/TweenManager.ts`       | 同对象同字段自动互斥；由 `App.onUpdate` 驱动                          |
| `tween/Easing.ts`             | Penner 风格缓动函数集                                                |
| `domain/types.ts`             | `Suit` / `Rank` / `CardData` / `ScoreResult` 等纯数据类型             |
| `domain/Deck.ts`              | 标准 52 张构造、Fisher-Yates 洗牌、抽牌、回收                         |
| `domain/HandEvaluator.ts`     | 牌型识别 + `HAND_TABLE`（筹码/倍率表）                                |
| `domain/Scoring.ts`           | `calculateScore`：基础筹码 + 卡牌筹码 → ×mult                         |
| `render/CardSkin.ts`          | 卡牌视觉参数（尺寸、字号、配色）                                     |
| `render/CardView.ts`          | 单张牌 PIXI Container：绘制 + hover/click 回调                       |
| `render/HandLayout.ts`        | 手牌扇形排布算法（输出每张牌的目标 x/y/rotation）                     |
| `render/DeckView.ts`          | 牌堆图形 + 数量文字                                                  |
| `ui/theme.ts`                 | 颜色 / 字号 / 字体常量                                               |
| `ui/components/Panel.ts`      | 圆角面板（可改尺寸）                                                 |
| `ui/components/Button.ts`     | 状态机按钮（normal/hover/down/disabled）                              |
| `ui/components/ScorePanel.ts` | 左侧得分/筹码/倍率/牌型/出牌弃牌                                     |
| `ui/HUD.ts`                   | 组装左侧侧栏、底部按钮、牌堆，提供手牌区域世界坐标范围                 |
| `fx/CardFx.ts`                | 卡牌移动 / 飞出（目标点 + 弹性绳 waitSettled；非位移仍可用 tween）     |
| `fx/TextFx.ts`                | 弹字（计分爆出雏形）                                                 |
| `game/config.ts`              | 数值（手牌数、出牌次数、目标分、动画时长）                            |
| `game/events.ts`              | `GameEvents` 事件契约                                                |
| `game/GameController.ts`      | 总控：抽牌、选牌、出牌、弃牌、刷新 UI                                |
| `motion/ElasticRopeMotion.ts` | 弹性绳子牵引移动核（纯力积分 + 角 springDamper，无 PIXI）；沙盒 `?scene=elastic-rope`；旋转阻尼见 `docs/elastic-rope-rotation-damping-plan.md` |
| `motion/CmosScreenShake.ts` | CMOS 屏幕震动纯核（三轴 SpringDamper1D + 速度冲量）；规格 `docs/cmos-screen-shake-plan.md` |
| `fx/ScreenShakeFx.ts` | `shakeRoot` 挂载与每帧写 x/y/rotation；玩法内容挂 `contentRoot` |
| `scenes/ElasticRopeSandboxScene.ts` | 单卡隔离沙盒：external 位姿 + 调参面板 `elasticRopeCard`       |

---

## 3. 数据流：一次"出牌"的完整路径

1. **用户点击「出牌」按钮**（`ui/components/Button.ts` 触发 `onClick`）
2. → `HUD` 转交给 `GameController.playSelected()`
3. → 读 `store.currentResult`，更新 `totalScore` / `plays`
4. → `bus.emit('round:play')` + `bus.emit('round:scoreChanged')`
5. → 调用 `CardFx.flyOut` 让选中牌飞出（写 `tween` 目标）
6. → `TweenManager` 在 `App.ticker` 每帧调用 `update(dt)`，缓动 `card.x/y/rotation`
7. → 数据侧 `Deck.recycle + shuffle`，然后 `drawToFull`
8. → 新牌触发 `layoutHand` → 再下发一批 tween → 重新摆位

UI 文本（牌型 / 总分 / 出牌次数）的更新是命令式的（`scorePanel.setXxx`），没有走 Store 订阅；
因为更新点很少且粒度细，命令式简单可控。Store 在这里主要是给"扩展系统"（例如未来读取 `state.hand` 计算修饰器）准备的接入口。

---

## 4. 扩展场景指南

### 4.1 加一张新的"小丑牌"

修改面：

1. `domain/types.ts`：加 `JokerData` 与 `JokerEffect` 接口。
2. `domain/Scoring.ts`：在 `calculateScore` 中遍历"当前已装备的 joker"，按时机调用其 effect（`beforeEvaluate / perCard / afterEvaluate`）。
3. 视图：在 `render/` 下新增 `JokerView.ts`；在 `ui/HUD.ts` 顶部加一条 joker 槽位条。
4. 事件：`game/events.ts` 加 `joker:added / joker:triggered`，让 `fx/` 里的视效订阅。

**不需要改的**：`core / tween / Button / Panel / CardView`。

### 4.2 加一个新牌型

只动 `domain/HandEvaluator.ts` 与 `HAND_TABLE`；UI 自动跟随。

### 4.3 加一种新动效（如计分爆出的"X1.5 mult"金色字）

- 视觉：在 `fx/TextFx.ts` 加一个新方法。
- 触发：在 `GameController.playSelected` 或某个 `bus.on('round:play')` 监听器里调用。

### 4.4 切到位图素材

- 改 `core/AssetManager.ts` 接入 `PIXI.Assets`。
- 改 `render/CardView.ts` 把 Graphics + Text 换成 Sprite。
- 其他层无感。

---

## 5. 约束与不变量

- **domain 层禁止 import PIXI / DOM**。这是单测、移植到 Worker 的前提。
- **render / ui 不直接读全局 `window`**：所有尺寸基于 `worldWidth/worldHeight`。
- **CardView 位移由弹性绳驱动**：每张牌内嵌 `ElasticRopeMotion`；流程层只 `setMoveTarget`，位姿在 `CardView.update` 中积分。`positionDriver: "external"` 为主场景默认。
- **同对象同字段的多条 tween 互斥**：`TweenManager.add` 会自动停掉冲突的旧 tween；位移坐标不应再与绳双写。
- **事件 payload 类型集中在 `game/events.ts`**：扩展事件 = 改这一处。

---

## 6. 已知简化（重构后仍然存在）

- 没有"出牌动画完成后才结算总分"的串行编排；目前出牌是即时加分 + 动画异步播。后续做"逐牌计分爆字"特效时会引入动画时间线。
- 牌堆位置目前固定在世界右下角；未来要做"洗牌动画 / 抽牌轨迹"时，会把 `DeckView` 当作世界锚点暴露给 fx。
- `Store` 暂未广泛使用 `subscribe`；当前规模直接命令式调用 HUD setter 更直观。
- 未做单元测试。`domain` 层因为纯逻辑，是最先适合接入测试的位置。
