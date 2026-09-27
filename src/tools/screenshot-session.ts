import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import { renderScreenToPng } from "../skia-render.js";

export const screenshotSessionSchema = z.object({
  session_id: z.string().describe("The session ID to screenshot"),
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
): Promise<{ image_data: string } | { error: string }> {
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
  return { image_data: png.toString("base64") };
}
