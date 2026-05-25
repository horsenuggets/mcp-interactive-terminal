import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import type { CloseSessionOutput } from "../types.js";
import { audit } from "../utils/audit-logger.js";
import { stopRecordingForSession } from "./record-session.js";

export const closeSessionSchema = z.object({
  session_id: z.string().describe("The session ID to close"),
  signal: z.string().optional().default("SIGTERM")
    .describe("Signal to send (e.g., SIGTERM, SIGKILL)"),
});

export type CloseSessionArgs = z.infer<typeof closeSessionSchema>;

export async function handleCloseSession(
  args: CloseSessionArgs,
  sessionManager: SessionManager,
): Promise<CloseSessionOutput> {
  audit("session_close", args.session_id, { signal: args.signal });
  // Stop any active frame recording before we kill the terminal — once the
  // PTY is gone, the recorder's readScreen() calls would throw on every
  // tick. Cancelling the interval here keeps the close clean.
  stopRecordingForSession(args.session_id);
  sessionManager.closeSession(args.session_id, args.signal);
  return { success: true };
}
