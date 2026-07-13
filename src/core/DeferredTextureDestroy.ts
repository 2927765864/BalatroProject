import type { Texture } from "pixi.js";

/**
 * 延迟销毁 GPU 纹理（RenderTexture / Texture）。
 *
 * 背景（WebGPU + PixiJS v8）：
 *   批渲染会把若干 TextureSource 打进一个 BindGroup，并缓存在
 *   `getTextureBatchBindGroup` 的模块级 cachedGroups 以及 batch.bindGroup 上。
 *   一旦对仍被 BindGroup 监听的 TextureSource 调用 destroy()，BindGroup 会把
 *   `resources` 置为 null；若当帧/下一帧 instruction set 仍复用该 BindGroup，
 *   就会在 BindGroupSystem._createBindGroup 读到
 *   `null.textureSource1` 而整帧崩溃（黑屏）。
 *
 *   表现上常见于：待机一段时间、呼吸文字持续重烤阴影、refreshArt 等路径上
 *   "立刻 destroy 旧 generateTexture 结果"。
 *
 * 策略：
 *   替换纹理后不要立刻 destroy(true)，而是排队，等若干渲染帧后再释放。
 *   足够让 Pixi 完成 structure rebuild / 换掉 batch.bindGroup。
 */

interface QueueItem {
  texture: Texture;
  /** 剩余等待帧数；每帧 tick 减 1，到 0 再 destroy。 */
  framesLeft: number;
}

const DEFAULT_FRAMES = 4;
const queue: QueueItem[] = [];
const queued = new WeakSet<object>();

/**
 * 排队延迟销毁。对同一 Texture 重复入队是幂等的。
 * @param texture 待销毁纹理（会 destroy(true) 连同 source）
 * @param frames 至少等待的渲染帧数
 */
export function deferDestroyTexture(
  texture: Texture | null | undefined,
  frames: number = DEFAULT_FRAMES,
): void {
  if (!texture || texture.destroyed) return;
  // Texture 实例作为对象键；destroyed 后不应再入队。
  const key = texture as unknown as object;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({
    texture,
    framesLeft: Math.max(1, frames | 0),
  });
}

/** 每帧调用一次（挂在 App ticker 上）。 */
export function tickDeferredTextureDestroy(): void {
  if (queue.length === 0) return;

  let write = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]!;
    item.framesLeft -= 1;
    if (item.framesLeft > 0) {
      queue[write++] = item;
      continue;
    }
    try {
      if (!item.texture.destroyed) {
        item.texture.destroy(true);
      }
    } catch {
      // 已被其它路径销毁或 GPU 上下文失效，忽略。
    }
  }
  queue.length = write;
}

/** 立即清空队列并销毁剩余纹理（用于 App.destroy / 组件 detach）。 */
export function flushDeferredTextureDestroy(): void {
  for (const item of queue) {
    try {
      if (!item.texture.destroyed) {
        item.texture.destroy(true);
      }
    } catch {
      // ignore
    }
  }
  queue.length = 0;
}
