/**
 * Shared skia-canvas renderer for a terminal session's screen.
 *
 * Reads the emulator grid (cell char + width + style) and paints it to a PNG
 * with skia-canvas, which — unlike xterm.js — renders sbix/COLR color fonts,
 * does full per-glyph system-font fallback, and lets wide glyphs overflow their
 * cell (drawn in a second pass over all backgrounds). Both the screenshot tool
 * and the live-viewer frame streamer render through this so they're identical.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { splitFontStack, unquoteFontFamily } from "./font-stack.js";
import { ghosttyFontFamilyStack } from "./ghostty-config.js";
import type { CellColorSpec, RenderCell, TerminalWrapper } from "./types.js";

const require = createRequire(import.meta.url);
// Loaded via createRequire so it works under "module": "Node16" without import
// attributes. Same source of truth as the Tauri viewer's theme.
const theme: {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  ansi16: string[];
} = require("./theme.json");

// First 16 colors come from the shared theme; 16-255 follow the xterm cube.
const PALETTE: string[] = [...theme.ansi16];
for (let i = 16; i < 232; i++) {
  const j = i - 16;
  const r = Math.round(((j / 36) % 6) * 51);
  const g = Math.round(((j / 6) % 6) * 51);
  const b = Math.round((j % 6) * 51);
  PALETTE.push(`rgb(${r},${g},${b})`);
}
for (let i = 232; i < 256; i++) {
  const v = (i - 232) * 10 + 8;
  PALETTE.push(`rgb(${v},${v},${v})`);
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * Whole-pixel bounds of a cell spanning `width` columns. Cell sizes are fractional, so
 * every cell edge is rounded with the same formula: neighbors share edges exactly, and
 * a cell's background and any block glyph over it cover the same pixels.
 */
export function cellPixelBounds(
  padding: { x: number; y: number },
  cellWidth: number,
  cellHeight: number,
  col: number,
  row: number,
  width: number,
): { b: number; l: number; r: number; t: number } {
  return {
    b: Math.round(padding.y + (row + 1) * cellHeight),
    l: Math.round(padding.x + col * cellWidth),
    r: Math.round(padding.x + (col + width) * cellWidth),
    t: Math.round(padding.y + row * cellHeight),
  };
}

/**
 * The colors to paint a cell with: its glyph color, and its background fill, or null
 * when the cell shows the canvas background. SGR 7 (inverse) swaps the two, with the
 * defaults taking each other's place, so an inverse cell with default colors fills
 * with the theme foreground and draws its glyph in the theme background. Terminal
 * UIs rely on this to draw shapes that have no glyph, like a block's missing upper
 * eighths.
 */
export function cellPaintColors(
  cell: Pick<RenderCell, "bg" | "fg" | "inverse">,
  resolve: (spec: CellColorSpec, fallback: string | null) => string | null,
  colors: { background: string; foreground: string },
): { bg: string | null; fg: string } {
  if (cell.inverse) {
    return {
      bg: resolve(cell.fg, colors.foreground) ?? colors.foreground,
      fg: resolve(cell.bg, colors.background) ?? colors.background,
    };
  }
  return { bg: resolve(cell.bg, null), fg: resolve(cell.fg, colors.foreground) ?? colors.foreground };
}

// Which of the four cell quadrants each Block-Elements quadrant glyph fills,
// ordered [upperLeft, upperRight, lowerLeft, lowerRight].
const QUADRANTS: Record<number, [boolean, boolean, boolean, boolean]> = {
  0x2596: [false, false, true, false], // ▖ lower left
  0x2597: [false, false, false, true], // ▗ lower right
  0x2598: [true, false, false, false], // ▘ upper left
  0x2599: [true, false, true, true], //   ▙ upper-left + lower-left + lower-right
  0x259a: [true, false, false, true], //  ▚ upper-left + lower-right
  0x259b: [true, true, true, false], //   ▛ upper-left + upper-right + lower-left
  0x259c: [true, true, false, true], //   ▜ upper-left + upper-right + lower-right
  0x259d: [false, true, false, false], // ▝ upper right
  0x259e: [false, true, true, false], //  ▞ upper-right + lower-left
  0x259f: [false, true, true, true], //   ▟ upper-right + lower-left + lower-right
};

/**
 * Draw a Block-Elements glyph (U+2580–U+259F) as filled rectangles snapped to
 * the cell's integer pixel bounds, instead of letting skia's `fillText` paint
 * the font glyph. The font draws each glyph inside its em box (fontSize tall),
 * which is smaller than the terminal cell in both axes, so stacked/adjacent
 * block cells leave thin seams — the "broken by horizontal/vertical lines" look
 * on solid mascots and bars. Painting rects that fill the whole cell makes the
 * cells tile seamlessly, matching how native terminals render these glyphs.
 *
 * `l`/`t`/`r`/`b` are the cell's already-rounded left/top/right/bottom pixel
 * bounds. Callers round with the same formula for every cell, so a cell's right
 * edge equals its neighbour's left edge exactly and no gap or overlap appears.
 * Returns true if the codepoint was a block element and was painted.
 */
export function drawBlockElement(ctx: any, cp: number, l: number, t: number, r: number, b: number): boolean {
  if (cp < 0x2580 || cp > 0x259f) return false;
  const w = r - l;
  const h = b - t;
  const mx = Math.round((l + r) / 2);
  const my = Math.round((t + b) / 2);
  // Upper half.
  if (cp === 0x2580) {
    ctx.fillRect(l, t, w, my - t);
    return true;
  }
  // Lower eighths through full block (U+2581 = 1/8 tall … U+2588 = full).
  if (cp >= 0x2581 && cp <= 0x2588) {
    const y = b - Math.round(((cp - 0x2580) / 8) * h);
    ctx.fillRect(l, y, w, b - y);
    return true;
  }
  // Left eighths (U+2589 = 7/8 wide … U+258F = 1/8 wide); U+258C is left half.
  if (cp >= 0x2589 && cp <= 0x258f) {
    const x = l + Math.round(((0x2590 - cp) / 8) * w);
    ctx.fillRect(l, t, x - l, h);
    return true;
  }
  // Right half.
  if (cp === 0x2590) {
    ctx.fillRect(mx, t, r - mx, h);
    return true;
  }
  // Shades: fill the whole cell at reduced alpha (light/medium/dark).
  if (cp >= 0x2591 && cp <= 0x2593) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * (cp === 0x2591 ? 0.25 : cp === 0x2592 ? 0.5 : 0.75);
    ctx.fillRect(l, t, w, h);
    ctx.globalAlpha = prev;
    return true;
  }
  // Upper one-eighth.
  if (cp === 0x2594) {
    ctx.fillRect(l, t, w, Math.round(h / 8));
    return true;
  }
  // Right one-eighth.
  if (cp === 0x2595) {
    const x = r - Math.round(w / 8);
    ctx.fillRect(x, t, r - x, h);
    return true;
  }
  // Quadrant glyphs.
  const q = QUADRANTS[cp];
  if (q) {
    if (q[0]) ctx.fillRect(l, t, mx - l, my - t);
    if (q[1]) ctx.fillRect(mx, t, r - mx, my - t);
    if (q[2]) ctx.fillRect(l, my, mx - l, b - my);
    if (q[3]) ctx.fillRect(mx, my, r - mx, b - my);
    return true;
  }
  return false;
}

let emojiFontRegistered = false;
function registerEmojiFontOnce(skiaMod: any): void {
  if (emojiFontRegistered) return;
  emojiFontRegistered = true;
  try {
    const url = new URL("./assets/TwemojiMozilla.ttf", import.meta.url);
    skiaMod.FontLibrary.use("EmojiFallback", [fileURLToPath(url)]);
  } catch {
    // ignore — emoji fall back to system fonts
  }
}

const registeredFontPaths = new Set<string>();
function registerSessionFonts(skiaMod: any, paths: string[] | undefined): void {
  if (!paths?.length) return;
  for (const p of paths) {
    if (registeredFontPaths.has(p)) continue;
    registeredFontPaths.add(p);
    try {
      skiaMod.FontLibrary.use([p]);
    } catch {
      // bad path / unreadable font: skip, fall back to system fonts
    }
  }
}

/**
 * Reorders a font stack so emoji families come first, then the bundled
 * EmojiFallback color font (so a default Menlo-only stack still resolves VS16
 * color glyphs), then the remaining families. Splitting is quote-aware, so a
 * quoted name containing a comma stays one family.
 */
export function emojiFirstFontStack(fontFamily: string): string {
  const entries = splitFontStack(fontFamily);
  const isEmoji = (entry: string) => /emoji/i.test(unquoteFontFamily(entry));
  const emojiEntries = entries.filter(isEmoji);
  const otherEntries = entries.filter((e) => !isEmoji(e));
  const hasFallback = emojiEntries.some((e) => unquoteFontFamily(e) === "EmojiFallback");
  return [...emojiEntries, ...(hasFallback ? [] : ["EmojiFallback"]), ...otherEntries].join(", ");
}

export interface RenderOptions {
  skiaMod: any;
  fonts?: string[];
  fontFamily?: string;
  /** Draw the red cursor indicator (screenshots do; live frames may skip). */
  drawCursor?: boolean;
  /** Trim blank rows for a tight image (screenshots). When false, render the
   *  full fixed viewport so the live-viewer window stays a stable size. */
  trim?: boolean;
}

/**
 * Render the given terminal's current screen to a PNG Buffer, or null if the
 * grid is unavailable (pipe mode). Both `screenshot_session` and the live
 * viewer's frame streamer call this so their output is pixel-identical.
 */
export function renderScreenToPng(terminal: TerminalWrapper, opts: RenderOptions): Buffer | null {
  const { skiaMod } = opts;
  registerEmojiFontOnce(skiaMod);
  registerSessionFonts(skiaMod, opts.fonts);

  const cursor = terminal.getCursorPosition();
  const screen = terminal.getScreenCells(opts.trim ?? true);
  if (!screen) return null;
  const { rows: cellRows, topOffset } = screen;

  const rowWidth = (row: RenderCell[]): number => {
    let w = 0;
    for (const cell of row) w += cell.width;
    return w;
  };
  const cols = Math.max(...cellRows.map(rowWidth), cursor ? cursor.col : 40, 1);
  const rows = cellRows.length;

  const scale = 2;
  const fontSize = 12 * scale;
  // Default to the user's Ghostty font stack so glyph choice (e.g. a text-style
  // ⏺ from a patch font instead of Apple Color Emoji) matches their terminal.
  const fontFamily = opts.fontFamily ?? ghosttyFontFamilyStack() ?? "Menlo";
  // For emoji-presentation variation sequences ("<base> U+FE0F", e.g. ⚠️ ☑️),
  // the color glyph lives in the emoji font's cmap format-14 subtable. When the
  // bare base codepoint ALSO exists in an earlier mono family (e.g. Gridfit
  // Mono has U+26A0), skia-canvas resolves the whole cluster to that mono family
  // and never consults the emoji font's variation-sequence table — so the glyph
  // renders monochrome. Rendering VS16 cells with the emoji family first makes
  // the variation sequence resolve to the color glyph. (Terminals like Ghostty
  // pick the emoji font here via CoreText; this matches that.)
  const emojiFirstFamily = emojiFirstFontStack(fontFamily);
  const cellWidth = 7.22 * scale;
  const cellHeight = 15 * scale;
  const padding = { x: 10 * scale, y: 8 * scale };

  const canvasWidth = Math.ceil(cols * cellWidth + padding.x * 2);
  const canvasHeight = Math.ceil(Math.max(rows, 1) * cellHeight + padding.y * 2);

  const canvas = new skiaMod.Canvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.textBaseline = "top";

  const resolveColor = (spec: CellColorSpec, fallback: string | null): string | null => {
    switch (spec.mode) {
      case "palette":
        return PALETTE[spec.index] ?? fallback;
      case "rgb":
        return rgbToHex((spec.value >> 16) & 0xff, (spec.value >> 8) & 0xff, spec.value & 0xff);
      default:
        return fallback;
    }
  };

  // Two passes — all backgrounds, then all glyphs — so a glyph is never clipped
  // by a later cell's background (wide-glyph overflow stays visible).
  for (let row = 0; row < cellRows.length; row++) {
    let col = 0;
    for (const cell of cellRows[row]!) {
      const { bg } = cellPaintColors(cell, resolveColor, theme);
      if (bg) {
        // Snap to the same pixel bounds block elements use, so a background never
        // pokes out past a block glyph drawn over it as an antialiased sliver.
        const r = cellPixelBounds(padding, cellWidth, cellHeight, col, row, cell.width);
        ctx.fillStyle = bg;
        ctx.fillRect(r.l, r.t, r.r - r.l, r.b - r.t);
      }
      col += cell.width;
    }
  }
  for (let row = 0; row < cellRows.length; row++) {
    let col = 0;
    for (const cell of cellRows[row]!) {
      if (cell.chars !== " " && cell.chars !== "") {
        ctx.fillStyle = cellPaintColors(cell, resolveColor, theme).fg;
        // SGR 2 (dim/faint): draw at half opacity, as most terminals do. Set
        // before both paths; drawBlockElement multiplies shade alpha onto it.
        ctx.globalAlpha = cell.dim ? 0.5 : 1;
        // Block Elements (U+2580–U+259F) are painted as rects that tile the
        // whole cell, so solid mascots and bars have no seams between cells.
        // Bounds are rounded with the same formula for every cell, so adjacent
        // edges line up exactly. Everything else goes through the font.
        const cp = cell.chars.length === 1 ? cell.chars.codePointAt(0)! : -1;
        const r = cellPixelBounds(padding, cellWidth, cellHeight, col, row, cell.width);
        if (cp >= 0x2580 && cp <= 0x259f && drawBlockElement(ctx, cp, r.l, r.t, r.r, r.b)) {
          ctx.globalAlpha = 1;
          col += cell.width;
          continue;
        }
        // VS16 clusters need the emoji family first so the color variation
        // glyph is chosen over an earlier mono family's base glyph.
        const fam = cell.chars.includes("\ufe0f") ? emojiFirstFamily : fontFamily;
        ctx.font = `${cell.bold ? "bold " : ""}${fontSize}px ${fam}`;
        ctx.fillText(cell.chars, padding.x + col * cellWidth, padding.y + row * cellHeight);
        ctx.globalAlpha = 1;
      }
      col += cell.width;
    }
  }

  if (opts.drawCursor !== false) {
    const cursorHidden = terminal.isCursorHidden();
    const visibleCursor = !cursorHidden ? cursor : null;
    if (visibleCursor) {
      const cursorCol = visibleCursor.col - 1;
      const cursorRow = visibleCursor.row - 1 - topOffset;
      if (cursorRow >= 0 && cursorRow < rows && cursorCol >= 0 && cursorCol <= cols) {
        const cx = padding.x + cursorCol * cellWidth;
        const cy = padding.y + cursorRow * cellHeight;
        const barW = scale * 2;
        const gap = 2 * scale;
        const bw = scale;
        const m = gap + bw;
        ctx.strokeStyle = "rgba(255, 70, 70, 0.5)";
        ctx.lineWidth = bw;
        ctx.strokeRect(cx - m + bw / 2, cy - m + bw / 2, barW + m * 2 - bw, cellHeight + m * 2 - bw);
        ctx.fillStyle = "#f0f0f0";
        ctx.fillRect(cx, cy, scale * 2, cellHeight);
      }
    }
  }

  return canvas.toBufferSync("png");
}
