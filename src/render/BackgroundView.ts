/**
 * Full-screen paint-mix background.
 *
 * Mounted on the Pixi **stage** (not worldRoot) so it covers letterbox bars
 * created by Scaler contain-mode. Sized to the physical viewport and updated
 * on window resize via App.onResize.
 */

import { Container, Sprite, Texture } from "pixi.js";
import {
  CONFIG,
  BACKGROUND_THEMES,
  type BackgroundConfig,
  type BackgroundQuality,
  type BackgroundThemeId,
} from "@game/config";
import {
  BalatroBackgroundFilter,
  hexColorToRgba,
} from "@fx/BalatroBackgroundFilter";

export class BackgroundView extends Container {
  private readonly sprite: Sprite;
  private readonly filter: BalatroBackgroundFilter;
  private uTime = 0;
  private accumMs = 0;
  private paused = false;
  private shaderActive = false;
  private onVisibility: (() => void) | null = null;

  constructor(screenWidth: number, screenHeight: number) {
    super();
    this.label = "BackgroundView";
    this.eventMode = "none";
    this.sortableChildren = false;
    // Stage-space: do not inherit worldRoot scale/position.
    this.position.set(0, 0);
    this.scale.set(1);

    this.sprite = new Sprite(Texture.WHITE);
    this.sprite.label = "BackgroundSprite";
    this.sprite.eventMode = "none";
    this.sprite.position.set(0, 0);
    this.addChild(this.sprite);

    this.filter = new BalatroBackgroundFilter();
    this.coverScreen(screenWidth, screenHeight);
    this.syncFromConfig();
    this.installVisibilityPause();
  }

  /**
   * Cover the full physical viewport (CSS pixels). Call after every Scaler.apply / window resize.
   */
  coverScreen(screenWidth: number, screenHeight: number): void {
    const w = Math.max(1, Math.ceil(screenWidth));
    const h = Math.max(1, Math.ceil(screenHeight));
    this.sprite.width = w;
    this.sprite.height = h;
    this.position.set(0, 0);
    this.scale.set(1);
  }

  private installVisibilityPause(): void {
    this.onVisibility = () => {
      this.paused = document.hidden;
    };
    document.addEventListener("visibilitychange", this.onVisibility);
    this.paused = document.hidden;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  /** @deprecated use coverScreen — kept for call-site compatibility */
  resize(width: number, height: number): void {
    this.coverScreen(width, height);
  }

  /**
   * Apply theme colours into CONFIG.world.background when theme !== custom.
   */
  static applyThemeToConfig(theme: BackgroundThemeId): void {
    if (theme === "custom") return;
    const t = BACKGROUND_THEMES[theme];
    const bg = CONFIG.world.background;
    bg.theme = theme;
    bg.colour1 = t.colour1;
    bg.colour2 = t.colour2;
    bg.colour3 = t.colour3;
  }

  /** Read CONFIG and toggle filter / quality. */
  syncFromConfig(): void {
    const bg = CONFIG.world.background;
    const quality = this.resolveQuality(bg);
    const active = bg.enabled && quality !== "off";

    if (!active) {
      this.shaderActive = false;
      this.sprite.filters = null;
      this.sprite.visible = false;
      return;
    }

    this.sprite.visible = true;
    this.shaderActive = true;
    this.sprite.filters = [this.filter];

    if (quality === "low") {
      this.filter.resolution = 0.5;
    } else {
      this.filter.resolution = 1;
    }

    this.pushUniforms(bg, quality);
  }

  private resolveQuality(bg: BackgroundConfig): BackgroundQuality {
    if (!bg.enabled) return "off";
    return bg.quality;
  }

  private effectivePixelFac(bg: BackgroundConfig, quality: BackgroundQuality): number {
    let fac = bg.pixelSizeFac;
    if (quality === "low") fac = fac * 0.7;
    if (quality === "high") fac = Math.max(fac, 1200);
    return fac;
  }

  private pushUniforms(bg: BackgroundConfig, quality: BackgroundQuality): void {
    const t = this.uTime + bg.seedPhase;
    this.filter.applyUniforms({
      uTime: t,
      uSpinTime: t,
      uContrast: bg.contrast,
      uSpinAmount: bg.enableSpin ? bg.spinAmount : 0,
      uPixelFac: this.effectivePixelFac(bg, quality),
      uSpinEase: bg.spinEase,
      uZoom: bg.zoom,
      uLighting: bg.lighting,
      offsetX: bg.offsetX,
      offsetY: bg.offsetY,
      colour1: hexColorToRgba(bg.colour1),
      colour2: hexColorToRgba(bg.colour2),
      colour3: hexColorToRgba(bg.colour3),
    });
  }

  /**
   * Clear-color under the shader (should match felt so any 1px gap is invisible).
   */
  getClearColor(): number {
    const bg = CONFIG.world.background;
    if (bg.enabled && bg.quality !== "off") return bg.colour2;
    return CONFIG.world.backgroundColor;
  }

  isShaderActive(): boolean {
    return this.shaderActive;
  }

  update(dtMS: number): void {
    if (!this.shaderActive || this.paused) return;

    const bg = CONFIG.world.background;
    const quality = this.resolveQuality(bg);
    if (quality === "off") return;

    this.uTime += (dtMS / 1000) * bg.speed;

    const maxHz = Math.max(1, bg.maxUpdateHz);
    this.accumMs += dtMS;
    if (this.accumMs < 1000 / maxHz) return;
    this.accumMs = 0;

    this.pushUniforms(bg, quality);
  }

  override destroy(options?: boolean | { children?: boolean; texture?: boolean }): void {
    if (this.onVisibility) {
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.onVisibility = null;
    }
    this.sprite.filters = null;
    super.destroy(options);
  }
}
