import { App } from "@core/App";
import { GameController } from "@game/GameController";
import { CONFIG, loadSavedConfig } from "@game/config";
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
  // 先把本地保存的参数合并进 CONFIG，再用它启动引擎，
  // 这样背景色 / 世界尺寸等启动期才读一次的参数也能被 preset 覆盖。
  loadSavedConfig();

  const host = document.getElementById("app") ?? document.body;
  const app = new App({
    backgroundColor: CONFIG.world.backgroundColor,
    worldWidth: CONFIG.world.width,
    worldHeight: CONFIG.world.height,
    mountTo: host,
  });

  await app.init();

  const game = new GameController(app);
  game.start();

  document.getElementById("loading")?.remove();

  // 安装运行时调参面板。onChange 里集中处理"哪些参数需要主动 apply"。
  setupControlPanel({
    onChange(key) {
      // 大部分参数（手牌数、动画时长、hoverLift...）都是业务每次执行时
      // 直接读 CONFIG.xxx，改完即生效。这里只处理少数需要主动通知引擎的：
      if (key === "*" || key === "world.backgroundColor") {
        try {
          // PixiJS v8: renderer.background.color 是 Color 对象，
          // 直接赋一个 number/string，它会内部解析。这里用 unknown 桥接
          // 是为了避开 readonly Color 的类型签名。
          (app.pixi.renderer.background as unknown as { color: number }).color =
            CONFIG.world.backgroundColor;
        } catch (err) {
          console.warn("[main] 应用背景色失败：", err);
        }
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
