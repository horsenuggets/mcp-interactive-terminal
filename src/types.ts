import type { ChildProcess } from "node:child_process";

// --- Configuration ---

export interface ServerConfig {
  maxSessions: number;
  maxOutput: number;
  defaultTimeout: number;
  blockedCommands: string[];
  allowedCommands: string[];
  allowedPaths: string[];
  redactSecrets: boolean;
  logInputs: boolean;
  idleTimeout: number;
  dangerDetection: boolean;
  auditLog: string;
  sandbox: boolean;
  sandboxAllowWrite: string[];
  sandboxAllowNetwork: string[];
}

export function loadConfig(): ServerConfig {
  const envList = (key: string, fallback: string[] = []): string[] => {
    const val = process.env[key];
    if (!val) return fallback;
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  };

  return {
    maxSessions: parseInt(process.env.MCP_TERMINAL_MAX_SESSIONS || "10", 10),
    maxOutput: parseInt(process.env.MCP_TERMINAL_MAX_OUTPUT || "20000", 10),
    defaultTimeout: parseInt(process.env.MCP_TERMINAL_DEFAULT_TIMEOUT || "5000", 10),
    blockedCommands: envList("MCP_TERMINAL_BLOCKED_COMMANDS"),
    allowedCommands: envList("MCP_TERMINAL_ALLOWED_COMMANDS"),
    allowedPaths: envList("MCP_TERMINAL_ALLOWED_PATHS"),
    redactSecrets: process.env.MCP_TERMINAL_REDACT_SECRETS === "true",
    logInputs: process.env.MCP_TERMINAL_LOG_INPUTS === "true",
    idleTimeout: parseInt(process.env.MCP_TERMINAL_IDLE_TIMEOUT || "1800000", 10),
    dangerDetection: process.env.MCP_TERMINAL_DANGER_DETECTION !== "false",
    auditLog: process.env.MCP_TERMINAL_AUDIT_LOG || "",
    sandbox: process.env.MCP_TERMINAL_SANDBOX === "true",
    sandboxAllowWrite: envList("MCP_TERMINAL_SANDBOX_ALLOW_WRITE", ["/tmp"]),
    sandboxAllowNetwork: envList("MCP_TERMINAL_SANDBOX_ALLOW_NETWORK", ["*"]),
  };
}

// --- Session ---

export interface Session {
  id: string;
  name: string;
  command: string;
  args: string[];
  pid: number;
  cols: number;
  rows: number;
  createdAt: Date;
  lastActivity: Date;
  isAlive: boolean;
  terminal: TerminalWrapper;
  pendingDangerousCommands: Set<string>;
}

export interface SessionInfo {
  session_id: string;
  name: string;
  command: string;
  pid: number;
  is_alive: boolean;
  created_at: string;
}

// --- Terminal Wrapper ---

export interface TerminalWrapper {
  process: ChildProcess | { pid: number; kill(signal?: string): void };
  pid: number;
  isAlive: boolean;
  promptPattern: RegExp | null;
  mode: "pty" | "pipe";
  /** The character that means "execute/enter" — \r for PTY, \n for pipe */
  get enterKey(): string;
  write(data: string): void;
  readScreen(fullScreen?: boolean, rawAnsi?: boolean): { text: string; topOffset: number };
  /** Get the cursor position as {col, row} (1-indexed). Returns null in pipe mode. */
  getCursorPosition(): { col: number; row: number } | null;
  /** Check if the cursor is hidden via DECTCEM (\x1b[?25l). Only available in PTY mode. */
  isCursorHidden(): boolean;
  /** Get the last cursor position where DECTCEM was visible. Captures the
   *  logical cursor even for apps (like Ink) that rapidly show/hide it. */
  getLastVisibleCursorPosition(): { col: number; row: number } | null;
  /** Path to the viewer Unix socket, if active. */
  viewerSocketPath: string | null;
  waitForOutput(timeoutMs: number): Promise<{ output: string; isComplete: boolean }>;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  dispose(): void;
}

// --- Tool I/O types ---

export interface CreateSessionInput {
  command: string;
  args?: string[];
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface CreateSessionOutput {
  session_id: string;
  name: string;
  pid: number;
}

export interface SendCommandInput {
  session_id: string;
  input: string;
  timeout_ms?: number;
  max_output_chars?: number;
}

export interface SendCommandOutput {
  output: string;
  is_complete: boolean;
  is_alive: boolean;
  warning?: string;
}

export interface ReadOutputInput {
  session_id: string;
  full_screen?: boolean;
}

export interface ReadOutputOutput {
  output: string;
  is_alive: boolean;
  cursor?: { col: number; row: number; visible: boolean };
  /** Number of blank rows trimmed from the top of the screen output. Add this
   *  to visual row numbers to get real screen coordinates for mouse events. */
  top_offset?: number;
  /** Path to the viewer Unix socket for this session (PTY mode only). */
  viewer_socket?: string;
}

export interface CloseSessionInput {
  session_id: string;
  signal?: string;
}

export interface CloseSessionOutput {
  success: boolean;
}

export interface SendControlInput {
  session_id: string;
  control: string;
}

export interface SendControlOutput {
  output: string;
}

export interface ConfirmDangerousCommandInput {
  session_id: string;
  input: string;
  justification: string;
}

export interface ConfirmDangerousCommandOutput {
  output: string;
  is_complete: boolean;
  is_alive: boolean;
}

// --- Control key mapping ---

export const CONTROL_KEYS: Record<string, string> = {
  "ctrl+a": "\x01",
  "ctrl+b": "\x02",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+f": "\x06",
  "ctrl+g": "\x07",
  "ctrl+h": "\x08",
  "ctrl+i": "\x09",
  "ctrl+j": "\x0a",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+m": "\x0d",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+q": "\x11",
  "ctrl+r": "\x12",
  "ctrl+s": "\x13",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+v": "\x16",
  "ctrl+w": "\x17",
  "ctrl+x": "\x18",
  "ctrl+y": "\x19",
  "ctrl+z": "\x1a",
  "ctrl+\\": "\x1c",
  "ctrl+]": "\x1d",
  "enter": "\r",
  "tab": "\t",
  "escape": "\x1b",
  "up": "\x1b[A",
  "down": "\x1b[B",
  "right": "\x1b[C",
  "left": "\x1b[D",
  "home": "\x1b[H",
  "end": "\x1b[F",
  "backspace": "\x7f",
  "delete": "\x1b[3~",
  "pageup": "\x1b[5~",
  "pagedown": "\x1b[6~",
  "insert": "\x1b[2~",
  "shift+tab": "\x1b[Z",
  "shift+enter": "\x1b\r",
  "alt+enter": "\x1b\r",
  "option+enter": "\x1b\r",
  // SGR mouse wheel events (DEC 1006 protocol). These simulate mouse wheel
  // scrolling when the terminal app has enabled SGR mouse tracking. The
  // position (col 1, row 1) doesn't matter for scroll — apps only care
  // about the wheel direction (button code 64=up, 65=down).
  "wheelup": "\x1b[<64;1;1M",
  "wheeldown": "\x1b[<65;1;1M",
};
