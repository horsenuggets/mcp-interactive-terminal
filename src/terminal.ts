/**
 * Core terminal wrapper.
 *
 * Strategy:
 *   1. Try node-pty + xterm-headless (best: true PTY, clean rendered output)
 *   2. Fallback to child_process.spawn with pipes (works in sandboxed environments)
 *
 * The fallback loses PTY features (no terminal emulation, no resize) but
 * provides working interactive sessions in Claude Code's sandbox.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { eastAsianWidth } from "get-east-asian-width";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type CellColorSpec,
  type RenderCell,
  type TerminalWrapper,
} from "./types.js";
import { createViewerSocket } from "./viewer-socket.js";
import { renderScreenToPng } from "./skia-render.js";
import { detectPromptPattern, endsWithPrompt } from "./utils/output-detector.js";
import { stripAnsi } from "./utils/sanitizer.js";
import { wrapCommand, isSandboxActive } from "./sandbox.js";

const OUTPUT_SETTLE_MS = 300;

// Coalesce viewer frame renders. A burst of PTY writes schedules a single
// trailing render this many ms later, capping live-viewer output at ~30 fps
// while keeping the window responsive to fast-updating TUIs.
const VIEWER_FRAME_DEBOUNCE_MS = 33;

/**
 * Zero-width codepoints: control chars, joiners, variation selectors, and the
 * common combining-mark blocks. These contribute 0 cells and fold into the
 * preceding cell — matching how a legacy `wcwidth` treats them.
 */
function isZeroWidth(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x200d || cp === 0xfeff) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors (incl. VS16)
  if (cp >= 0x0300 && cp <= 0x036f) return true; // combining diacritical marks
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
  return false;
}

/**
 * Legacy per-codepoint width, mirroring the POSIX `wcwidth` that macOS ships
 * (and that zsh/Ghostty `grapheme-width-method = legacy` use): East Asian Wide
 * and emoji-presentation codepoints are 2 cells, everything else 1, and
 * variation selectors / combining marks are 0. Crucially there is NO grapheme
 * clustering, so `<base> U+FE0F` is `wcwidth(base) + 0` — e.g. `☑️` stays 1
 * cell, unlike the Unicode-grapheme tables that widen it to 2.
 */
function legacyWcwidth(cp: number): 0 | 1 | 2 {
  if (isZeroWidth(cp)) return 0;
  return eastAsianWidth(cp, { ambiguousAsWide: false }) as 1 | 2;
}

/**
 * A custom xterm Unicode provider implementing the legacy `wcwidth` model. It
 * reports zero-width codepoints with `shouldJoin` so they still fold into the
 * previous cell (keeping `☑️` a single 1-cell grapheme) without widening it.
 */
const LEGACY_UNICODE_PROVIDER = {
  version: "legacy",
  wcwidth: legacyWcwidth,
  charProperties(codepoint: number, _preceding: number): number {
    const width = legacyWcwidth(codepoint);
    // Bit layout matches xterm's UnicodeService.createPropertyValue: the width
    // occupies bits 1-2 and the shouldJoin flag bit 0. Zero-width marks set
    // shouldJoin so the emulator combines them into the preceding cell.
    const shouldJoin = width === 0 ? 1 : 0;
    return (width << 1) | shouldJoin;
  },
};

export interface TerminalOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Enable the viewer socket for this session. */
  viewer?: boolean;
}

/**
 * Create a terminal wrapper. Tries node-pty first, falls back to child_process.
 */
export async function createTerminal(options: TerminalOptions): Promise<TerminalWrapper> {
  try {
    return await createPtyTerminal(options);
  } catch (ptyErr) {
    console.error(`[mcp-terminal] node-pty failed (${ptyErr}), falling back to pipe mode`);
    return createPipeTerminal(options);
  }
}

// ─── PTY mode (node-pty + xterm-headless) ───────────────────────────

async function createPtyTerminal(options: TerminalOptions): Promise<TerminalWrapper> {
  // Dynamic imports — these are optional deps in pipe-fallback mode
  const pty = await import("node-pty");
  const xtermMod = await import("@xterm/headless");
  const Terminal = xtermMod.Terminal ?? (xtermMod as any).default?.Terminal;

  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  const xterm = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });

  // Character-width table. Modern terminals (Ghostty `unicode`, iTerm2,
  // WezTerm) use grapheme-cluster widths; the "15-graphemes" version matches
  // that (Emoji_Presentation glyphs = 2 cells, "<base> U+FE0F" = one 2-cell
  // cluster). Set MCP_TERMINAL_UNICODE_VERSION to pick a different table so a
  // session can mimic a specific terminal. Valid values: "15-graphemes"
  // (default), "15", "6", and "legacy" — the custom provider above that mirrors
  // macOS `wcwidth` / Ghostty `grapheme-width-method = legacy`, where
  // Emoji_Presentation glyphs are 2 cells but VS16 emoji (e.g. `☑️`) stay 1.
  const unicodeVersion =
    options.env?.MCP_TERMINAL_UNICODE_VERSION ??
    process.env.MCP_TERMINAL_UNICODE_VERSION ??
    "15-graphemes";
  try {
    if (unicodeVersion === "legacy") {
      xterm.unicode.register(LEGACY_UNICODE_PROVIDER);
    } else if (unicodeVersion !== "6") {
      const graphemesMod = await import("@xterm/addon-unicode-graphemes");
      xterm.loadAddon(new graphemesMod.UnicodeGraphemesAddon());
    }
    xterm.unicode.activeVersion = unicodeVersion;
  } catch (err) {
    console.error(
      `[mcp-terminal] could not activate Unicode width version ` +
        `"${unicodeVersion}" (${err}); falling back to the default table`,
    );
  }

  const ptyProcess = pty.spawn(options.command, options.args ?? [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env } as Record<string, string>,
  });

  let isAlive = true;
  let promptPattern: RegExp | null = null;
  let outputBuffer = "";
  let lastOutputTime = Date.now();

  // Viewer socket — created when explicitly requested or env var is set
  const viewerEnabled = options.viewer === true || process.env.MCP_TERMINAL_VIEWER === "true";
  const sessionId = Math.random().toString(36).slice(2, 10);
  const viewerSocket = viewerEnabled ? createViewerSocket(sessionId) : null;

  // Font config for the live viewer's skia frames. Reads the same env channel
  // the screenshot tool uses (some MCP clients drop new tool args but always
  // forward `env`), so the viewer and screenshots render with identical fonts.
  const viewerFontsRaw = options.env?.MCP_TERMINAL_SCREENSHOT_FONTS;
  const viewerFonts = viewerFontsRaw
    ? viewerFontsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const viewerFontFamily = options.env?.MCP_TERMINAL_SCREENSHOT_FONT_FAMILY;

  // Debounced skia frame renderer for the viewer. skia-canvas is a native
  // module loaded on first render and cached; if it can't load we simply stop
  // trying (the viewer stays blank rather than crashing the session).
  let skiaModCache: any = null;
  let skiaUnavailable = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let renderInFlight = false;
  let renderPending = false;

  async function renderViewerFrameNow(): Promise<void> {
    if (!viewerSocket || skiaUnavailable) return;
    if (renderInFlight) { renderPending = true; return; }
    renderInFlight = true;
    try {
      if (!skiaModCache) {
        try {
          skiaModCache = await import("skia-canvas");
        } catch {
          skiaUnavailable = true;
          return;
        }
      }
      const png = renderScreenToPng(wrapper, {
        skiaMod: skiaModCache,
        fonts: viewerFonts,
        fontFamily: viewerFontFamily,
        // Full fixed viewport so the viewer window stays a stable size instead
        // of growing row by row as output streams in.
        trim: false,
      });
      if (png) viewerSocket.writeFrame(png);
    } finally {
      renderInFlight = false;
      if (renderPending) {
        renderPending = false;
        scheduleViewerFrame();
      }
    }
  }

  function scheduleViewerFrame(): void {
    if (!viewerSocket || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      void renderViewerFrameNow();
    }, VIEWER_FRAME_DEBOUNCE_MS);
  }

  // Track the last cursor position where the app intended the cursor.
  // Parse raw PTY data for cursor-show (\x1b[?25h) and CUP (\x1b[row;colH)
  // sequences to capture the position the app set just before showing.
  let lastVisibleCursorPos: { col: number; row: number } | null = null;

  // Track cursor position from raw PTY data by parsing CUP sequences
  // (\x1b[row;colH) that appear before cursor-show (\x1b[?25h).
  // Also update on every write when the cursor is currently visible,
  // since apps may reposition without re-sending show.
  function trackCursorFromData(data: string): void {
    // If data contains cursor-show, capture position before it
    if (data.includes("\x1b[?25h")) {
      const showIdx = data.lastIndexOf("\x1b[?25h");
      const beforeShow = data.slice(0, showIdx);
      const cupRegex = /\x1b\[(\d+);(\d+)H/g;
      let lastMatch: RegExpExecArray | null = null;
      let match: RegExpExecArray | null;
      while ((match = cupRegex.exec(beforeShow)) !== null) {
        lastMatch = match;
      }
      if (lastMatch) {
        lastVisibleCursorPos = {
          col: parseInt(lastMatch[1], 10),
          row: parseInt(lastMatch[2], 10),
        };
      }
    }
  }

  ptyProcess.onData((data: string) => {
    trackCursorFromData(data);
    xterm.write(data, () => {
      // After xterm processes data, if cursor is currently visible,
      // update the last-visible position from xterm's buffer
      const hidden = (xterm as any)._core?.coreService?.isCursorHidden ?? false;
      if (!hidden) {
        const buf = xterm.buffer.active;
        lastVisibleCursorPos = { col: buf.cursorX + 1, row: buf.baseY + buf.cursorY + 1 };
      }
    });
    outputBuffer += data;
    lastOutputTime = Date.now();

    if (viewerSocket) {
      scheduleViewerFrame();
    }
  });

  // Wire the emulator's replies back to the PTY. xterm parses terminal
  // queries — DSR/CPR cursor-position reports (ESC[6n), Device Attributes
  // (ESC[c), etc. — and emits the answer through onData. Without forwarding
  // that answer to the PTY, any program that asks the terminal a question
  // (a `\x1b[6n` width probe, `tput`, some TUIs) hangs forever waiting for a
  // reply. We only ever feed input to the PTY directly (never via
  // xterm.input), so onData fires exclusively for these emulator-generated
  // replies, not for keystroke echo.
  const replyDisposable = xterm.onData((reply: string) => {
    if (!isAlive) return;
    try {
      ptyProcess.write(reply);
    } catch {
      // PTY may be mid-teardown; dropping a late reply is harmless.
    }
  });

  ptyProcess.onExit(() => {
    isAlive = false;
  });

  const wrapper: TerminalWrapper = {
    process: ptyProcess as any,
    pid: ptyProcess.pid,
    get isAlive() { return isAlive; },
    promptPattern,
    mode: "pty",
    get enterKey() { return "\r"; },

    write(data: string) {
      if (!isAlive) throw new Error("Session is not alive");
      outputBuffer = "";
      ptyProcess.write(data);
    },

    readScreen(fullScreen = false, rawAnsi = false): { text: string; topOffset: number } {
      const buffer = xterm.buffer.active;
      const lines: string[] = [];

      const getRows = (): { start: number; end: number } => {
        if (fullScreen) {
          return { start: -buffer.viewportY, end: buffer.length };
        }
        return { start: buffer.baseY, end: buffer.baseY + rows };
      };

      const { start, end } = getRows();

      if (!rawAnsi) {
        for (let i = start; i < end; i++) {
          const line = buffer.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
      } else {
        // Reconstruct ANSI escape codes from cell data
        for (let i = start; i < end; i++) {
          const bufLine = buffer.getLine(i);
          if (!bufLine) continue;
          let lineStr = "";
          let prevFg = -1, prevBg = -1, prevBold = 0, prevDim = 0, prevItalic = 0;
          const cell = (buffer as any).getNullCell ? (buffer as any).getNullCell() : undefined;
          for (let x = 0; x < bufLine.length; x++) {
            const c = cell ? (bufLine.getCell(x, cell), cell) : bufLine.getCell(x);
            if (!c) continue;
            const ch = c.getChars();
            const w = c.getWidth();
            if (w === 0) continue; // skip continuation cells

            // Build SGR sequences for style changes
            const sgr: string[] = [];
            const bold = c.isBold();
            const dim = c.isDim();
            const italic = c.isItalic();

            if (bold !== prevBold) sgr.push(bold ? "1" : "22");
            if (dim !== prevDim) sgr.push(dim ? "2" : "22");
            if (italic !== prevItalic) sgr.push(italic ? "3" : "23");

            // Foreground
            let fg = -1;
            if (c.isFgRGB()) {
              const v = c.getFgColor();
              fg = v;
              if (fg !== prevFg) sgr.push(`38;2;${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}`);
            } else if (c.isFgPalette()) {
              fg = c.getFgColor();
              if (fg !== prevFg) sgr.push(`38;5;${fg}`);
            } else if (!c.isFgDefault() || prevFg !== -1) {
              if (prevFg !== -1) { sgr.push("39"); fg = -1; }
            }

            // Background
            let bg = -1;
            if (c.isBgRGB()) {
              const v = c.getBgColor();
              bg = v;
              if (bg !== prevBg) sgr.push(`48;2;${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}`);
            } else if (c.isBgPalette()) {
              bg = c.getBgColor();
              if (bg !== prevBg) sgr.push(`48;5;${bg}`);
            } else if (!c.isBgDefault() || prevBg !== -1) {
              if (prevBg !== -1) { sgr.push("49"); bg = -1; }
            }

            if (sgr.length > 0) lineStr += `\x1b[${sgr.join(";")}m`;
            lineStr += ch || " ";

            prevFg = fg; prevBg = bg; prevBold = bold; prevDim = dim; prevItalic = italic;
          }
          // Reset at end of line
          if (prevFg !== -1 || prevBg !== -1 || prevBold || prevDim || prevItalic) {
            lineStr += "\x1b[0m";
          }
          lines.push(lineStr);
        }
      }

      while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim() === "") lines.pop();
      // Count and strip leading blank rows, report offset so callers can
      // compute real screen coordinates for mouse events.
      let topOffset = 0;
      while (lines.length > 0 && lines[0]!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") {
        lines.shift();
        topOffset++;
      }
      return { text: lines.join("\n"), topOffset };
    },

    getScreenCells(trim = true): { rows: RenderCell[][]; topOffset: number } | null {
      const buffer = xterm.buffer.active;
      const start = buffer.baseY;
      const end = buffer.baseY + rows;
      const cellObj = (buffer as any).getNullCell ? (buffer as any).getNullCell() : undefined;

      const fgSpec = (c: any): CellColorSpec =>
        c.isFgRGB()
          ? { mode: "rgb", value: c.getFgColor() }
          : c.isFgPalette()
            ? { mode: "palette", index: c.getFgColor() }
            : { mode: "default" };
      const bgSpec = (c: any): CellColorSpec =>
        c.isBgRGB()
          ? { mode: "rgb", value: c.getBgColor() }
          : c.isBgPalette()
            ? { mode: "palette", index: c.getBgColor() }
            : { mode: "default" };

      const allRows: RenderCell[][] = [];
      for (let i = start; i < end; i++) {
        const bufLine = buffer.getLine(i);
        const row: RenderCell[] = [];
        if (bufLine) {
          for (let x = 0; x < bufLine.length; x++) {
            const c = cellObj ? (bufLine.getCell(x, cellObj), cellObj) : bufLine.getCell(x);
            if (!c) continue;
            const w = c.getWidth();
            if (w === 0) continue; // continuation half of a wide char — skip
            // getChars() returns the full grapheme (base + combining/VS16), so
            // emoji like "☑️" survive intact and render as one glyph.
            row.push({
              chars: c.getChars() || " ",
              width: w,
              fg: fgSpec(c),
              bg: bgSpec(c),
              bold: c.isBold(),
            });
          }
        }
        allRows.push(row);
      }

      // Trim trailing then leading blank rows (mirrors readScreen) so the PNG
      // isn't padded with empty space. topOffset lets callers map cursor rows.
      // Skipped when trim=false so the live viewer renders the full, fixed
      // viewport and its window doesn't grow row by row as output appears.
      if (!trim) return { rows: allRows, topOffset: 0 };
      const isBlank = (row: RenderCell[]): boolean =>
        row.every((cell) => (cell.chars === " " || cell.chars === "") && cell.bg.mode === "default");
      while (allRows.length > 0 && isBlank(allRows[allRows.length - 1]!)) allRows.pop();
      let topOffset = 0;
      while (allRows.length > 0 && isBlank(allRows[0]!)) {
        allRows.shift();
        topOffset++;
      }
      return { rows: allRows, topOffset };
    },

    getCursorPosition(): { col: number; row: number } | null {
      const buf = xterm.buffer.active;
      // xterm cursor is 0-indexed; return 1-indexed to match SGR mouse protocol
      return { col: buf.cursorX + 1, row: buf.baseY + buf.cursorY + 1 };
    },

    stringCellWidth(s: string): number {
      try {
        return (xterm as any)._core.unicodeService.getStringCellWidth(s);
      } catch {
        // Fallback: count Unicode code points (better than UTF-16 units).
        return Array.from(s).length;
      }
    },

    isCursorHidden(): boolean {
      return (xterm as any)._core?.coreService?.isCursorHidden ?? false;
    },

    getLastVisibleCursorPosition(): { col: number; row: number } | null {
      return lastVisibleCursorPos;
    },

    viewerSocketPath: viewerSocket?.socketPath ?? null,

    async waitForOutput(timeoutMs: number) {
      return waitForSettled(() => isAlive, () => outputBuffer, () => lastOutputTime, () => wrapper.readScreen().text, timeoutMs, wrapper);
    },

    resize(newCols: number, newRows: number) {
      ptyProcess.resize(newCols, newRows);
      xterm.resize(newCols, newRows);
      if (viewerSocket) scheduleViewerFrame();
    },

    kill(signal?: string) {
      if (isAlive) { ptyProcess.kill(signal); isAlive = false; }
    },

    dispose() {
      if (isAlive) { ptyProcess.kill(); isAlive = false; }
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      replyDisposable.dispose();
      viewerSocket?.close();
      xterm.dispose();
    },
  };

  // Wait for startup output to detect prompt
  await new Promise((r) => setTimeout(r, 1000));
  const startupScreen = wrapper.readScreen().text;
  promptPattern = detectPromptPattern(startupScreen);
  wrapper.promptPattern = promptPattern;
  // Render an initial frame so a viewer connecting right after launch sees the
  // startup screen immediately, before any further PTY output arrives.
  if (viewerSocket) scheduleViewerFrame();
  return wrapper;
}

// ─── Pipe mode (child_process fallback) ─────────────────────────────

/**
 * In pipe mode, some programs need extra flags to behave interactively.
 * Returns modified args array with interactive flags prepended if needed.
 */
function pipeInteractiveArgs(command: string, args: string[]): string[] {
  const base = command.split("/").pop() ?? command;

  // Python: needs -i for interactive mode, -u for unbuffered
  if (/^python[23]?$/.test(base)) {
    const hasI = args.includes("-i") || args.includes("-u");
    if (!hasI) return ["-u", "-i", ...args];
    if (!args.includes("-u")) return ["-u", ...args];
    return args;
  }

  // Node: needs --interactive (or -i) for REPL when stdin is piped
  if (base === "node" || base === "nodejs") {
    const hasI = args.includes("-i") || args.includes("--interactive");
    if (!hasI) return ["--interactive", ...args];
    return args;
  }

  // Bash/zsh/sh: add -i for interactive mode, but NOT when using -c (command string)
  if (/^(ba)?sh$|^zsh$/.test(base)) {
    if (args.includes("-c")) return args; // -c means non-interactive command wrapper
    const hasI = args.includes("-i");
    if (!hasI) return ["-i", ...args];
    return args;
  }

  return args;
}

/**
 * Create a pipe-mode terminal directly (exported for testing).
 */
export async function createPipeTerminal(options: TerminalOptions): Promise<TerminalWrapper> {
  const args = pipeInteractiveArgs(options.command, options.args ?? []);
  const envVars = {
    ...process.env,
    TERM: "dumb",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    NODE_NO_READLINE: "1",
    ...options.env,
  };

  // If sandbox is active, wrap the command
  let proc: ChildProcess;
  if (isSandboxActive()) {
    const fullCmd = [options.command, ...args].map((a) => a.includes(" ") ? `"${a}"` : a).join(" ");
    const { command: wrappedCmd } = await wrapCommand(fullCmd);
    try {
      proc = spawn(wrappedCmd, {
        cwd: options.cwd ?? process.cwd(),
        env: envVars,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        detached: true,
      });
    } catch (err) {
      throw new Error(`Failed to spawn sandboxed "${options.command}": ${err}`);
    }
  } else {
    try {
      proc = spawn(options.command, args, {
        cwd: options.cwd ?? process.cwd(),
        env: envVars,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      throw new Error(`Failed to spawn "${options.command}": ${err}`);
    }
  }

  return new Promise((resolve, reject) => {

    if (!proc.pid) {
      // Handle spawn errors that come async
      proc.once("error", (err) => {
        reject(new Error(`Failed to spawn "${options.command}": ${err.message}`));
      });
      // Give it a moment to either get a pid or error
      setTimeout(() => {
        if (!proc.pid) {
          reject(new Error(`Failed to spawn "${options.command}": no pid assigned`));
        }
      }, 500);
      return;
    }

    let isAlive = true;
    let promptPattern: RegExp | null = null;
    let outputLines: string[] = [];
    let lastOutputTime = Date.now();
    let outputGeneration = 0;
    // Separate buffer for output since last write()
    let newOutputBuffer = "";

    const appendOutput = (data: Buffer) => {
      const text = data.toString();
      newOutputBuffer += text;

      // Also maintain full output lines for full_screen reads
      const parts = text.split("\n");
      if (parts.length === 1) {
        if (outputLines.length === 0) outputLines.push("");
        outputLines[outputLines.length - 1] += parts[0];
      } else {
        if (outputLines.length > 0) {
          outputLines[outputLines.length - 1] += parts[0];
        } else {
          outputLines.push(parts[0]);
        }
        for (let i = 1; i < parts.length; i++) {
          outputLines.push(parts[i]);
        }
      }
      lastOutputTime = Date.now();
      outputGeneration++;

      // Cap scrollback at 2000 lines
      if (outputLines.length > 2000) {
        outputLines = outputLines.slice(-1000);
      }
    };

    proc.stdout!.on("data", appendOutput);
    proc.stderr!.on("data", appendOutput);

    proc.on("exit", () => { isAlive = false; });
    proc.on("error", () => { isAlive = false; });

    const wrapper: TerminalWrapper = {
      process: proc,
      pid: proc.pid!,
      get isAlive() { return isAlive; },
      promptPattern,
      mode: "pipe",
      get enterKey() { return "\n"; },

      write(data: string) {
        if (!isAlive) throw new Error("Session is not alive");
        // Clear new output buffer so readScreen returns only new output
        newOutputBuffer = "";
        proc.stdin!.write(data);
      },

      readScreen(fullScreen = false, rawAnsi = false): { text: string; topOffset: number } {
        const clean = rawAnsi ? (s: string) => s : stripAnsi;
        if (fullScreen) {
          return { text: clean(outputLines.join("\n")), topOffset: 0 };
        }
        // Return only output received since the last write()
        return { text: clean(newOutputBuffer), topOffset: 0 };
      },

      getCursorPosition(): { col: number; row: number } | null {
        return null; // Not available in pipe mode
      },

      stringCellWidth(s: string): number {
        // No emulator in pipe mode; approximate by code-point count. Screenshots
        // aren't supported in pipe mode anyway, so this is only a safe default.
        return Array.from(s).length;
      },

      getScreenCells(_trim = true): { rows: RenderCell[][]; topOffset: number } | null {
        return null; // No grid in pipe mode; screenshots require PTY mode.
      },

      isCursorHidden(): boolean {
        return false; // Not available in pipe mode
      },

      getLastVisibleCursorPosition(): { col: number; row: number } | null {
        return null; // Not available in pipe mode
      },

      viewerSocketPath: null,

      async waitForOutput(timeoutMs: number) {
        const startGen = outputGeneration;
        return waitForSettled(
          () => isAlive,
          () => String(outputGeneration),
          () => lastOutputTime,
          () => wrapper.readScreen().text,
          timeoutMs,
          wrapper,
        );
      },

      resize(_cols: number, _rows: number) {
        // No-op in pipe mode — no PTY to resize
      },

      kill(signal?: string) {
        if (isAlive) {
          const sig = (signal as NodeJS.Signals) ?? "SIGTERM";
          try { process.kill(-proc.pid!, sig); } catch { proc.kill(sig); }
          isAlive = false;
        }
      },

      dispose() {
        if (isAlive) {
          try { process.kill(-proc.pid!, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
          isAlive = false;
        }
      },
    };

    // Wait for startup output to detect prompt
    setTimeout(() => {
      const startupScreen = wrapper.readScreen().text;
      promptPattern = detectPromptPattern(startupScreen);
      wrapper.promptPattern = promptPattern;
      resolve(wrapper);
    }, 1000);
  });
}

// ─── Shared wait logic ──────────────────────────────────────────────

function waitForSettled(
  getAlive: () => boolean,
  getOutputMarker: () => string,
  getLastOutputTime: () => number,
  getScreen: () => string,
  timeoutMs: number,
  wrapper: TerminalWrapper,
): Promise<{ output: string; isComplete: boolean }> {
  const startMarker = getOutputMarker();
  const startTime = Date.now();

  return new Promise((res) => {
    let settled = false;

    const check = () => {
      const elapsed = Date.now() - startTime;

      if (!getAlive()) {
        res({ output: getScreen(), isComplete: true });
        return;
      }

      if (elapsed >= timeoutMs) {
        res({ output: getScreen(), isComplete: false });
        return;
      }

      const timeSinceOutput = Date.now() - getLastOutputTime();

      if (timeSinceOutput >= OUTPUT_SETTLE_MS && getOutputMarker() !== startMarker) {
        const screen = getScreen();
        if (wrapper.promptPattern && endsWithPrompt(screen, wrapper.promptPattern)) {
          res({ output: screen, isComplete: true });
          return;
        }
        if (!settled) {
          settled = true;
          setTimeout(check, OUTPUT_SETTLE_MS);
          return;
        }
        res({ output: screen, isComplete: true });
        return;
      }

      setTimeout(check, 50);
    };

    setTimeout(check, 50);
  });
}
