import { Texture } from "pixi.js";

const cache = new Map<string, Texture>();

export function getPixelOutlineTexture(
  widthPx: number,
  heightPx: number,
  radiusPx: number,
  color: number,
): Texture {
  const w = Math.max(1, Math.round(widthPx));
  const h = Math.max(1, Math.round(heightPx));
  const r = Math.max(0, Math.min(Math.round(radiusPx), Math.floor(Math.min(w, h) / 2)));
  const key = `${w}x${h}:${r}:${color.toString(16)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Texture.EMPTY;

  const image = ctx.createImageData(w, h);
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!isBorderPixel(x, y, w, h, r)) continue;
      const i = (y * w + x) * 4;
      image.data[i] = red;
      image.data[i + 1] = green;
      image.data[i + 2] = blue;
      image.data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  const texture = Texture.from(canvas, true);
  texture.source.scaleMode = "nearest";
  texture.source.autoGenerateMipmaps = false;
  texture.source.style.update();
  cache.set(key, texture);
  return texture;
}

function isBorderPixel(x: number, y: number, w: number, h: number, r: number): boolean {
  if (!insideRoundedRect(x, y, w, h, r)) return false;

  return (
    !insideRoundedRect(x - 1, y, w, h, r) ||
    !insideRoundedRect(x + 1, y, w, h, r) ||
    !insideRoundedRect(x, y - 1, w, h, r) ||
    !insideRoundedRect(x, y + 1, w, h, r)
  );
}

function insideRoundedRect(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (r <= 0) return true;

  const px = x + 0.5;
  const py = y + 0.5;

  if (px < r && py < r) return insideCircle(px, py, r, r, r);
  if (px >= w - r && py < r) return insideCircle(px, py, w - r, r, r);
  if (px < r && py >= h - r) return insideCircle(px, py, r, h - r, r);
  if (px >= w - r && py >= h - r) return insideCircle(px, py, w - r, h - r, r);
  return true;
}

function insideCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
