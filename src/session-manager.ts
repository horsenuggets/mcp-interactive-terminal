/**
 * Session lifecycle management.
 * Handles creation, lookup, idle cleanup, and resource limits.
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createTerminal, type TerminalOptions } from "./terminal.js";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type Session,
  type SessionInfo,
  type ServerConfig,
} from "./types.js";
import { audit } from "./utils/audit-logger.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private ttlPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: ServerConfig) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  async createSession(
    options: TerminalOptions & {
      name?: string;
      timeoutSeconds?: number;
      screenshotFonts?: string[];
      screenshotFontFamily?: string;
    },
  ): Promise<Session> {
    // Check limits
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Maximum sessions (${this.config.maxSessions}) reached. Close an existing session first.`
      );
    }

    // Validate command against allowlist/blocklist
    this.validateCommand(options.command);

    // Validate cwd against allowed paths
    this.validatePath(options.cwd);

    const terminal = await createTerminal(options);
    const id = randomUUID().slice(0, 8);
    const ttlSeconds = options.timeoutSeconds ?? 300;

    // Screenshot font config resolves from explicit args first, then the session
    // env, then the server process env (MCP_TERMINAL_SCREENSHOT_FONTS /
    // _FONT_FAMILY), mirroring the Unicode-version precedence below. The env
    // paths exist because some MCP clients validate tool calls against a cached
    // schema and silently drop args they haven't refreshed — but `env` is a
    // long-standing param they always forward, so it's a reliable channel.
    const envFontsRaw =
      options.env?.MCP_TERMINAL_SCREENSHOT_FONTS ?? process.env.MCP_TERMINAL_SCREENSHOT_FONTS;
    const screenshotFonts =
      options.screenshotFonts ??
      (envFontsRaw ? envFontsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
    const screenshotFontFamily =
      options.screenshotFontFamily ??
      options.env?.MCP_TERMINAL_SCREENSHOT_FONT_FAMILY ??
      process.env.MCP_TERMINAL_SCREENSHOT_FONT_FAMILY;
    const session: Session = {
      id,
      name: options.name ?? `${options.command}-${id}`,
      command: options.command,
      args: options.args ?? [],
      pid: terminal.pid,
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      createdAt: new Date(),
      lastActivity: new Date(),
      deadlineMs: Date.now() + ttlSeconds * 1000,
      isAlive: true,
      terminal,
      pendingDangerousCommands: new Set(),
      screenshotFonts,
      screenshotFontFamily,
      unicodeVersion:
        options.unicodeVersion ??
        options.env?.MCP_TERMINAL_UNICODE_VERSION ??
        process.env.MCP_TERMINAL_UNICODE_VERSION ??
        "15-graphemes",
    };

    this.sessions.set(id, session);

    // Start TTL polling if not already running
    this.ensureTtlPoll();

    // Set up idle timeout if configured
    if (this.config.idleTimeout > 0) {
      this.resetIdleTimer(id);
    }

    // Update isAlive on process exit
    const checkAlive = setInterval(() => {
      if (!terminal.isAlive) {
        session.isAlive = false;
        clearInterval(checkAlive);
      }
    }, 1000);

    return session;
  }

  getSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }
    // Sync alive status
    session.isAlive = session.terminal.isAlive;
    return session;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      session_id: s.id,
      name: s.name,
      command: s.command,
      pid: s.pid,
      is_alive: s.terminal.isAlive,
      created_at: s.createdAt.toISOString(),
    }));
  }

  closeSession(id: string, signal?: string): void {
    const session = this.getSession(id);
    session.terminal.kill(signal);
    session.terminal.dispose();
    session.isAlive = false;
    this.sessions.delete(id);
    this.clearIdleTimer(id);
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      try {
        this.closeSession(id);
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  touchSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = new Date();
      if (this.config.idleTimeout > 0) {
        this.resetIdleTimer(id);
      }
    }
  }

  /**
   * Check if an absolute path is within the allowed paths list.
   * Returns true if no allowedPaths are configured (unrestricted).
   */
  isPathAllowed(targetPath: string): boolean {
    if (this.config.allowedPaths.length === 0) return true;
    const resolved = resolvePath(targetPath);
    return this.config.allowedPaths.some((allowed) => {
      const resolvedAllowed = resolvePath(allowed);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + "/");
    });
  }

  private validatePath(cwd?: string): void {
    if (this.config.allowedPaths.length === 0) return;
    const target = resolvePath(cwd ?? process.cwd());
    if (!this.isPathAllowed(target)) {
      throw new Error(
        `Working directory "${target}" is not in the allowed paths: ${this.config.allowedPaths.join(", ")}`
      );
    }
  }

  private validateCommand(command: string): void {
    const base = command.split("/").pop() ?? command;

    if (this.config.allowedCommands.length > 0) {
      if (!this.config.allowedCommands.includes(base)) {
        throw new Error(
          `Command "${base}" is not in the allowed list: ${this.config.allowedCommands.join(", ")}`
        );
      }
    }

    if (this.config.blockedCommands.includes(base)) {
      throw new Error(`Command "${base}" is blocked by configuration`);
    }
  }

  private resetIdleTimer(id: string): void {
    this.clearIdleTimer(id);
    const timer = setTimeout(() => {
      const session = this.sessions.get(id);
      if (session) {
        audit("session_idle_timeout", id, { name: session.name });
        try {
          this.closeSession(id);
        } catch {
          // Ignore
        }
      }
    }, this.config.idleTimeout);
    this.idleTimers.set(id, timer);
  }

  private clearIdleTimer(id: string): void {
    const timer = this.idleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(id);
    }
  }

  /**
   * Start a 30-second polling interval that checks session deadlines using
   * wall-clock comparison. This survives sleep/wake cycles because we compare
   * Date.now() against the absolute deadline timestamp each tick rather than
   * relying on setTimeout accuracy.
   */
  private ensureTtlPoll(): void {
    if (this.ttlPollTimer) return;
    this.ttlPollTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (session.deadlineMs !== null && now >= session.deadlineMs) {
          audit("session_ttl_timeout", id, { name: session.name });
          try {
            // SIGKILL the process — the session has exceeded its TTL
            this.closeSession(id, "SIGKILL");
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
      // Stop polling when no sessions remain
      if (this.sessions.size === 0 && this.ttlPollTimer) {
        clearInterval(this.ttlPollTimer);
        this.ttlPollTimer = null;
      }
    }, 30_000);
  }
}
