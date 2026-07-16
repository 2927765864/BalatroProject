/**
 * 资源管理
 *
 * 当前职责：
 *   - 加载五张精灵图（卡牌正面 8BitDeck / 卡牌反面 Enhancers / 小丑牌 Jokers /
 *     盲注硬币 BlindChips / UI 筹码 chips）
 *   - 按 CardAtlas 中声明的行列切成子纹理，并提供按 (rank, suit) / (row, col) /
 *     jokerIndex / 盲注硬币帧序列 / UI 筹码图标 的查询接口
 *
 * 后续若再加图集（如特效），按同样的"加载 + 切片 + 索引"模式扩展即可。
 *
 * 设计要点：
 *   - 切出的 Texture 共享同一个 source（GPU 上只上传一次贴图）。
 *   - 业务侧拿到的是 Texture，可直接 new Sprite(texture)。
 *   - 路径用 new URL(..., import.meta.url)，Vite 构建期会替换为最终 hash URL。
 *     这样 resources/textures 不在 public/ 下也能被打包进 dist/。
 */
import { Assets, Rectangle, Texture } from "pixi.js";
import type { Rank, Suit } from "@domain/types";
import { CardAtlas } from "@render/CardSkin";
import { GameFonts } from "@ui/fonts";

const FRONT_URL = new URL(
  "../../resources/textures/8BitDeck_opt2.png",
  import.meta.url,
).href;

const BACK_URL = new URL(
  "../../resources/textures/Enhancers.png",
  import.meta.url,
).href;

const JOKER_URL = new URL(
  "../../resources/textures/Jokers.png",
  import.meta.url,
).href;

const BLIND_CHIPS_URL = new URL(
  "../../resources/textures/BlindChips.png",
  import.meta.url,
).href;

const CHIPS_URL = new URL(
  "../../resources/textures/chips.png",
  import.meta.url,
).href;

const NUMBER_FONT_URL = new URL(
  "../../resources/fonts/m6x11plus.ttf",
  import.meta.url,
).href;

const TEXT_FX_FONT_URL = new URL(
  "../../resources/fonts/NotoSans-Bold.ttf",
  import.meta.url,
).href;

export interface BackKey {
  row: number;
  col: number;
}

export class AssetManager {
  private readonly frontByCardKey = new Map<string, Texture>();
  private readonly backByKey = new Map<string, Texture>();
  private readonly jokerByIndex = new Map<number, Texture>();
  /** 盲注硬币动画帧（第一行自左向右）。 */
  private readonly blindChipCoinFrames: Texture[] = [];
  /** UI 筹码小图标（chips 图集 uiRow/uiCol 格）。 */
  private uiChipTexture: Texture | undefined;
  private loaded = false;

  /** 是否已经成功加载贴图。CardView/DeckView 在渲染前用它判断是否走精灵图分支。 */
  get isReady(): boolean {
    return this.loaded;
  }

  /** 加载并切分精灵图。重复调用幂等。 */
  async loadAll(): Promise<void> {
    if (this.loaded) return;

    try {
      await this.loadFonts();

      // 加载时直接指明 scaleMode=nearest，PIXI 会在 create source 阶段就用最近邻
      // 采样上传到 GPU。再加 autoGenerateMipmaps:false 防止缩小时被 mipmap 糊掉。
      // 像素美术的"清晰锐利"取决于这两项 + 上层 antialias:false（已在 App 里设）。
      const pixelLoadOpts = {
        data: {
          scaleMode: "nearest" as const,
          autoGenerateMipmaps: false,
        },
      };

      const [frontTex, backTex, jokerTex, blindChipsTex, chipsTex] =
        (await Promise.all([
          Assets.load({ src: FRONT_URL, ...pixelLoadOpts }),
          Assets.load({ src: BACK_URL, ...pixelLoadOpts }),
          Assets.load({ src: JOKER_URL, ...pixelLoadOpts }),
          Assets.load({ src: BLIND_CHIPS_URL, ...pixelLoadOpts }),
          Assets.load({ src: CHIPS_URL, ...pixelLoadOpts }),
        ])) as [Texture, Texture, Texture, Texture, Texture];

      // 双保险：有的 PIXI 版本会忽略 data，所以这里再强制写一次 source.scaleMode。
      this.applyPixelSampling(frontTex);
      this.applyPixelSampling(backTex);
      this.applyPixelSampling(jokerTex);
      this.applyPixelSampling(blindChipsTex);
      this.applyPixelSampling(chipsTex);

      // ImageSource 默认 autoGarbageCollect=true；即便 App 关了 GCSystem，
      // 也显式关掉，防止图集 source 被意外 unload 后 batch BindGroup 悬空。
      frontTex.source.autoGarbageCollect = false;
      backTex.source.autoGarbageCollect = false;
      jokerTex.source.autoGarbageCollect = false;
      blindChipsTex.source.autoGarbageCollect = false;
      chipsTex.source.autoGarbageCollect = false;

      // 小丑图集卡面是烤死的纯白底，会盖住 CardView 里的 faceColor 圆角底。
      // 把手牌 8BitDeck 一样的透明底语义补上：纯白 → alpha=0，露出 CONFIG.cardArt.faceColor。
      const jokerProcessed = this.makePureWhiteTransparent(jokerTex);
      this.applyPixelSampling(jokerProcessed);
      jokerProcessed.source.autoGarbageCollect = false;

      this.sliceFront(frontTex);
      this.sliceBack(backTex);
      this.sliceJokers(jokerProcessed);
      this.sliceBlindChips(blindChipsTex);
      this.sliceChips(chipsTex);

      this.loaded = true;
    } catch (err) {
      console.error("[AssetManager] 加载卡牌精灵图失败：", err);
      // 不抛，让游戏退化回程序化绘制，至少不会黑屏。
    }
  }

  /** 拿一张正面贴图。找不到返回 undefined（让 CardView 自己降级）。 */
  getFront(rank: Rank, suit: Suit): Texture | undefined {
    return this.frontByCardKey.get(this.frontKey(rank, suit));
  }

  /** 拿一张背面贴图。越界自动回落到默认背面。 */
  getBack(row: number, col: number): Texture | undefined {
    const tex = this.backByKey.get(this.backKey(row, col));
    if (tex) return tex;
    return this.backByKey.get(
      this.backKey(CardAtlas.back.defaultRow, CardAtlas.back.defaultCol),
    );
  }

  /**
   * 拿一张小丑牌贴图。index 为 row-major 0 基索引（0 = 左上角第一张）。
   * 越界或未加载时返回 undefined。
   */
  getJoker(index: number): Texture | undefined {
    return this.jokerByIndex.get(index);
  }

  /** 小丑图集总格数（cols × rows）。 */
  get jokerCount(): number {
    return CardAtlas.joker.cols * CardAtlas.joker.rows;
  }

  /**
   * 盲注硬币动画帧序列（BlindChips 第 coinRow 行，自左向右 coinFrameCount 帧）。
   * 未加载或切片失败时返回空数组。
   */
  getBlindChipCoinFrames(): readonly Texture[] {
    return this.blindChipCoinFrames;
  }

  /**
   * HUD 筹码小图标（chips 图集 uiRow/uiCol，默认第一行第一列）。
   * 未加载时返回 undefined。
   */
  getUiChipTexture(): Texture | undefined {
    return this.uiChipTexture;
  }

  /** 列出所有背面格子，给 ControlPanel 做选择器用。 */
  listBackKeys(): BackKey[] {
    const out: BackKey[] = [];
    for (let r = 0; r < CardAtlas.back.rows; r += 1) {
      for (let c = 0; c < CardAtlas.back.cols; c += 1) {
        out.push({ row: r, col: c });
      }
    }
    return out;
  }

  /** 给 ControlPanel 展示用：背面图源 URL。 */
  get backSrc(): string {
    return BACK_URL;
  }

  // ---- 内部 ----

  /**
   * 把贴图配置成"像素艺术友好"的采样：
   *   - scaleMode = nearest：放大用最近邻，硬边不糊。
   *   - autoGenerateMipmaps = false：避免缩小时被 mipmap 平均成糊状。
   * 直接改 source，所有共享同一 source 的子纹理都受益。
   */
  private applyPixelSampling(tex: Texture): void {
    const source = tex.source;
    source.scaleMode = "nearest";
    source.autoGenerateMipmaps = false;
    // 触发 styleChange，让渲染器重新绑定 sampler。
    source.style.update();
  }

  private async loadFonts(): Promise<void> {
    if (typeof FontFace === "undefined" || typeof document === "undefined") return;

    try {
      // 加载数字字体
      const numAlreadyLoaded = Array.from(document.fonts).some(
        (font) => font.family === GameFonts.numberFamily && font.status === "loaded",
      );
      if (!numAlreadyLoaded) {
        const face = new FontFace(GameFonts.numberFamily, `url(${NUMBER_FONT_URL})`);
        const loadedFace = await face.load();
        document.fonts.add(loadedFace);
      }

      // 加载文字视效字体
      const textFxAlreadyLoaded = Array.from(document.fonts).some(
        (font) => font.family === GameFonts.textFxFamily && font.status === "loaded",
      );
      if (!textFxAlreadyLoaded) {
        const face = new FontFace(GameFonts.textFxFamily, `url(${TEXT_FX_FONT_URL})`);
        const loadedFace = await face.load();
        document.fonts.add(loadedFace);
      }
    } catch (err) {
      console.warn("[AssetManager] 加载字体失败：", err);
    }
  }

  private sliceFront(source: Texture): void {
    const { cols, rows, rankOrder, suitRows } = CardAtlas.front;
    // 用 source 的真实尺寸算切片步长，避免与图片实际像素不符。
    const sw = source.width / cols;
    const sh = source.height / rows;

    for (let r = 0; r < rows; r += 1) {
      const suit = suitRows[r];
      if (!suit) continue;
      for (let c = 0; c < cols; c += 1) {
        const rank = rankOrder[c];
        if (!rank) continue;
        const frame = new Rectangle(c * sw, r * sh, sw, sh);
        const tex = new Texture({ source: source.source, frame });
        this.frontByCardKey.set(this.frontKey(rank, suit), tex);
      }
    }
  }

  private sliceBack(source: Texture): void {
    const { cols, rows } = CardAtlas.back;
    const sw = source.width / cols;
    const sh = source.height / rows;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const frame = new Rectangle(c * sw, r * sh, sw, sh);
        const tex = new Texture({ source: source.source, frame });
        this.backByKey.set(this.backKey(r, c), tex);
      }
    }
  }

  /** 按 10×16 网格切小丑图集，索引 = row * cols + col（左上角为 0）。 */
  private sliceJokers(source: Texture): void {
    const { cols, rows } = CardAtlas.joker;
    const sw = source.width / cols;
    const sh = source.height / rows;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const frame = new Rectangle(c * sw, r * sh, sw, sh);
        const tex = new Texture({ source: source.source, frame });
        this.jokerByIndex.set(r * cols + c, tex);
      }
    }
  }

  /**
   * 切 BlindChips 图集，并缓存硬币动画用的第一行帧序列。
   * 整表按 cols×rows 切片；业务目前只用 coinRow 的前 coinFrameCount 帧。
   */
  private sliceBlindChips(source: Texture): void {
    const { cols, rows, coinRow, coinFrameCount } = CardAtlas.blindChips;
    const sw = source.width / cols;
    const sh = source.height / rows;

    this.blindChipCoinFrames.length = 0;
    const row = Math.max(0, Math.min(rows - 1, coinRow));
    const count = Math.max(0, Math.min(cols, coinFrameCount));
    for (let c = 0; c < count; c += 1) {
      const frame = new Rectangle(c * sw, row * sh, sw, sh);
      const tex = new Texture({ source: source.source, frame });
      this.blindChipCoinFrames.push(tex);
    }
  }

  /**
   * 切 chips 图集，并缓存 HUD 用的默认筹码格（uiRow/uiCol）。
   */
  private sliceChips(source: Texture): void {
    const { cols, rows, uiRow, uiCol } = CardAtlas.chips;
    const sw = source.width / cols;
    const sh = source.height / rows;
    const row = Math.max(0, Math.min(rows - 1, uiRow));
    const col = Math.max(0, Math.min(cols - 1, uiCol));
    const frame = new Rectangle(col * sw, row * sh, sw, sh);
    this.uiChipTexture = new Texture({ source: source.source, frame });
  }

  /**
   * 把贴图中「纯白不透明」像素改为全透明。
   *
   * 用途：Jokers.png 的卡面底是烤死的 #FFFFFF，而手牌 8BitDeck 是透明底 +
   * CardView.drawSprite 先铺 CONFIG.cardArt.faceColor。
   * 打通纯白后，小丑与手牌共用同一条「卡面底色」路径；改 faceColor 会同时刷新。
   *
   * 仅匹配 RGB=255,255,255 且 A=255，避免误伤半透明抗锯齿边与灰色外缘描边。
   * 处理失败（无 resource / 跨域 canvas taint 等）时原样返回，不阻断加载。
   */
  private makePureWhiteTransparent(source: Texture): Texture {
    if (typeof document === "undefined") return source;

    const w = Math.max(1, Math.round(source.width));
    const h = Math.max(1, Math.round(source.height));
    const resource = source.source?.resource as CanvasImageSource | undefined;
    if (!resource) {
      console.warn("[AssetManager] joker 贴图无 resource，跳过白底透明化");
      return source;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return source;

      ctx.drawImage(resource, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i] === 255 &&
          data[i + 1] === 255 &&
          data[i + 2] === 255 &&
          data[i + 3] === 255
        ) {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(imageData, 0, 0);

      // skipCache=true：避免与原始 Assets 缓存的同 URL 纹理冲突。
      return Texture.from(canvas, true);
    } catch (err) {
      console.warn("[AssetManager] joker 白底透明化失败，保留原图：", err);
      return source;
    }
  }

  private frontKey(rank: Rank, suit: Suit): string {
    return `${rank}|${suit}`;
  }

  private backKey(row: number, col: number): string {
    return `${row}|${col}`;
  }
}

/**
 * 全局唯一的 AssetManager。
 * 之所以做成 module-level singleton，是因为 CardView / DeckView 等"被 PIXI 树
 * 持有的视图"在构造时就需要拿到纹理；如果通过参数层层下传，调用点会被污染。
 * 业务侧（main.ts）只需在启动期 await assets.loadAll() 即可。
 */
export const assets = new AssetManager();
