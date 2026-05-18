/**
 * 全局输入管理占位
 *
 * 当前版本卡牌点击/按钮直接绑在 PIXI 对象上。
 * 这里预留一个键盘快捷键的入口（空格出牌、X 弃牌、数字键选牌等），
 * 未来由 GameController 注册回调。
 */
export type KeyCallback = (e: KeyboardEvent) => void;

export class InputManager {
  private readonly keyDownMap = new Map<string, Set<KeyCallback>>();
  private attached = false;

  attach(): void {
    if (this.attached) return;
    window.addEventListener("keydown", this.handleKeyDown);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    window.removeEventListener("keydown", this.handleKeyDown);
    this.attached = false;
  }

  onKeyDown(key: string, cb: KeyCallback): () => void {
    const k = key.toLowerCase();
    let set = this.keyDownMap.get(k);
    if (!set) {
      set = new Set();
      this.keyDownMap.set(k, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const set = this.keyDownMap.get(e.key.toLowerCase());
    if (!set) return;
    for (const cb of set) cb(e);
  };
}
