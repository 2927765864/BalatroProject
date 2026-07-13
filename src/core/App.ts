import { Application, Container, UPDATE_PRIORITY } from "pixi.js";
import { Scaler } from "./Scaler";
import {
  flushDeferredTextureDestroy,
  tickDeferredTextureDestroy,
} from "./DeferredTextureDestroy";

/**
 * 引擎层封装
 *
 * 职责：
 *   - 创建 PIXI.Application（首选 WebGPU，自动降级 WebGL）。
 *   - 维护 worldRoot：所有渲染内容挂在 worldRoot 下，便于统一缩放。
 *   - 接管 ticker 并暴露 onUpdate(dt) 钩子。
 *   - 接管 window resize 并触发 Scaler.apply。
 *   - 延迟销毁 GPU 纹理，避免 WebGPU BindGroup 悬空引用导致黑屏。
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
  private renderGuardInstalled = false;

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
      // 背景：PIXI v8 的 GCSystem 会卸载闲置资源。ImageSource（图集）默认
      // autoGarbageCollect=true；Geometry/Buffer/ViewContainer 亦然。本项目还大量
      // 使用 generateTexture 烤 RenderTexture。与 WebGPU batch BindGroup 缓存组合时，
      // 过早 unload/destroy 会导致 BindGroup.resources 被置 null，下一帧崩溃黑屏：
      //   Cannot read properties of null (reading 'textureSource1')
      //
      // 自 PIXI v8.15.0 起统一用 gcActive 控制；关闭后不依赖自动回收。
      // 纹理释放由 View 侧 + DeferredTextureDestroy 显式管理。
      gcActive: false,
    });

    // 双保险：即便别处重新打开了 gc，也立刻关掉。
    try {
      const gc = (this.pixi.renderer as unknown as { gc?: { enabled: boolean } }).gc;
      if (gc) gc.enabled = false;
    } catch {
      // ignore
    }

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
      // 业务 update 之后、下一帧渲染之前推进延迟销毁计数。
      // 真正的 destroy 发生在"若干帧之后"，确保 batch BindGroup 已换掉。
      tickDeferredTextureDestroy();
    });

    this.installRenderGuard();
    document.addEventListener("visibilitychange", this.handleVisibility);

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

  /**
   * 页面从后台恢复时，强制标记场景结构脏，避免复用挂起期间失效的
   * WebGPU BindGroup / 指令集。
   */
  private readonly handleVisibility = (): void => {
    if (document.visibilityState !== "visible") return;
    this.forceSceneRebuild();
  };

  /**
   * 给 ticker 的 render 包一层 try/catch：BindGroup 悬空一类错误不再永久黑屏，
   * 而是强制重建指令集并跳过当帧，后续帧可自行恢复。
   *
   * 注意：TickerPlugin 在 init 时用 `ticker.add(this.render, this)` 登记的是当时的
   * 函数引用，只改 `app.render` 不会生效，必须 remove 后再 add 包装函数。
   */
  private installRenderGuard(): void {
    if (this.renderGuardInstalled) return;
    const app = this.pixi;
    const ticker = app.ticker;
    // 先摘掉 TickerPlugin 挂上的原始 render。
    ticker.remove(app.render, app);
    const originalRender = app.render.bind(app);
    const guardedRender = (): void => {
      try {
        originalRender();
      } catch (err) {
        console.error("[App] 渲染异常（已拦截，尝试恢复）:", err);
        this.forceSceneRebuild();
      }
    };
    app.render = guardedRender;
    // LOW 与 TickerPlugin 默认优先级一致，保证业务 update 先跑。
    ticker.add(guardedRender, app, UPDATE_PRIORITY.LOW);
    this.renderGuardInstalled = true;
  }

  /** 递归标记 render group 结构变化，迫使下一次渲染重建 batch。 */
  private forceSceneRebuild(): void {
    try {
      const stage = this.pixi.stage as unknown as {
        renderGroup?: { structureDidChange: boolean };
        parentRenderGroup?: { structureDidChange: boolean };
        enableRenderGroup?: () => void;
      };
      stage.enableRenderGroup?.();
      if (stage.renderGroup) stage.renderGroup.structureDidChange = true;
      if (stage.parentRenderGroup) stage.parentRenderGroup.structureDidChange = true;

      const walk = (node: { children?: unknown[]; renderGroup?: { structureDidChange: boolean }; parentRenderGroup?: { structureDidChange: boolean } }) => {
        if (node.renderGroup) node.renderGroup.structureDidChange = true;
        if (node.parentRenderGroup) node.parentRenderGroup.structureDidChange = true;
        const kids = node.children;
        if (!kids) return;
        for (const c of kids) walk(c as typeof node);
      };
      walk(this.pixi.stage as never);
    } catch {
      // ignore
    }
  }

  destroy(): void {
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.updaters.clear();
    flushDeferredTextureDestroy();
    this.pixi.destroy(true, { children: true });
  }
}
