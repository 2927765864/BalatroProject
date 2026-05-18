/**
 * 类型安全的事件总线
 *
 * 使用方式：
 *   1. 在 src/game/events.ts 中声明 EventMap（事件名 -> payload 类型）。
 *   2. 用 `new EventBus<GameEvents>()` 得到一个具备完整类型推导的实例。
 *
 * 设计目标：
 *   - 子系统通信只通过事件，避免相互直接 import。
 *   - off/once 支持，便于场景切换时统一清理。
 */
export type EventHandler<T> = (payload: T) => void;

export class EventBus<EventMap extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof EventMap, Set<EventHandler<unknown>>>();

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);
    return () => this.off(event, handler);
  }

  once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    const wrapped: EventHandler<EventMap[K]> = (payload) => {
      this.off(event, wrapped);
      handler(payload);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler as EventHandler<unknown>);
    if (set.size === 0) this.handlers.delete(event);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    // 复制一份再迭代，避免 handler 中 off 自身导致集合突变。
    for (const h of [...set]) {
      (h as EventHandler<EventMap[K]>)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
