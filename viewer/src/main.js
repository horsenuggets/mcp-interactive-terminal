// Live viewer front-end.
//
// The MCP renders each terminal frame to a PNG with skia-canvas — the exact
// same `renderScreenToPng` that backs `screenshot_session` — and streams it
// over the session's Unix socket. The Rust backend forwards each frame as a
// base64 `png-frame` event. This front-end simply displays the latest frame in
// an <img>, so the live viewer is pixel-identical to a screenshot. There is no
// xterm.js re-render (which clipped wide glyphs, ignored sbix color fonts, and
// mismatched cell metrics).
//
// The PNG is rendered at 2x (Retina) device pixels. We display the <img> at
// half its natural size in CSS pixels and size the window to match, so on a
// Retina display the frame maps 1:1 to physical pixels and stays crisp.

const { listen, emit } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

const img = document.getElementById("frame");

let currentUrl = null;
let readySignaled = false;
let lastW = 0;
let lastH = 0;
// The most recent frame's base64, retained so we can force a repaint after the
// window becomes visible (see repaint()).
let lastBase64 = null;

function signalReadyOnce() {
  if (readySignaled) return;
  readySignaled = true;
  emit("viewer-ready");
  // The first frame is decoded/sized while the window is still hidden (Rust
  // hides it on setup and only shows it on this event). Two things need a
  // post-show pass: WKWebView does not repaint an already-loaded <img> when the
  // window is later shown, and innerSize()/outerSize() only report reliable
  // values once the window is realized — so re-apply both the frame and the
  // window sizing now that it's visible.
  setTimeout(() => {
    repaint();
    if (lastW && lastH) void sizeWindow(lastW, lastH);
  }, 150);
}

// macOS standard title-bar height in logical px. Used as the fallback height
// allowance when the live inner-size measurement is unavailable/unreliable.
const MACOS_TITLEBAR_LOGICAL = 28;

// Size the window so its CONTENT area is exactly w×h logical px. setSize sets
// the OUTER size (frame + title bar/borders), so sizing it to the frame leaves
// the content short by the title-bar height and clips the bottom terminal
// row(s). We set the frame size, measure the content deficit, and grow the
// window by it. innerSize() is unreliable in some states (it can report the
// outer size), so when the measurement shows no deficit we fall back to the
// known macOS title-bar allowance. The CSS object-fit safety net absorbs any
// residual mismatch without ever clipping.
async function sizeWindow(w, h) {
  try {
    const win = getCurrentWindow();
    await win.setResizable(true);
    await win.setSize(new LogicalSize(w, h));
    let deficit = MACOS_TITLEBAR_LOGICAL;
    try {
      const [inner, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
      const measured = h - inner.height / scale;
      if (measured > 0.5) deficit = measured;
    } catch {}
    await win.setSize(new LogicalSize(w, h + deficit));
    await win.setResizable(false);
  } catch {}
}

async function showFrame(base64) {
  // Decode base64 → bytes → Blob URL. Blob URLs let the browser decode the PNG
  // off the main path and avoid the length limits of data: URLs.
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "image/png" });
  const url = URL.createObjectURL(blob);

  img.onload = async () => {
    // The PNG is 2x; the window is sized at logical (÷2) dimensions. The <img>
    // itself fills the window via CSS (width/height 100% + object-fit), so we
    // don't set explicit pixel dimensions here.
    const w = Math.round(img.naturalWidth / 2);
    const h = Math.round(img.naturalHeight / 2);

    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      await sizeWindow(w, h);
    }

    // Free the previous frame's Blob URL now that the new one is displayed.
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = url;

    signalReadyOnce();
  };

  img.src = url;
}

// Force the latest frame to repaint by rebuilding it from scratch. Used just
// after the window is first shown, since a frame decoded while the window was
// still hidden may not paint on its own.
function repaint() {
  if (lastBase64) void showFrame(lastBase64);
}

listen("png-frame", (event) => {
  lastBase64 = event.payload;
  void showFrame(event.payload);
}).catch(() => {});

listen("pty-closed", () => {}).catch(() => {});
listen("pty-error", () => {}).catch(() => {});

// Note: when the window is occluded/backgrounded WKWebView suspends this
// WebContent process and drops the png-frame events it misses, so lastBase64
// goes stale. The Rust side handles that by re-emitting the *current* frame on
// window focus, which arrives as a normal png-frame once this process resumes —
// so no stale-frame repaint is done here on focus/visibility.

// Failsafe: if no frame arrives shortly after launch, reveal the window anyway
// so it never stays permanently hidden waiting on a frame that never comes.
setTimeout(signalReadyOnce, 2000);
