import { Tween, type TweenTarget } from "./Tween";

/**
 * 由 App.ticker 驱动的补间管理器
 *
 * 关键能力：
 *   - 同对象同字段的多条 tween 自动互斥（新的开始时停掉冲突的旧 tween），避免抖动。
 *   - manager.update(dtMS) 由 App.onUpdate 调用一次即可。
 */
export class TweenManager {
  private readonly tweens = new Set<Tween<object>>();

  create<T extends object>(target: T): Tween<T> {
    const tween = new Tween<T>(target, (t) => {
      this.tweens.delete(t as unknown as Tween<object>);
    });
    return tween;
  }

  /**
   * 启动一条 tween 并自动停掉同对象、有字段冲突的旧 tween。
   */
  add<T extends object>(tween: Tween<T>): Tween<T> {
    const newKeys = new Set(tween.getKeys() as Array<string | number | symbol>);
    for (const t of [...this.tweens]) {
      if (t.target !== tween.target) continue;
      const overlap = t.getKeys().some((k) => newKeys.has(k as string | number | symbol));
      if (overlap) t.stop();
    }
    this.tweens.add(tween as unknown as Tween<object>);
    if (!tween.isRunning()) tween.start();
    return tween;
  }

  /** 便捷封装：tween(target).to(values, ms, ease).start(); 等价 add(create+to+start)。 */
  tween<T extends object>(
    target: T,
    values: TweenTarget<T>,
    durationMS: number
  ): Tween<T> {
    return this.add(this.create(target).to(values, durationMS));
  }

  update(dtMS: number): void {
    for (const t of [...this.tweens]) {
      t.step(dtMS);
    }
  }

  /** 停掉某个目标身上所有 tween。 */
  killOf(target: object): void {
    for (const t of [...this.tweens]) {
      if (t.target === target) t.stop();
    }
  }

  /**
   * 查询某个目标身上是否还有任何活跃 tween。
   * 用于状态自愈：若某个豁免标志（如 isSwapAnimating）残留，但实际已无 tween 在跑，
   * 可据此判定标志已失效，应当清零。
   */
  hasTweenFor(target: object): boolean {
    for (const t of this.tweens) {
      if (t.target === target && t.isRunning()) return true;
    }
    return false;
  }

  clear(): void {
    for (const t of [...this.tweens]) t.stop();
    this.tweens.clear();
  }
}
