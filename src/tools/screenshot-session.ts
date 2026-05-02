import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const screenshotSessionSchema = z.object({
  session_id: z.string().describe("The session ID to screenshot"),
});

export type ScreenshotSessionArgs = z.infer<typeof screenshotSessionSchema>;

// ANSI 256-color palette (first 16 colors matching our viewer theme)
const PALETTE: string[] = [
  "#7f7f7f", // 0 black (visible gray)
  "#ff5555", // 1 red
  "#50fa7b", // 2 green
  "#f1fa8c", // 3 yellow
  "#6272a4", // 4 blue
  "#ff79c6", // 5 magenta
  "#8be9fd", // 6 cyan
  "#f8f8f2", // 7 white
  "#6272a4", // 8 bright black
  "#ff6e6e", // 9 bright red
  "#69ff94", // 10 bright green
  "#ffffa5", // 11 bright yellow
  "#d6acff", // 12 bright blue
  "#ff92df", // 13 bright magenta
  "#a4ffff", // 14 bright cyan
  "#ffffff", // 15 bright white
];

// Fill 16-255 with standard 256-color palette
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
 * Returns the terminal cell width of a single codepoint: 0 (zero-width),
 * 1 (narrow), or 2 (wide). Covers emoji, CJK, and common zero-width ranges.
 * Not a full wcwidth implementation — sufficient for the rendering we do here.
 */
function codepointWidth(cp: number): 0 | 1 | 2 {
  // Control chars and DEL
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;
  // Zero-width
  if (
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x0300 && cp <= 0x036f)    // combining diacritics
  ) return 0;
  // Wide ranges (CJK + emoji-ish blocks)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa00 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) return 2;
  // Misc Symbols / Dingbats: width 2 if Emoji_Presentation=Yes
  if (cp >= 0x2600 && cp <= 0x27bf) {
    if (EMOJI_PRESENTATION_2600_27BF.has(cp)) return 2;
    return 1;
  }
  return 1;
}

const EMOJI_PRESENTATION_2600_27BF = new Set<number>([
  0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e,
  0x264f, 0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa,
  0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2,
  0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c,
  0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0,
  0x27bf,
]);

// Try to register Apple Color Emoji once. Cairo can't render its color
// bitmap tables but it does pick up the monochrome outlines, which is far
// better than Menlo's tofu boxes. Best-effort — silently ignore failures.
let emojiFontRegistered = false;
function registerEmojiFontOnce(canvasMod: any): void {
  if (emojiFontRegistered) return;
  emojiFontRegistered = true;
  const candidates = [
    "/System/Library/Fonts/Apple Color Emoji.ttc",
    "/Library/Fonts/Apple Color Emoji.ttc",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto/NotoColorEmoji.ttf",
  ];
  for (const path of candidates) {
    try {
      canvasMod.registerFont(path, { family: "EmojiFallback" });
      return;
    } catch {
      // try next
    }
  }
}

/**
 * Render the terminal buffer to a PNG image using node-canvas.
 * Reads cell data from xterm-headless and draws it with proper colors.
 */
export async function handleScreenshotSession(
  args: ScreenshotSessionArgs,
  sessionManager: SessionManager,
): Promise<{ image_data: string } | { error: string }> {
  const session = sessionManager.getSession(args.session_id);
  const terminal = session.terminal;

  if (terminal.mode !== "pty") {
    return { error: "Screenshot only available in PTY mode" };
  }

  // Dynamic import canvas (it's a native module)
  let createCanvas: (w: number, h: number) => any;
  let canvasMod: any;
  try {
    canvasMod = await import("canvas");
    createCanvas = canvasMod.createCanvas;
  } catch {
    return { error: "canvas package not available" };
  }
  registerEmojiFontOnce(canvasMod);

  // Access the xterm instance from the terminal wrapper
  // The wrapper exposes readScreen but we need the raw buffer for cell colors
  const screen = terminal.readScreen(false, false);
  const lines = screen.text.split("\n");

  // Get actual terminal dimensions from the cursor position or raw screen
  const cursor = terminal.getCursorPosition();
  const rawScreen = terminal.readScreen(false, true);
  const rawLines = rawScreen.text.split("\n");
  // Infer cols from the widest raw line (stripping ANSI), rows from line count
  const cols = Math.max(
    ...rawLines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").length),
    cursor ? cursor.col : 40,
  );
  const rows = rawLines.length;

  // Font metrics (Menlo 12pt) at 2x Retina scale
  const scale = 2;
  const fontSize = 12 * scale;
  const fontFamily = "Menlo, EmojiFallback";
  const cellWidth = 7.22 * scale;
  const cellHeight = 15 * scale;
  const padding = { x: 10 * scale, y: 8 * scale };

  const canvasWidth = Math.ceil(cols * cellWidth + padding.x * 2);
  const canvasHeight = Math.ceil(rows * cellHeight + padding.y * 2);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "top";

  const defaultFg = "#f0f0f0";
  const defaultBg: string | null = null;

  for (let row = 0; row < rawLines.length; row++) {
    const line = rawLines[row];
    if (!line) continue;

    let col = 0;
    let fg = defaultFg;
    let bg: string | null = defaultBg;
    let bold = false;
    let i = 0;

    while (i < line.length) {
      // Parse ANSI escape sequences
      if (line[i] === "\x1b" && line[i + 1] === "[") {
        const end = line.indexOf("m", i + 2);
        if (end !== -1) {
          const codes = line.slice(i + 2, end).split(";").map(Number);
          let j = 0;
          while (j < codes.length) {
            const c = codes[j];
            if (c === 0) { fg = defaultFg; bg = defaultBg; bold = false; }
            else if (c === 1) { bold = true; }
            else if (c === 22) { bold = false; }
            else if (c >= 30 && c <= 37) { fg = PALETTE[c - 30 + (bold ? 8 : 0)] ?? defaultFg; }
            else if (c === 39) { fg = defaultFg; }
            else if (c >= 40 && c <= 47) { bg = PALETTE[c - 40] ?? defaultBg; }
            else if (c === 49) { bg = defaultBg; }
            else if (c >= 90 && c <= 97) { fg = PALETTE[c - 90 + 8] ?? defaultFg; }
            else if (c >= 100 && c <= 107) { bg = PALETTE[c - 100 + 8] ?? defaultBg; }
            else if (c === 38 && codes[j + 1] === 5) { fg = PALETTE[codes[j + 2]] ?? defaultFg; j += 2; }
            else if (c === 38 && codes[j + 1] === 2) { fg = rgbToHex(codes[j + 2], codes[j + 3], codes[j + 4]); j += 4; }
            else if (c === 48 && codes[j + 1] === 5) { bg = PALETTE[codes[j + 2]] ?? defaultBg; j += 2; }
            else if (c === 48 && codes[j + 1] === 2) { bg = rgbToHex(codes[j + 2], codes[j + 3], codes[j + 4]); j += 4; }
            j++;
          }
          i = end + 1;
          continue;
        }
      }

      // Read a full codepoint (handle surrogate pairs) so emoji and other
      // astral chars don't get split.
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const advance = ch.length;
      const cw = codepointWidth(cp);

      if (cw === 0) {
        // Zero-width: draw on top of previous cell (no advance, no fill)
        i += advance;
        continue;
      }

      const x = padding.x + col * cellWidth;
      const y = padding.y + row * cellHeight;
      const widthPx = cellWidth * cw;

      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, widthPx, cellHeight);
      }

      ctx.fillStyle = fg;
      ctx.font = `${bold ? "bold " : ""}${fontSize}px ${fontFamily}`;
      ctx.fillText(ch, x, y);

      col += cw;
      i += advance;
    }
  }

  // Draw synthetic cursor bar with red outline indicator.
  // Only draw when cursor is visible. The last-visible-cursor fallback
  // is used by the viewer for Ink's rapid show/hide during rendering,
  // but screenshots should respect the current visibility state —
  // a deliberately hidden cursor (click-to-blur, selection outside
  // input box) should not appear in the screenshot.
  const cursorHidden = terminal.isCursorHidden();
  const visibleCursor = !cursorHidden ? cursor : null;
  if (visibleCursor) {
    const cursorCol = visibleCursor.col - 1;
    const cursorRow = visibleCursor.row - 1 - rawScreen.topOffset;
    if (cursorRow >= 0 && cursorRow < rows && cursorCol >= 0 && cursorCol <= cols) {
      const cx = padding.x + cursorCol * cellWidth;
      const cy = padding.y + cursorRow * cellHeight;
      // Red outline centered around cursor bar (barW wide) with uniform
      // gap between bar and inner border edge. Sharp corners, slightly
      // pastel red at 75% opacity.
      const barW = scale * 2; // cursor bar width in canvas pixels
      const gap = 2 * scale;  // space between bar and inner border edge
      const bw = scale;       // border width
      const m = gap + bw;     // total offset from bar edge
      ctx.strokeStyle = "rgba(255, 70, 70, 0.5)";
      ctx.lineWidth = bw;
      ctx.strokeRect(
        cx - m + bw / 2,
        cy - m + bw / 2,
        barW + m * 2 - bw,
        cellHeight + m * 2 - bw,
      );
      // Cursor bar
      ctx.fillStyle = "#f0f0f0";
      ctx.fillRect(cx, cy, scale * 2, cellHeight);
    }
  }

  // Export as PNG
  const pngBuffer = canvas.toBuffer("image/png");
  return { image_data: pngBuffer.toString("base64") };
}
