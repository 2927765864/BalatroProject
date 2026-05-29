/**
 * 资源管理
 *
 * 当前职责：
 *   - 加载两张精灵图（卡牌正面 8BitDeck / 卡牌反面 Enhancers）
 *   - 按 CardAtlas 中声明的行列切成子纹理，并提供按 (rank, suit) / (row, col)
 *     的查询接口
 *
 * 后续若再加图集（如小丑牌、特效），按同样的"加载 + 切片 + 索引"模式扩展即可。
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
  private loaded = false;

  /** 是否已经成功加载贴图。CardView/DeckView 在渲染前用它判断是否走精灵图分支。 */
  get isReady(): boolean {
    return this.loaded;
  }

  /** 加载并切分两张精灵图。重复调用幂等。 */
  async loadAll(): Promise<void> {
    if (this.loaded) return;

    try {
      await this.loadFonts();

      // 加载时直接指明 scaleMode=nearest，PIXI 会在创建 source 阶段就用最近邻
      // 采样上传到 GPU。再加 autoGenerateMipmaps:false 防止缩小时被 mipmap 糊掉。
      // 像素美术的"清晰锐利"取决于这两项 + 上层 antialias:false（已在 App 里设）。
      const pixelLoadOpts = {
        data: {
          scaleMode: "nearest" as const,
          autoGenerateMipmaps: false,
        },
      };

      const [frontTex, backTex] = (await Promise.all([
        Assets.load({ src: FRONT_URL, ...pixelLoadOpts }),
        Assets.load({ src: BACK_URL, ...pixelLoadOpts }),
      ])) as [Texture, Texture];

      // 双保险：有的 PIXI 版本会忽略 data，所以这里再强制写一次 source.scaleMode。
      this.applyPixelSampling(frontTex);
      this.applyPixelSampling(backTex);

      this.sliceFront(frontTex);
      this.sliceBack(backTex);

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
