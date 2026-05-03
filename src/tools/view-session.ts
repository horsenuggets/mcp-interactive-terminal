import { z } from "zod";
import { execSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionManager } from "../session-manager.js";

export const viewSessionSchema = z.object({
  session_id: z.string().describe("The session ID to view"),
  foreground: z.boolean().optional().default(false)
    .describe("Bring the viewer window to the front and capture focus when it opens"),
});

export type ViewSessionArgs = z.infer<typeof viewSessionSchema>;

/**
 * On macOS, locate the Tauri-bundled "Terminal Viewer.app" given the
 * resolved path of the bare `terminal-viewer` binary. Cargo builds the
 * binary into `target/<profile>/terminal-viewer` and Tauri's bundle
 * step writes the .app into `target/<profile>/bundle/macos/Terminal
 * Viewer.app`. Returns null if the bundle is not present.
 */
function findMacAppBundle(binaryPath: string): string | null {
  const dir = dirname(binaryPath);
  const candidates: string[] = [
    join(dir, "bundle", "macos", "Terminal Viewer.app"),
    "/Applications/Terminal Viewer.app",
  ];
  // Only add the per-user Applications path when HOME is actually set —
  // a missing HOME would otherwise produce a relative path that
  // resolves against the current working directory.
  if (process.env.HOME) {
    candidates.push(join(process.env.HOME, "Applications", "Terminal Viewer.app"));
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function handleViewSession(
  args: ViewSessionArgs,
  sessionManager: SessionManager,
): Promise<{ success: boolean; viewer_socket: string }> {
  const session = sessionManager.getSession(args.session_id);
  const socketPath = session.terminal.viewerSocketPath;

  if (!socketPath) {
    throw new Error("Viewer not available for this session (pipe mode)");
  }

  // Locate the viewer binary on PATH, then resolve any symlinks so we
  // can find the matching .app bundle next to it on macOS.
  let viewerPath: string;
  try {
    viewerPath = execSync(`which terminal-viewer`, { encoding: "utf-8" }).trim();
    viewerPath = realpathSync(viewerPath);
  } catch {
    throw new Error(
      "terminal-viewer binary not found on PATH. " +
      "Build it from viewer/src-tauri or add its directory to PATH."
    );
  }

  const viewerArgs = [
    socketPath,
    "--cols", String(session.cols),
    "--rows", String(session.rows),
  ];
  if (args.foreground) {
    viewerArgs.push("--foreground");
  }

  // On macOS, prefer launching through the .app bundle so the process
  // name, Dock icon, and window title bar all show "Terminal Viewer"
  // instead of the lowercase Cargo bin name "terminal-viewer".
  const appBundle = process.platform === "darwin" ? findMacAppBundle(viewerPath) : null;
  if (appBundle) {
    // `open -n -a APP --args ...` launches a new instance and forwards
    // the remaining args to the app's main executable.
    const openArgs = ["-n", "-a", appBundle, "--args", ...viewerArgs];
    const child = spawn("open", openArgs, { detached: true, stdio: "ignore" });
    child.unref();
  } else {
    // Linux / Windows / no bundle: spawn the bare binary directly.
    const child = spawn(viewerPath, viewerArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  return { success: true, viewer_socket: socketPath };
}
