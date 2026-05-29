/**
 * Cross-platform OS clipboard helpers + paste/copy tools.
 *
 * `copy_to_clipboard` writes text or an image (by file path) to the
 * system clipboard.
 *
 * `paste` triggers a paste event in a session by writing a bracketed
 * paste sequence (ESC[200~ ... ESC[201~) to the PTY. When `text` is
 * given, the text is wrapped in the bracket. When `image_path` is given,
 * the image is first copied to the system clipboard and an EMPTY
 * bracketed paste is sent — this is exactly what real terminals emit
 * when a user presses Cmd+V / Ctrl+V with an image on the clipboard,
 * and what TUI apps (CoderFish, Claude Code, etc.) use as a trigger to
 * read the clipboard themselves.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import type { ServerConfig } from "../types.js";
import { sanitize } from "../utils/sanitizer.js";
import { redactSecrets } from "../utils/secret-redactor.js";
import { audit } from "../utils/audit-logger.js";

// Map known image file extensions to MIME types. The OS clipboard helpers
// publish the image to the clipboard tagged with this type. Returning null
// (rather than defaulting to PNG) lets the caller reject unknown formats
// instead of silently mislabeling them.
function detectImageMime(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".webp": return "image/webp";
    case ".tif":
    case ".tiff": return "image/tiff";
    default: return null;
  }
}

const execFileP = promisify(execFile);

const PASTE_WAIT_MS = 500;

// ─── OS clipboard implementations ──────────────────────────────────

async function setClipboardTextMac(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.end(text, "utf-8");
  });
}

// osascript class codes for each supported image MIME type. Setting the
// clipboard with the wrong code would publish the bytes under the wrong
// flavor and consumers expecting one would fail to decode.
const MAC_OSA_CLASS_BY_MIME: Record<string, string> = {
  "image/png": "«class PNGf»",
  "image/jpeg": "JPEG picture",
  "image/gif": "GIF picture",
  "image/tiff": "TIFF picture",
  "image/bmp": "«class BMP »",
};

async function setClipboardImageMac(imagePath: string, mime: string): Promise<void> {
  const klass = MAC_OSA_CLASS_BY_MIME[mime];
  if (!klass) {
    throw new Error(`Unsupported image type for macOS clipboard: ${mime}`);
  }
  await execFileP("osascript", [
    "-e",
    `set the clipboard to (read POSIX file "${imagePath.replace(/"/g, '\\"')}" as ${klass})`,
  ]);
}

async function setClipboardTextLinux(text: string): Promise<void> {
  // Prefer wl-copy (Wayland) then xclip (X11).
  const tools: Array<{ cmd: string; args: string[] }> = [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
  for (const t of tools) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(t.cmd, t.args);
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${t.cmd} exited ${code}`));
        });
        child.stdin.end(text, "utf-8");
      });
      return;
    } catch {
      // try next
    }
  }
  throw new Error("No clipboard tool found (tried wl-copy, xclip, xsel)");
}

async function setClipboardImageLinux(imagePath: string, mime: string): Promise<void> {
  const tools: Array<{ cmd: string; args: string[] }> = [
    { cmd: "wl-copy", args: ["--type", mime] },
    { cmd: "xclip", args: ["-selection", "clipboard", "-t", mime, "-i", imagePath] },
  ];
  for (const t of tools) {
    try {
      if (t.cmd === "wl-copy") {
        const data = await readFile(imagePath);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(t.cmd, t.args);
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${t.cmd} exited ${code}`));
          });
          child.stdin.end(data);
        });
      } else {
        await execFileP(t.cmd, t.args);
      }
      return;
    } catch {
      // try next
    }
  }
  throw new Error("No clipboard tool found for image (tried wl-copy, xclip)");
}

async function setClipboardTextWindows(text: string): Promise<void> {
  // Set-Clipboard via PowerShell. Use stdin to avoid escaping nightmares.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$in = [Console]::In.ReadToEnd(); Set-Clipboard -Value $in",
    ]);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`powershell exited ${code}`));
    });
    child.stdin.end(text, "utf-8");
  });
}

async function setClipboardImageWindows(imagePath: string): Promise<void> {
  // Use System.Windows.Forms.Clipboard to set the image. Requires STA.
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$img = [System.Drawing.Image]::FromFile('${imagePath.replace(/'/g, "''")}')`,
    "[System.Windows.Forms.Clipboard]::SetImage($img)",
    "$img.Dispose()",
  ].join("; ");
  await execFileP("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-Command",
    ps,
  ]);
}

export async function setClipboardText(text: string): Promise<void> {
  if (process.platform === "darwin") return setClipboardTextMac(text);
  if (process.platform === "linux") return setClipboardTextLinux(text);
  if (process.platform === "win32") return setClipboardTextWindows(text);
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export async function setClipboardImage(imagePath: string): Promise<void> {
  const mime = detectImageMime(imagePath);
  if (!mime) {
    throw new Error(`Unsupported image extension: ${imagePath}. Expected PNG, JPEG, GIF, BMP, WebP, or TIFF.`);
  }
  if (process.platform === "darwin") return setClipboardImageMac(imagePath, mime);
  if (process.platform === "linux") return setClipboardImageLinux(imagePath, mime);
  // Windows: System.Windows.Forms.Clipboard.SetImage decodes any supported
  // format and writes it as a CF_BITMAP, so the source MIME is moot.
  if (process.platform === "win32") return setClipboardImageWindows(imagePath);
  throw new Error(`Unsupported platform: ${process.platform}`);
}

// ─── copy_to_clipboard tool ────────────────────────────────────────

export const copyToClipboardSchema = z.object({
  text: z.string().optional().describe(
    "Text to place on the system clipboard. Mutually exclusive with image_path."
  ),
  image_path: z.string().optional().describe(
    "Absolute path to an image file (PNG/JPG/etc) to place on the system clipboard. Mutually exclusive with text."
  ),
});

export type CopyToClipboardArgs = z.infer<typeof copyToClipboardSchema>;

export async function handleCopyToClipboard(
  args: CopyToClipboardArgs,
  sessionManager: SessionManager,
): Promise<{ ok: true; kind: "text" | "image" }> {
  const hasText = typeof args.text === "string";
  const hasImage = typeof args.image_path === "string" && args.image_path.length > 0;
  if (hasText === hasImage) {
    throw new Error("Provide exactly one of `text` or `image_path`.");
  }
  if (hasText) {
    audit("clipboard_set_text");
    await setClipboardText(args.text as string);
    return { ok: true, kind: "text" };
  }
  const imagePath = args.image_path as string;
  if (!sessionManager.isPathAllowed(imagePath)) {
    audit("clipboard_set_image_blocked", undefined, { path: imagePath });
    throw new Error(`Path "${imagePath}" is outside the configured allowed paths.`);
  }
  audit("clipboard_set_image", undefined, { path: imagePath });
  await setClipboardImage(imagePath);
  return { ok: true, kind: "image" };
}

// ─── paste tool ────────────────────────────────────────────────────

export const pasteSchema = z.object({
  session_id: z.string().describe("The session ID to paste into."),
  text: z.string().optional().describe(
    "Text to paste. Wrapped in a bracketed paste sequence (ESC[200~ ... ESC[201~) so TUI apps recognize it as a paste rather than typed keystrokes. Mutually exclusive with image_path."
  ),
  image_path: z.string().optional().describe(
    "Absolute path to an image file to paste. The image is copied to the system clipboard, then an EMPTY bracketed paste sequence is sent — this is exactly what real terminals emit when a user presses Cmd+V / Ctrl+V with an image on the clipboard. TUI apps that support image paste (CoderFish, Claude Code) will read the clipboard themselves. Mutually exclusive with text."
  ),
  timeout_ms: z.number().int().min(100).max(60000).optional().default(2000).describe(
    "How long to wait for the app to react and render after the paste sequence."
  ),
  count: z.number().int().min(1).max(20).optional().default(1).describe(
    "Number of paste sequences to write in a single PTY write. Use >1 to reproduce rapid back-to-back paste races (e.g. user mashing Cmd+V faster than the app can finish reading the clipboard)."
  ),
});

export type PasteArgs = z.infer<typeof pasteSchema>;

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export async function handlePaste(
  args: PasteArgs,
  sessionManager: SessionManager,
  config: ServerConfig,
): Promise<{ output: string; sent: "text" | "image" | "empty" }> {
  const session = sessionManager.getSession(args.session_id);
  if (!session.isAlive) {
    throw new Error(`Session "${args.session_id}" is not alive`);
  }

  const hasText = typeof args.text === "string";
  const hasImage = typeof args.image_path === "string" && args.image_path.length > 0;
  if (hasText && hasImage) {
    throw new Error("Provide at most one of `text` or `image_path`.");
  }

  const count = args.count ?? 1;
  let kind: "text" | "image" | "empty";
  if (hasImage) {
    const imagePath = args.image_path as string;
    if (!sessionManager.isPathAllowed(imagePath)) {
      audit("paste_image_blocked", args.session_id, { path: imagePath });
      throw new Error(`Path "${imagePath}" is outside the configured allowed paths.`);
    }
    audit("paste_image", args.session_id, { path: imagePath, count });
    await setClipboardImage(imagePath);
    // Empty bracketed paste — the TUI reads the clipboard itself.
    session.terminal.write((BRACKETED_PASTE_START + BRACKETED_PASTE_END).repeat(count));
    kind = "image";
  } else if (hasText) {
    audit("paste_text", args.session_id, { count });
    session.terminal.write(
      (BRACKETED_PASTE_START + (args.text as string) + BRACKETED_PASTE_END).repeat(count),
    );
    kind = "text";
  } else {
    audit("paste_empty", args.session_id, { count });
    session.terminal.write((BRACKETED_PASTE_START + BRACKETED_PASTE_END).repeat(count));
    kind = "empty";
  }

  sessionManager.touchSession(args.session_id);

  // Wait for the app to react and render.
  const waitMs = Math.max(PASTE_WAIT_MS, args.timeout_ms ?? PASTE_WAIT_MS);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  let output = session.terminal.readScreen().text;
  output = sanitize(output, { maxChars: config.maxOutput });
  if (config.redactSecrets) {
    output = redactSecrets(output);
  }

  return { output, sent: kind };
}
