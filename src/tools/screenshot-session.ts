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
  try {
    const canvasMod = await import("canvas");
    createCanvas = canvasMod.createCanvas;
  } catch {
    return { error: "canvas package not available" };
  }

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
  const fontFamily = "Menlo";
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

  for (let row = 0; row < rawLines.length; row++) {
    const line = rawLines[row];
    if (!line) continue;

    let col = 0;
    let fg = defaultFg;
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
            if (c === 0) { fg = defaultFg; bold = false; }
            else if (c === 1) { bold = true; }
            else if (c === 22) { bold = false; }
            else if (c >= 30 && c <= 37) { fg = PALETTE[c - 30 + (bold ? 8 : 0)] ?? defaultFg; }
            else if (c === 39) { fg = defaultFg; }
            else if (c === 38 && codes[j + 1] === 5) { fg = PALETTE[codes[j + 2]] ?? defaultFg; j += 2; }
            else if (c === 38 && codes[j + 1] === 2) { fg = rgbToHex(codes[j + 2], codes[j + 3], codes[j + 4]); j += 4; }
            j++;
          }
          i = end + 1;
          continue;
        }
      }

      // Draw character
      const ch = line[i];
      const x = padding.x + col * cellWidth;
      const y = padding.y + row * cellHeight;
      ctx.fillStyle = fg;
      if (bold) ctx.font = `bold ${fontSize}px ${fontFamily}`;
      else ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.fillText(ch, x, y);
      col++;
      i++;
    }
  }

  // Draw synthetic cursor bar.
  // Priority: current cursor if visible, then last-visible-cursor for
  // apps like Ink that rapidly show/hide. Both are 1-indexed.
  const visibleCursor = !terminal.isCursorHidden() ? cursor
    : terminal.getLastVisibleCursorPosition();
  if (visibleCursor) {
    const cursorCol = visibleCursor.col - 1;
    const cursorRow = visibleCursor.row - 1 - rawScreen.topOffset;
    if (cursorRow >= 0 && cursorRow < rows && cursorCol >= 0 && cursorCol <= cols) {
      const cx = padding.x + cursorCol * cellWidth;
      const cy = padding.y + cursorRow * cellHeight;
      ctx.fillStyle = "#f0f0f0";
      ctx.fillRect(cx, cy, scale * 2, cellHeight);
    }
  }

  // Export as PNG
  const pngBuffer = canvas.toBuffer("image/png");
  return { image_data: pngBuffer.toString("base64") };
}
