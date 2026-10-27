import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import type { ResizeSessionOutput, ServerConfig } from "../types.js";
import { audit } from "../utils/audit-logger.js";
import { redactSecrets } from "../utils/secret-redactor.js";

export const resizeSessionSchema = z.object({
  session_id: z.string().describe("The session ID to resize"),
  cols: z.number().int().min(10).max(300).describe("New terminal width in columns"),
  rows: z.number().int().min(5).max(100).describe("New terminal height in rows"),
  settle_ms: z.number().int().min(0).max(10000).default(300)
    .describe("How long to wait for the program to redraw after SIGWINCH before returning the screen (ms)"),
});

export type ResizeSessionArgs = z.infer<typeof resizeSessionSchema>;

export async function handleResizeSession(
  args: ResizeSessionArgs,
  sessionManager: SessionManager,
  config: ServerConfig,
): Promise<ResizeSessionOutput> {
  audit("session_resize", args.session_id, { cols: args.cols, rows: args.rows });
  const session = sessionManager.getSession(args.session_id);
  session.terminal.resize(args.cols, args.rows);
  session.cols = args.cols;
  session.rows = args.rows;
  sessionManager.touchSession(args.session_id);
  if (args.settle_ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, args.settle_ms));
  }
  // Keep blank rows, since resize bugs often show up as extra or missing blank lines.
  // That's also why this skips sanitize() and only applies secret redaction.
  let output = session.terminal.readScreen(false, false, false).text;
  if (config.redactSecrets) {
    output = redactSecrets(output);
  }
  return { cols: args.cols, rows: args.rows, output };
}
