import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import { renderScreenToPng } from "../skia-render.js";

export const screenshotSessionSchema = z.object({
  session_id: z.string().describe("The session ID to screenshot"),
  save_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute path to also write the PNG to (parent directories are created). The image is still returned inline.",
    ),
});

export type ScreenshotSessionArgs = z.infer<typeof screenshotSessionSchema>;

/**
 * Render the terminal buffer to a PNG image using skia-canvas.
 * Delegates to the shared `renderScreenToPng` renderer so screenshots and the
 * live viewer's streamed frames are pixel-identical.
 */
export async function handleScreenshotSession(
  args: ScreenshotSessionArgs,
  sessionManager: SessionManager,
): Promise<{ image_data: string; saved_path?: string } | { error: string }> {
  if (args.save_path !== undefined) {
    if (!isAbsolute(args.save_path)) {
      return { error: "save_path must be an absolute path" };
    }
    if (!sessionManager.isPathAllowed(args.save_path)) {
      return { error: `Path "${args.save_path}" is outside the configured allowed paths.` };
    }
  }

  const session = sessionManager.getSession(args.session_id);
  const terminal = session.terminal;

  if (terminal.mode !== "pty") {
    return { error: "Screenshot only available in PTY mode" };
  }

  // Dynamic import skia-canvas (native module). Skia renders color emoji fonts
  // (Twemoji COLR, Apple Color Emoji sbix) natively, unlike node-canvas.
  let skiaMod: any;
  try {
    skiaMod = await import("skia-canvas");
  } catch {
    return { error: "skia-canvas package not available" };
  }

  const png = renderScreenToPng(terminal, {
    skiaMod,
    fonts: session.screenshotFonts,
    fontFamily: session.screenshotFontFamily,
  });
  if (!png) {
    return { error: "Screen cells unavailable (screenshots require PTY mode)" };
  }

  if (args.save_path !== undefined) {
    mkdirSync(dirname(args.save_path), { recursive: true });
    writeFileSync(args.save_path, new Uint8Array(png));
    return { image_data: png.toString("base64"), saved_path: args.save_path };
  }
  return { image_data: png.toString("base64") };
}
