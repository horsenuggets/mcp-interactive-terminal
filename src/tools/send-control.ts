import { z } from "zod";
import { execSync } from "node:child_process";
import type { SessionManager } from "../session-manager.js";
import type { ServerConfig, SendControlOutput } from "../types.js";
import { CONTROL_KEYS } from "../types.js";
import { sanitize } from "../utils/sanitizer.js";
import { redactSecrets } from "../utils/secret-redactor.js";
import { audit } from "../utils/audit-logger.js";

/**
 * Get all descendant PIDs of a process (children, grandchildren, etc.).
 * Works on macOS and Linux via pgrep.
 */
function getDescendantPids(pid: number): number[] {
  try {
    const out = execSync(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
    if (!out) return [];
    const children = out.split("\n").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    const descendants = [...children];
    for (const child of children) {
      descendants.push(...getDescendantPids(child));
    }
    return descendants;
  } catch {
    return []; // pgrep returns exit code 1 if no matches
  }
}

export const sendControlSchema = z.object({
  session_id: z.string().describe("The session ID"),
  control: z.string().describe(
    `Control sequence to send. Supported: ${Object.keys(CONTROL_KEYS).join(", ")}`
  ),
  count: z.number().int().min(1).max(100).default(1).describe(
    "Number of times to send the control sequence (default: 1). Useful for sending multiple wheel ticks."
  ),
  interval_ms: z.number().int().min(0).max(5000).default(0).describe(
    "Milliseconds to wait between repeated events when count > 1. Default 0 sends all events in one PTY write (they coalesce into one input batch in the target process). Set to ~16 to mimic 60Hz trackpad wheel events, ~33 for 30Hz, ~50 for slower deliberate keypresses. Required for reproducing UI bugs that depend on inter-event timing — e.g. React renders/commits landing between events."
  ),
});

export type SendControlArgs = z.infer<typeof sendControlSchema>;

const CONTROL_WAIT_MS = 500;

/**
 * Write `sequence` to the PTY `count` times. When `intervalMs > 0`, waits
 * between writes so the target process sees N separate input batches
 * spaced by `intervalMs` (mimics real-user input timing — trackpad wheel
 * ~16ms, key-repeat ~33-50ms). When `intervalMs === 0`, the writes are
 * coalesced into a single PTY write that the kernel and target process
 * see as one chunk (faster, but bypasses any event-driven app logic that
 * depends on inter-event gaps).
 */
async function writeRepeated(
  terminal: { write: (data: string) => void },
  sequence: string,
  count: number,
  intervalMs: number,
): Promise<void> {
  if (intervalMs <= 0 || count <= 1) {
    terminal.write(sequence.repeat(count));
    return;
  }
  for (let i = 0; i < count; i++) {
    terminal.write(sequence);
    if (i < count - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

export async function handleSendControl(
  args: SendControlArgs,
  sessionManager: SessionManager,
  config: ServerConfig,
): Promise<SendControlOutput> {
  if (config.logInputs) {
    console.error(`[mcp-terminal] send_control [${args.session_id}]: ${args.control}`);
  }

  const session = sessionManager.getSession(args.session_id);

  if (!session.isAlive) {
    throw new Error(`Session "${args.session_id}" is not alive`);
  }

  const key = args.control.toLowerCase();
  const sequence = CONTROL_KEYS[key];

  if (!sequence) {
    throw new Error(
      `Unknown control key "${args.control}". Supported: ${Object.keys(CONTROL_KEYS).join(", ")}`
    );
  }

  audit("control", args.session_id, { control: key });
  sessionManager.touchSession(args.session_id);

  const count = args.count ?? 1;
  const intervalMs = args.interval_ms ?? 0;

  // In pipe mode, certain control keys need special handling
  if (session.terminal.mode === "pipe") {
    if (key === "ctrl+d") {
      // EOF — close stdin
      const proc = session.terminal.process as import("node:child_process").ChildProcess;
      proc.stdin?.end();
    } else if (key === "ctrl+c" || key === "ctrl+\\" || key === "ctrl+z") {
      // Send signal to all descendant processes (deepest-first), then the shell itself
      const signalMap: Record<string, NodeJS.Signals> = {
        "ctrl+c": "SIGINT",
        "ctrl+\\": "SIGQUIT",
        "ctrl+z": "SIGTSTP",
      };
      const sig = signalMap[key];
      const descendants = getDescendantPids(session.terminal.pid);
      // Signal deepest descendants first (reverse order)
      for (const dpid of descendants.reverse()) {
        try { process.kill(dpid, sig); } catch { /* already exited */ }
      }
      // Also signal the shell process itself
      try { process.kill(session.terminal.pid, sig); } catch { /* ignore */ }
    } else {
      await writeRepeated(session.terminal, sequence, count, intervalMs);
    }
  } else {
    // Write the raw byte to the PTY. In raw mode the \x03 byte is passed
    // through to the app's stdin — no kernel SIGINT is generated. Sending
    // an explicit SIGINT would bypass app-level double-press handlers (the
    // app sees the signal before the stdin byte) and cause premature exit.
    await writeRepeated(session.terminal, sequence, count, intervalMs);
  }

  // Brief wait for response
  await new Promise((resolve) => setTimeout(resolve, CONTROL_WAIT_MS));

  let output = session.terminal.readScreen().text;
  output = sanitize(output, { maxChars: config.maxOutput });

  if (config.redactSecrets) {
    output = redactSecrets(output);
  }

  return { output };
}
