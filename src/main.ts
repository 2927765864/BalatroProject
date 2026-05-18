import { App } from "@core/App";
import { GameController } from "@game/GameController";
import { GameConfig } from "@game/config";

/**
 * 入口
 *
 * 1. 创建 App（PixiJS + WebGPU + 虚拟分辨率适配）
 * 2. 启动 GameController 装配业务
 * 3. 隐藏 loading
 */
async function bootstrap(): Promise<void> {
  const host = document.getElementById("app") ?? document.body;
  const app = new App({
    backgroundColor: GameConfig.world.backgroundColor,
    worldWidth: GameConfig.world.width,
    worldHeight: GameConfig.world.height,
    mountTo: host,
  });

  await app.init();

  const game = new GameController(app);
  game.start();

  document.getElementById("loading")?.remove();

  // 开发期挂个全局调试入口，避免污染生产 API。
  if (import.meta.env.DEV) {
    (window as unknown as { __game?: GameController }).__game = game;
  }
}

bootstrap().catch((err) => {
  console.error("[bootstrap] 初始化失败", err);
  const el = document.getElementById("loading");
  if (el) el.textContent = "初始化失败，请查看控制台。";
});
