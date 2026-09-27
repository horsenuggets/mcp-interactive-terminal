import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type ServerConfig,
  type CreateSessionOutput,
} from "../types.js";
import { audit } from "../utils/audit-logger.js";

export const createSessionSchema = z.object({
  command: z.string().describe("The command to spawn (e.g., 'python3', 'bash', 'psql')"),
  args: z.array(z.string()).optional().describe("Arguments to pass to the command"),
  name: z.string().optional().describe("Human-readable session name"),
  cwd: z.string().optional().describe("Working directory for the session"),
  env: z.record(z.string()).optional().describe("Additional environment variables"),
  cols: z.number().min(MIN_COLS).max(MAX_COLS).optional().default(DEFAULT_COLS).describe("Terminal width in columns"),
  rows: z.number().min(MIN_ROWS).max(MAX_ROWS).optional().default(DEFAULT_ROWS).describe("Terminal height in rows"),
  timeout_seconds: z.number().min(1).max(21600).optional().default(300).describe("Session auto-timeout in seconds. The session process will be killed (SIGKILL) when this expires. Uses wall-clock time so it survives sleep/wake cycles. Default: 300 (5 minutes). Maximum: 21600 (6 hours)."),
  viewer: z.boolean().optional().default(false).describe("Enable visual viewer socket for this session"),
  fonts: z.array(z.string()).optional().describe("Absolute paths to font files (.ttf/.otf) to register for this session's screenshots. Register a custom terminal font here (e.g. a patch/emoji font) so screenshot_session renders its glyphs. Pair with font_family to actually select them."),
  font_family: z.string().optional().describe("Font family, or CSS-style comma-separated stack, used to render this session's screenshots (e.g. \"'My Mono', 'My Mono Emoji', Menlo\"). Families must be installed system-wide or supplied via the fonts arg. Defaults to the renderer's built-in monospace font."),
  unicode_version: z.enum(["15-graphemes", "15", "6", "legacy"]).optional().describe("Unicode width table/version for this session's terminal emulation. Use this to match host terminal behavior for wide/emoji glyph cell widths. Defaults to 15-graphemes."),
});

export type CreateSessionArgs = z.infer<typeof createSessionSchema>;

export async function handleCreateSession(
  args: CreateSessionArgs,
  sessionManager: SessionManager,
  config: ServerConfig,
): Promise<CreateSessionOutput> {
  if (config.logInputs) {
    console.error(`[mcp-terminal] create_session: ${args.command} ${(args.args ?? []).join(" ")}`);
  }

  const session = await sessionManager.createSession({
    command: args.command,
    args: args.args,
    name: args.name,
    cwd: args.cwd,
    env: args.env,
    cols: args.cols,
    rows: args.rows,
    timeoutSeconds: args.timeout_seconds,
    viewer: args.viewer,
    screenshotFonts: args.fonts,
    screenshotFontFamily: args.font_family,
    unicodeVersion: args.unicode_version,
  });

  audit("session_create", session.id, {
    command: args.command,
    args: args.args,
    cwd: args.cwd,
    name: session.name,
    pid: session.pid,
    mode: session.terminal.mode,
  });

  return {
    session_id: session.id,
    name: session.name,
    pid: session.pid,
  };
}
