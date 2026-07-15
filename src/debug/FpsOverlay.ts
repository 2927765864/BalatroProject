import { Text } from "pixi.js";
import type { App } from "@core/App";
import { GameFonts } from "@ui/fonts";

/**
 * 屏幕右上角实时帧数（屏幕坐标，不受 worldRoot / Scaler 影响）。
 */
export function mountFpsOverlay(app: App): void {
  const text = new Text({
    text: "— FPS",
    style: {
      fontFamily: GameFonts.numberStack,
      fontSize: 18,
      fill: 0x00ff88,
      align: "right",
      dropShadow: {
        alpha: 0.85,
        angle: Math.PI / 4,
        blur: 2,
        color: 0x000000,
        distance: 1,
      },
    },
    resolution: Math.max(2, window.devicePixelRatio || 1),
  });
  text.anchor.set(1, 0);
  text.eventMode = "none";
  text.zIndex = 10_000;

  const stage = app.pixi.stage;
  stage.sortableChildren = true;
  stage.addChild(text);

  const pad = 12;
  const layout = (): void => {
    text.position.set(app.pixi.screen.width - pad, pad);
  };
  layout();
  app.onResize(layout);

  // 按时间窗口累计帧数再刷新，避免 ticker.FPS 逐帧抖动。
  const sampleMs = 500;
  let accMs = 0;
  let frames = 0;
  let lastShown = -1;

  app.onUpdate((deltaMS) => {
    accMs += deltaMS;
    frames += 1;
    if (accMs < sampleMs) return;

    const fps = Math.round((frames * 1000) / accMs);
    accMs = 0;
    frames = 0;
    if (fps === lastShown) return;
    lastShown = fps;
    text.text = `${fps} FPS`;
  });
}
