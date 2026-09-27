import { describe, it, expect } from "vitest";
import { drawBlockElement } from "../src/skia-render.js";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

// Minimal ctx stand-in that records fillRect calls (with the alpha in effect)
// so tests can assert the exact geometry drawBlockElement paints.
function makeCtx() {
  const rects: Rect[] = [];
  const ctx = {
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, alpha: ctx.globalAlpha });
    },
  };
  return { ctx, rects };
}

// Cell bounds used across tests: a 10-wide, 20-tall cell at origin (10, 20).
const L = 10;
const T = 20;
const R = 20;
const B = 40;
const MX = 15;
const MY = 30;

describe("drawBlockElement", () => {
  it("ignores non-block codepoints", () => {
    const { ctx, rects } = makeCtx();
    expect(drawBlockElement(ctx, 0x41, L, T, R, B)).toBe(false);
    expect(rects).toHaveLength(0);
  });

  it("fills the whole cell for the full block", () => {
    const { ctx, rects } = makeCtx();
    expect(drawBlockElement(ctx, 0x2588, L, T, R, B)).toBe(true);
    expect(rects).toEqual([{ x: L, y: T, w: R - L, h: B - T, alpha: 1 }]);
  });

  it("fills the top half for the upper half block", () => {
    const { ctx, rects } = makeCtx();
    drawBlockElement(ctx, 0x2580, L, T, R, B);
    expect(rects).toEqual([{ x: L, y: T, w: R - L, h: MY - T, alpha: 1 }]);
  });

  it("fills the bottom half for the lower half block", () => {
    const { ctx, rects } = makeCtx();
    drawBlockElement(ctx, 0x2584, L, T, R, B);
    expect(rects).toEqual([{ x: L, y: MY, w: R - L, h: B - MY, alpha: 1 }]);
  });

  it("fills the left half for the left half block", () => {
    const { ctx, rects } = makeCtx();
    drawBlockElement(ctx, 0x258c, L, T, R, B);
    expect(rects).toEqual([{ x: L, y: T, w: MX - L, h: B - T, alpha: 1 }]);
  });

  it("fills the right half for the right half block", () => {
    const { ctx, rects } = makeCtx();
    drawBlockElement(ctx, 0x2590, L, T, R, B);
    expect(rects).toEqual([{ x: MX, y: T, w: R - MX, h: B - T, alpha: 1 }]);
  });

  it("scales lower eighths by the codepoint", () => {
    const { ctx, rects } = makeCtx();
    drawBlockElement(ctx, 0x2581, L, T, R, B); // lower one-eighth
    // (1/8) * 20 = 2.5 -> rounds to 3 tall, anchored to the bottom.
    expect(rects).toEqual([{ x: L, y: B - 3, w: R - L, h: 3, alpha: 1 }]);
  });

  it("applies reduced alpha for shade glyphs and restores it", () => {
    const { ctx, rects } = makeCtx();
    ctx.globalAlpha = 1;
    drawBlockElement(ctx, 0x2592, L, T, R, B); // medium shade
    expect(rects).toEqual([{ x: L, y: T, w: R - L, h: B - T, alpha: 0.5 }]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("draws only the filled quadrants for a three-quadrant glyph", () => {
    const { ctx, rects } = makeCtx();
    drawBlockElement(ctx, 0x2599, L, T, R, B); // ▙ upper-left + both lower
    expect(rects).toEqual([
      { x: L, y: T, w: MX - L, h: MY - T, alpha: 1 }, // upper left
      { x: L, y: MY, w: MX - L, h: B - MY, alpha: 1 }, // lower left
      { x: MX, y: MY, w: R - MX, h: B - MY, alpha: 1 }, // lower right
    ]);
  });

  it("handles and reports every block-element codepoint", () => {
    for (let cp = 0x2580; cp <= 0x259f; cp++) {
      const { ctx } = makeCtx();
      expect(drawBlockElement(ctx, cp, L, T, R, B)).toBe(true);
    }
  });

  // The seam bug this fix targets: adjacent cells must share an exact edge so
  // solid runs tile with no gap or overlap. Paint neighbouring full blocks with
  // the same fractional-then-rounded bounds the renderer uses and assert the
  // rects they produce actually meet edge-to-edge.
  it("tiles adjacent full blocks with no seam or overlap", () => {
    const cellW = 7.22 * 2;
    const cellH = 15 * 2;
    const px = 20;
    const py = 16;
    const bx = (col: number) => Math.round(px + col * cellW);
    const by = (row: number) => Math.round(py + row * cellH);

    // Horizontal neighbours (row 0, cols 0 and 1): cell 0's right edge must
    // land exactly on cell 1's left edge.
    const horiz = makeCtx();
    drawBlockElement(horiz.ctx, 0x2588, bx(0), by(0), bx(1), by(1));
    drawBlockElement(horiz.ctx, 0x2588, bx(1), by(0), bx(2), by(1));
    const [h0, h1] = horiz.rects;
    expect(h0!.x + h0!.w).toBe(h1!.x);

    // Vertical neighbours (col 0, rows 0 and 1): row 0's bottom edge must land
    // exactly on row 1's top edge.
    const vert = makeCtx();
    drawBlockElement(vert.ctx, 0x2588, bx(0), by(0), bx(1), by(1));
    drawBlockElement(vert.ctx, 0x2588, bx(0), by(1), bx(1), by(2));
    const [v0, v1] = vert.rects;
    expect(v0!.y + v0!.h).toBe(v1!.y);
  });
});
