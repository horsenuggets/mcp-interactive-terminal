import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
const { listen, emit } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

// Default terminal — will be reconfigured when terminal-config arrives
const term = new Terminal({
  fontFamily: "Menlo, monospace",
  fontSize: 12,
  theme: {
    background: "#292c33",
    foreground: "#ffffff",
    cursor: "#ffffff",
    selectionBackground: "#264f78",
    black: "#1d1f21",
    red: "#bf6b69",
    green: "#b7bd73",
    yellow: "#e9c880",
    blue: "#88a1bb",
    magenta: "#ad95b8",
    cyan: "#95bdb7",
    white: "#c5c8c6",
    brightBlack: "#666666",
    brightRed: "#c55757",
    brightGreen: "#bcc95f",
    brightYellow: "#e1c65e",
    brightBlue: "#83a5d6",
    brightMagenta: "#bc99d4",
    brightCyan: "#83beb1",
    brightWhite: "#eaeaea",
  },
  drawBoldTextInBrightColors: false,
  cursorBlink: false,
  cursorStyle: "bar",
  cursorInactiveStyle: "bar",
  scrollback: 5000,
  disableStdin: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
const container = document.getElementById("terminal");
term.open(container);

// Fix dim rendering: inject a style override after xterm initializes.
// xterm.js dim uses 8-digit hex (#RRGGBBAA) with 50% alpha.
// We override with opaque half-brightness colors.
{
  const theme = term.options.theme || {};
  const palette = [
    theme.black, theme.red, theme.green, theme.yellow,
    theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  let css = "";
  const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    if (!c) continue;
    const m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) continue;
    const r = parseInt(m[1], 16) * 0.6;
    const g = parseInt(m[2], 16) * 0.6;
    const b = parseInt(m[3], 16) * 0.6;
    css += `.xterm .xterm-fg-${i}.xterm-dim{color:#${hex(r)}${hex(g)}${hex(b)} !important}\n`;
  }
  const fg = theme.foreground || "#f0f0f0";
  const fgm = fg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (fgm) {
    css += `.xterm .xterm-fg-257.xterm-dim{color:#${hex(parseInt(fgm[1],16)*0.6)}${hex(parseInt(fgm[2],16)*0.6)}${hex(parseInt(fgm[3],16)*0.6)} !important}\n`;
  }
  if (css) {
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }
}

// Cursor visibility is controlled entirely by the PTY stream.
// Interactive shells send DECTCEM show/hide as needed.

async function resizeTerminalAndWindow(cols, rows) {
  // Resize xterm.js to match the PTY dimensions
  term.resize(cols, rows);

  // Measure actual cell size and compute window dimensions
  try {
    const dims = term._core._renderService.dimensions;
    const cellWidth = dims.css.cell.width;
    const cellHeight = dims.css.cell.height;
    const width = Math.ceil(cols * cellWidth) + 22;
    const height = Math.ceil(rows * cellHeight) + 18 + 28;
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(width, height));
    await win.setResizable(false);
  } catch (e) {
    fitAddon.fit();
  }
  emit("viewer-ready");
}

// Wait for terminal dimensions injected by Rust backend via eval()
function waitForConfig() {
  if (window.__TERMINAL_CONFIG__) {
    const { cols, rows } = window.__TERMINAL_CONFIG__;
    resizeTerminalAndWindow(cols, rows);
  } else {
    // Poll until the Rust eval() sets the config
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (window.__TERMINAL_CONFIG__) {
        clearInterval(poll);
        const { cols, rows } = window.__TERMINAL_CONFIG__;
        resizeTerminalAndWindow(cols, rows);
      } else if (attempts > 20) {
        clearInterval(poll);
        resizeTerminalAndWindow(80, 24);
      }
    }, 50);
  }
}
waitForConfig();

// Keep terminal focused so cursor renders when the PTY shows it
const textarea = term.textarea;
if (textarea) textarea.focus();

// Block all user mouse interaction
container.style.pointerEvents = "none";

// Repaint when window becomes visible (WKWebView optimization)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) term.refresh(0, term.rows - 1);
});
window.addEventListener("focus", () => {
  term.refresh(0, term.rows - 1);
});

// Synthetic cursor element — always solid, positioned from xterm.js buffer
const cursorEl = document.getElementById("synthetic-cursor");

// Red outline indicator around the cursor cell — makes it obvious in screenshots
const cursorOutline = document.createElement("div");
cursorOutline.id = "cursor-outline";
Object.assign(cursorOutline.style, {
  position: "absolute",
  border: "2px solid rgba(255, 70, 70, 0.5)",
  borderRadius: "0",
  pointerEvents: "none",
  zIndex: "11",
  display: "none",
  boxSizing: "border-box",
});
document.body.appendChild(cursorOutline);

// Track the last cursor position where DECTCEM was visible.
// Apps like Ink rapidly show/hide — we capture the position at each show.
let lastVisiblePos = null;

function updateSyntheticCursor() {
  const buf = term.buffer.active;
  if (!cursorEl) return;

  const isVisible = !(term._core?.coreService?.isCursorHidden ?? false);
  if (isVisible) {
    lastVisiblePos = { x: buf.cursorX, y: buf.cursorY };
  }

  // Hide cursor + outline when DECTCEM is off (click-to-blur, selection
  // outside input box, etc). Track lastVisiblePos so the cursor returns
  // to the right spot when re-shown.
  if (!isVisible) {
    cursorEl.style.display = "none";
    cursorOutline.style.display = "none";
    return;
  }
  const pos = { x: buf.cursorX, y: buf.cursorY };
  if (!pos) {
    cursorEl.style.display = "none";
    cursorOutline.style.display = "none";
    return;
  }
  try {
    const dims = term._core._renderService.dimensions;
    const cellW = dims.css.cell.width;
    const cellH = dims.css.cell.height;
    const x = 10 + pos.x * cellW; // 10px left padding
    const y = 8 + pos.y * cellH; // 8px top padding
    cursorEl.style.left = x + "px";
    cursorEl.style.top = y + "px";
    cursorEl.style.height = cellH + "px";
    cursorEl.style.display = "block";

    // Position the red outline centered around the cursor bar (2px wide).
    // Uniform gap of 2px between bar and inner border edge, border is 2px,
    // so total offset from bar edge = gap + border = 4px each side.
    const barW = 2; // synthetic cursor width
    const gap = 2; // space between bar and inner border edge
    const bw = 2;  // border width
    const m = gap + bw;
    cursorOutline.style.left = (x - m) + "px";
    cursorOutline.style.top = (y - m) + "px";
    cursorOutline.style.width = (barW + m * 2) + "px";
    cursorOutline.style.height = (cellH + m * 2) + "px";
    cursorOutline.style.display = "block";
  } catch {
    cursorEl.style.display = "none";
    cursorOutline.style.display = "none";
  }
}

listen("pty-data", (event) => {
  const bytes = Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0));
  term.write(bytes, () => {
    // Update last visible position from xterm buffer when cursor is visible
    const isVisible = !(term._core?.coreService?.isCursorHidden ?? false);
    if (isVisible) {
      const buf = term.buffer.active;
      lastVisiblePos = { x: buf.cursorX, y: buf.cursorY };
    }
    updateSyntheticCursor();
  });
}).catch(() => {});

listen("pty-closed", () => {}).catch(() => {});
listen("pty-error", () => {}).catch(() => {});
