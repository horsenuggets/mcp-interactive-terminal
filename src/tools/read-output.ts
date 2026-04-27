import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import type { ServerConfig, ReadOutputOutput } from "../types.js";
import { sanitize } from "../utils/sanitizer.js";
import { redactSecrets } from "../utils/secret-redactor.js";

export const readOutputSchema = z.object({
  session_id: z.string().describe("The session ID to read output from"),
  full_screen: z.boolean().optional().default(false)
    .describe("Read full scrollback history instead of just the visible screen"),
  raw_ansi: z.boolean().optional().default(false)
    .describe("Include ANSI color/style escape codes in the output (useful for comparing terminal rendering)"),
});

export type ReadOutputArgs = z.infer<typeof readOutputSchema>;

export async function handleReadOutput(
  args: ReadOutputArgs,
  sessionManager: SessionManager,
  config: ServerConfig,
): Promise<ReadOutputOutput> {
  const session = sessionManager.getSession(args.session_id);

  const screen = session.terminal.readScreen(args.full_screen, args.raw_ansi);
  let output = sanitize(screen.text, { maxChars: config.maxOutput, keepAnsi: args.raw_ansi });

  if (config.redactSecrets) {
    output = redactSecrets(output);
  }

  const cursor = session.terminal.getCursorPosition();
  const cursorHidden = session.terminal.isCursorHidden();
  const lastVisibleCursor = session.terminal.getLastVisibleCursorPosition();
  return {
    output,
    is_alive: session.terminal.isAlive,
    ...(cursor && { cursor: { ...cursor, visible: !cursorHidden } }),
    ...(lastVisibleCursor && { last_visible_cursor: lastVisibleCursor }),
    ...(screen.topOffset > 0 && { top_offset: screen.topOffset }),
    ...(session.terminal.viewerSocketPath && { viewer_socket: session.terminal.viewerSocketPath }),
  };
}
