// Contrast of an actual rendered control. Chromium's sRGB canvas also resolves CSS Color 4 values (e.g. oklch).
import type { Locator } from '@playwright/test';

export type ContrastPart = 'text' | 'placeholder' | 'edge' | 'fill';

export function contrastSample(locator: Locator, part: ContrastPart = 'text') {
  return locator.evaluate((el, part) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    type Pixel = [number, number, number, number];
    const pixel = (css: string): Pixel => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: Pixel, below: Pixel): Pixel => {
      const a = top[3] + below[3] * (1 - top[3]);
      if (!a) return [0, 0, 0, 0];
      const channel = (i: 0 | 1 | 2) => (top[i] * top[3] + below[i] * below[3] * (1 - top[3])) / a;
      return [channel(0), channel(1), channel(2), a];
    };
    const luminance = ([r, g, b]: Pixel) => {
      const linear = (v: number) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const style = getComputedStyle(el);
    if (part === 'edge' && (parseFloat(style.borderTopWidth) === 0 || style.borderTopStyle === 'none')) throw Error('Missing control border');
    const css = part === 'edge' ? style.borderTopColor : part === 'fill' ? style.backgroundColor : getComputedStyle(el, part === 'placeholder' ? '::placeholder' : null).color;
    let fg = pixel(css);
    let bg: Pixel = [0, 0, 0, 0];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      const surface = pixel(s.backgroundColor);
      if (node !== el || part !== 'fill') fg = over(fg, surface);
      if (node !== el || part === 'text' || part === 'placeholder') bg = over(bg, surface);
      fg[3] *= Number(s.opacity);
      bg[3] *= Number(s.opacity);
    }
    const canvas: Pixel = [255, 255, 255, 1];
    const foreground = over(fg, canvas);
    const background = over(bg, canvas);
    const [lo, hi] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    return { part, color: css, foreground: foreground.slice(0, 3).map(Math.round), background: background.slice(0, 3).map(Math.round), ratio: (hi! + 0.05) / (lo! + 0.05) };
  }, part);
}
