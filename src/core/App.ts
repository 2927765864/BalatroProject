import { Application, Container } from "pixi.js";
import { Scaler } from "./Scaler";

/**
 * 引擎层封装
 *
 * 职责：
 *   - 创建 PIXI.Application（首选 WebGPU，自动降级 WebGL）。
 *   - 维护 worldRoot：所有渲染内容挂在 worldRoot 下，便于统一缩放。
 *   - 接管 ticker 并暴露 onUpdate(dt) 钩子。
 *   - 接管 window resize 并触发 Scaler.apply。
 */
export interface AppOptions {
  backgroundColor?: number;
  worldWidth?: number;
  worldHeight?: number;
  mountTo?: HTMLElement;
}

export type UpdateCallback = (deltaMS: number, deltaTime: number) => void;

export class App {
  readonly pixi: Application;
  readonly scaler: Scaler;
  readonly worldRoot: Container;

  private readonly updaters = new Set<UpdateCallback>();
  private initialized = false;

  constructor(private readonly opts: AppOptions = {}) {
    this.pixi = new Application();
    this.scaler = new Scaler({
      worldWidth: opts.worldWidth,
      worldHeight: opts.worldHeight,
    });
    this.worldRoot = new Container();
    this.worldRoot.sortableChildren = true;
    this.worldRoot.label = "WorldRoot";
  }

  /** 异步初始化 Pixi。在用户的 main.ts 中 await。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.pixi.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: this.opts.backgroundColor ?? 0x4a8b66,
      preference: "webgpu",
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      // 开启几何抗锯齿：平滑 Graphics 绘制出的卡牌外缘 / 圆角。
      // 像素素材本身仍由 AssetManager 强制 scaleMode=nearest，内部像素不会因此变糊。
      antialias: true,
      // 允许亚像素位置渲染，以便文字等平滑移动。需要精确对齐的像素卡牌由各图层容器单独开启 roundPixels。
      roundPixels: false,
      // 关闭 PIXI 自动 GC（垃圾回收）。
      //
      // 背景：PIXI v8 在纹理或可渲染对象"闲置约 60s"后会自动卸载其 GPU 资源。但本项目用
      // generateTexture 烤了大量 RenderTexture（卡面 cardTexture、剪影 shadow 等），其 GPU
      // TextureView 可能仍被 PIXI 内部的 batch BindGroup 缓存（getTextureBatchBindGroup 的
      // 模块级 cachedGroups，该缓存在纹理销毁/卸载时不会失效）引用。一旦 GC 卸载了这种纹理，
      // 下一帧渲染会在 BindGroupSystem._createBindGroup 读到 null source 而崩溃（黑屏 +
      // Cannot read properties of null 'textureSource1'）——表现就是"待机约一分钟后突然黑屏"。
      //
      // ⚠️ 自 PIXI v8.15.0 起 GC 被重构为统一的 GCSystem，由 gcActive 控制；纹理与可渲染
      // 对象的回收都归它管。旧的 textureGCActive / renderableGCActive 已 deprecated：前者
      // 会在 init 时打印 deprecation 警告，后者的 init 根本不读取（设了也无效）。因此这里
      // 只保留 gcActive: false 即可彻底关闭自动回收，且不产生任何 deprecation 警告。
      //
      // 本游戏是单屏卡牌玩法，纹理生命周期已由各 View 手动管理（bakeCardTexture / refreshArt
      // / destroy 都显式 destroy 旧纹理），不依赖 PIXI 的自动 GC，关闭它最稳妥且无副作用。
      gcActive: false,
    });

    const mount = this.opts.mountTo ?? document.body;
    mount.appendChild(this.pixi.canvas);

    this.pixi.stage.addChild(this.worldRoot);
    this.pixi.stage.eventMode = "static";
    this.pixi.stage.hitArea = this.pixi.screen;
    this.scaler.apply(this.pixi, this.worldRoot);

    this.pixi.ticker.add((ticker) => {
      const dt = ticker.deltaTime;
      const dtMS = ticker.deltaMS;
      for (const fn of this.updaters) fn(dtMS, dt);
    });

    window.addEventListener("resize", this.handleResize);
    this.initialized = true;
  }

  /** 注册每帧回调，返回反注册函数。 */
  onUpdate(fn: UpdateCallback): () => void {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  private readonly handleResize = (): void => {
    this.scaler.apply(this.pixi, this.worldRoot);
  };

  destroy(): void {
    window.removeEventListener("resize", this.handleResize);
    this.updaters.clear();
    this.pixi.destroy(true, { children: true });
  }
}
