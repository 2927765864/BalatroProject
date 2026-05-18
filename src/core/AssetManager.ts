/**
 * 资源管理占位
 *
 * 当前版本卡牌全部由 Graphics + Text 程序化绘制，因此暂无资源。
 * 留下接口，未来切到纹理图集 / Spine / 音效时，整个项目只改这里。
 *
 * 计划接入：
 *   - PIXI.Assets.load(manifest)
 *   - 按场景 bundle 拆分（loading 进度可与 #loading DOM 联动）
 */
export class AssetManager {
  private readonly cache = new Map<string, unknown>();

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, value);
  }

  /** 占位：未来对接 PIXI.Assets。 */
  async loadAll(_manifest: Record<string, string> = {}): Promise<void> {
    return Promise.resolve();
  }
}
