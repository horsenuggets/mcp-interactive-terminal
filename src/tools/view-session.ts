import { z } from "zod";
import { execSync, spawn } from "node:child_process";
import type { SessionManager } from "../session-manager.js";

export const viewSessionSchema = z.object({
  session_id: z.string().describe("The session ID to view"),
  foreground: z.boolean().optional().default(false)
    .describe("Bring the viewer window to the front and capture focus when it opens"),
});

export type ViewSessionArgs = z.infer<typeof viewSessionSchema>;

export async function handleViewSession(
  args: ViewSessionArgs,
  sessionManager: SessionManager,
): Promise<{ success: boolean; viewer_socket: string }> {
  const session = sessionManager.getSession(args.session_id);
  const socketPath = session.terminal.viewerSocketPath;

  if (!socketPath) {
    throw new Error("Viewer not available for this session (pipe mode)");
  }

  // Launch the viewer binary
  let viewerPath: string;
  try {
    viewerPath = execSync(`which terminal-viewer`, { encoding: "utf-8" }).trim();
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

  // Launch detached so it doesn't block the MCP server
  const child = spawn(viewerPath, viewerArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return { success: true, viewer_socket: socketPath };
}
