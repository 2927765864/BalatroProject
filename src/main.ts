import { App } from "@core/App";
import { assets } from "@core/AssetManager";
import { GameController } from "@game/GameController";
import {
  applyCrtPreset,
  CONFIG,
  loadSavedConfig,
  loadShippingConfig,
  type CrtPresetId,
} from "@game/config";
import { uiHierarchy } from "@ui/hierarchy";
import { setupControlPanel } from "@/debug/ControlPanel";

/**
 * 入口
 *
 * 1. 从 localStorage 把上次保存的运行时参数合并进 CONFIG
 * 2. 创建 App（PixiJS + WebGPU + 虚拟分辨率适配）
 * 3. 启动 GameController 装配业务
 * 4. 启动调参面板（隐藏；连点左上角"调试" 3 次呼出）
 */
async function bootstrap(): Promise<void> {
  // 先尝试从 presets/shipping.json 载入项目默认的 shipping 预设参数
  await loadShippingConfig();

  // 再把本地保存的参数合并进 CONFIG，再用它启动引擎，
  // 这样背景色 / 世界尺寸等启动期才读一次的参数也能被 preset / 本地缓存覆盖。
  loadSavedConfig();

  const host = document.getElementById("app") ?? document.body;
  const app = new App({
    backgroundColor: CONFIG.world.backgroundColor,
    worldWidth: CONFIG.world.width,
    worldHeight: CONFIG.world.height,
    mountTo: host,
  });

  await app.init();

  // 让 hierarchy 里的组件（ShadowComponent 这种需要 generateTexture 的）
  // 能够拿到 renderer。注入一次就够，renderer 在整个进程内不变。
  uiHierarchy.setRenderer(app.pixi.renderer);
  uiHierarchy.setTicker(app.pixi.ticker);

  // 预加载卡牌精灵图（8BitDeck / Enhancers）。
  // 失败时 AssetManager 内部已捕获并打日志，CardView/DeckView 会自动退回程序化绘制。
  await assets.loadAll();

  const game = new GameController(app);
  game.start();

  document.getElementById("loading")?.remove();

  // 安装运行时调参面板。onChange 里集中处理"哪些参数需要主动 apply"。
  setupControlPanel({
    worldRoot: app.worldRoot,
    onChange(key) {
      // 大部分参数（手牌数、动画时长、hoverLift...）都是业务每次执行时
      // 直接读 CONFIG.xxx，改完即生效。这里只处理少数需要主动通知引擎的：

      // 动作型 key（不绑定 CONFIG 字段，仅作为 UI 触发的命令派发）：
      if (key === "action:toggleMode") {
        game.toggleMode();
        return;
      }

      // preset 整体载入：CONFIG.uiNodes 整张表被换了，需要把 hierarchy 也同步回灌。
      if (key === "*") {
        uiHierarchy.hydrateFromConfig(app.worldRoot);
      }

      // 程序化背景 / 清屏色：任何 world.background* 或 backgroundColor 变更都同步。
      if (
        key === "*" ||
        key === "world.backgroundColor" ||
        key.startsWith("world.background")
      ) {
        game.syncBackground();
      }

      // 全屏 CRT：preset 切换时先灌入 subtle/hard 数值，再 apply filter。
      if (key === "world.crt.preset") {
        applyCrtPreset(CONFIG.world.crt.preset as CrtPresetId);
      }
      if (key === "*" || key.startsWith("world.crt")) {
        game.syncCrt();
      }

      // 牌背切换：重画 DeckView。
      if (key === "*" || key.startsWith("cardArt.back")) {
        game.refreshDeckArt();
      }
      // 是否启用贴图：重建所有 CardView + DeckView。
      if (key === "*" || key === "cardArt.useSprites") {
        game.refreshHandArt();
        game.refreshDeckArt();
      }
      // 卡面底色 / 外缘描边色：颜色是在 view 构造时一次性写进 Graphics 的，
      // 改值后只能销毁重建。这里复用与 useSprites 同一条重建路径。
      if (
        key === "*" ||
        key === "cardArt.cornerRadius" ||
        key === "cardArt.faceColor" ||
        key === "cardArt.outlineColor"
      ) {
        game.refreshHandArt();
        game.refreshDeckArt();
      }

      // 手牌摆放参数（间距 / 弧形 / 扇形旋转）：只需重新摆位，不需重绘卡牌。
      // force:true 跳过 swap 弹性豁免，调参需要立即在所有牌上生效。
      if (key === "*" || key.startsWith("handLayout.")) {
        game.layoutHand({ force: true });
      }

      // 玩法区世界坐标（手牌整体 Y/水平偏移 + 牌堆 X/Y）。
      // 出牌结算区相对手牌 baseY / 中线，随 handBaseY / handOffsetX 一起动。
      if (key === "*" || key.startsWith("playfield.")) {
        game.refreshPlayfieldLayout();
      }

      // 小丑槽布局（间距 / 基准 X·Y / 槽位数）。
      // slotCount 变化需要重建实例；其余只重排位姿即可。
      if (key === "*" || key.startsWith("joker.")) {
        if (key === "*" || key === "joker.slotCount") {
          game.initJokers();
        } else {
          game.layoutJokers();
        }
      }

      // 无限出牌/弃牌开关：剩余次数为 0 时按钮处于 disable，
      // 切到开启后需要立刻刷新按钮使其可用（反向亦然）。
      if (key === "*" || key === "rules.unlimitedActions") {
        game.refreshActionButtons();
      }

      // 选中弹起像素改值：当前已选中牌的 y 是上次 layoutHand 写好的旧值，
      // 需要重新摆位让它们以新高度对齐（普通 moveTo 平滑过渡）。
      // 其余 select 上移/下移参数（启动速度/过冲/刚度）只影响下次触发的动画，
      // 即时读 CONFIG 即可，不需要主动 apply。
      if (key === "*" || key === "cardVisuals.selectRiseY") {
        game.layoutHand({ force: true });
      }
    },
  });

  // 开发期挂个全局调试入口，避免污染生产 API。
  if (import.meta.env.DEV) {
    (window as unknown as { __game?: GameController; __config?: typeof CONFIG }).__game = game;
    (window as unknown as { __config?: typeof CONFIG }).__config = CONFIG;
  }
}

bootstrap().catch((err) => {
  console.error("[bootstrap] 初始化失败", err);
  const el = document.getElementById("loading");
  if (el) el.textContent = "初始化失败，请查看控制台。";
});
