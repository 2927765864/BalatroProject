import type { Application, Container } from "pixi.js";

/**
 * 虚拟分辨率适配器
 *
 * 思路：
 *   - 所有 UI / 卡牌 / 视效都以 worldWidth × worldHeight（默认 1280×720）为坐标系。
 *   - 物理画布随窗口大小变化，但通过 stage.scale 等比缩放，让世界永远完整可见（contain）。
 *   - 多余的空间用背景色填充（letterbox），不再拉伸或撑破布局。
 *
 * 好处：
 *   - 卡牌动效、字体大小、按钮位置一次写定，跨设备表现一致。
 *   - 适合"桌面横屏为主"的产品定位。
 *
 * 提供 worldCenter / worldBounds 让业务层避免读 window.innerWidth。
 */
export interface ScalerOptions {
  worldWidth?: number;
  worldHeight?: number;
  mode?: "contain" | "cover";
}

export class Scaler {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly mode: "contain" | "cover";

  private currentScale = 1;

  constructor(opts: ScalerOptions = {}) {
    this.worldWidth = opts.worldWidth ?? 1280;
    this.worldHeight = opts.worldHeight ?? 720;
    this.mode = opts.mode ?? "contain";
  }

  /** 当前世界 -> 屏幕的缩放倍率，可用于决定纹理分辨率或字体加粗等。 */
  get scale(): number {
    return this.currentScale;
  }

  /** 世界中心点（世界坐标），UI 居中布局常用。 */
  get center(): { x: number; y: number } {
    return { x: this.worldWidth / 2, y: this.worldHeight / 2 };
  }

  /**
   * 把舞台缩放/居中到当前窗口。
   * 通常在 App 构造完成后调用一次，并在 resize 时再次调用。
   */
  apply(app: Application, root: Container): void {
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    app.renderer.resize(screenW, screenH);

    const sx = screenW / this.worldWidth;
    const sy = screenH / this.worldHeight;
    const s = this.mode === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);

    this.currentScale = s;
    root.scale.set(s);

    // 把世界画面在屏幕中心居中。
    root.position.set(
      (screenW - this.worldWidth * s) / 2,
      (screenH - this.worldHeight * s) / 2
    );
  }
}
