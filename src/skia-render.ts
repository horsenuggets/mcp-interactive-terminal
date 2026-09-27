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
  const fontFamily = opts.fontFamily ?? "Menlo";
  // For emoji-presentation variation sequences ("<base> U+FE0F", e.g. ⚠️ ☑️),
  // the color glyph lives in the emoji font's cmap format-14 subtable. When the
  // bare base codepoint ALSO exists in an earlier mono family (e.g. Gridfit
  // Mono has U+26A0), skia-canvas resolves the whole cluster to that mono family
  // and never consults the emoji font's variation-sequence table — so the glyph
  // renders monochrome. Rendering VS16 cells with the emoji family first makes
  // the variation sequence resolve to the color glyph. (Terminals like Ghostty
  // pick the emoji font here via CoreText; this matches that.)
  const families = fontFamily.split(",").map((s) => s.trim()).filter(Boolean);
  // Put emoji families first, then the bundled EmojiFallback color font (so a
  // default Menlo-only stack still resolves VS16 color glyphs), then the mono
  // families. Dedupe in case the caller already named EmojiFallback.
  const userEmojiFamilies = families.filter((f) => /emoji/i.test(f));
  const monoFamilies = families.filter((f) => !/emoji/i.test(f));
  const emojiFirstFamily = [
    ...userEmojiFamilies,
    ...(userEmojiFamilies.some((f) => f === "EmojiFallback") ? [] : ["EmojiFallback"]),
    ...monoFamilies,
  ].join(", ");
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

  const defaultFg = theme.foreground;
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
      const bg = resolveColor(cell.bg, null);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(padding.x + col * cellWidth, padding.y + row * cellHeight, cellWidth * cell.width, cellHeight);
      }
      col += cell.width;
    }
  }
  for (let row = 0; row < cellRows.length; row++) {
    let col = 0;
    for (const cell of cellRows[row]!) {
      if (cell.chars !== " " && cell.chars !== "") {
        ctx.fillStyle = resolveColor(cell.fg, defaultFg) ?? defaultFg;
        // VS16 clusters need the emoji family first so the color variation
        // glyph is chosen over an earlier mono family's base glyph.
        const fam = cell.chars.includes("\ufe0f") ? emojiFirstFamily : fontFamily;
        ctx.font = `${cell.bold ? "bold " : ""}${fontSize}px ${fam}`;
        ctx.fillText(cell.chars, padding.x + col * cellWidth, padding.y + row * cellHeight);
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
