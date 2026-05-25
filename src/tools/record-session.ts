/**
 * Frame recorder for terminal sessions.
 *
 * Captures the rendered terminal text at a fixed FPS to a JSONL file. Each
 * line is one frame: `{ "t": <ms-since-record-start>, "text": "<screen>" }`.
 *
 * Pure text capture (no PNG) — cheap enough to run at 60fps on a hot loop,
 * and trivial to diff afterwards to find visual jumps:
 *
 *   1. Build a per-frame fingerprint from a short slice of the screen.
 *   2. Walk consecutive frames and flag any where the visible content
 *      shifts by more than the running median (the jump).
 *
 * The recording is started + stopped explicitly so callers can bracket a
 * specific action (e.g. a scroll burst) and inspect only the frames they
 * care about. Multiple sessions can record concurrently, each to its own
 * file. Stopping any recording cancels its interval timer so the process
 * can exit cleanly.
 */
import { z } from "zod";
import { appendFileSync, writeFileSync, statSync } from "node:fs";
import type { SessionManager } from "../session-manager.js";

type Recording = {
  sessionId: string;
  path: string;
  fps: number;
  startedAt: number; // performance.now() at start
  frames: number;
  timer: NodeJS.Timeout;
};

const RECORDINGS = new Map<string, Recording>();

export const startRecordingSchema = z.object({
  session_id: z.string().describe("The session ID to record"),
  path: z
    .string()
    .describe(
      "Absolute path of the output JSONL file. One frame per line: " +
        "{ t, text, cursor }. Overwritten on start.",
    ),
  fps: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(30)
    .describe(
      "Capture rate in frames per second. 30 is enough to catch visual " +
        "jumps; 60 is closer to the underlying paint rate; 120 stresses " +
        "the event loop but is useful for catching sub-frame races.",
    ),
});

export type StartRecordingArgs = z.infer<typeof startRecordingSchema>;

export async function handleStartRecording(
  args: StartRecordingArgs,
  sessionManager: SessionManager,
): Promise<{ ok: true; path: string; fps: number }> {
  const session = sessionManager.getSession(args.session_id);
  if (!session.isAlive) {
    throw new Error(`Session "${args.session_id}" is not alive`);
  }
  // Stop any existing recording for this session so we don't end up with
  // two timers writing to the same target (or different targets) and
  // leaking the original timer past process exit.
  const existing = RECORDINGS.get(args.session_id);
  if (existing) {
    clearInterval(existing.timer);
    RECORDINGS.delete(args.session_id);
  }

  // Truncate the output file so callers starting a new run don't read a
  // mixture of old + new frames. Single write to confirm the path is
  // writable before we kick off the interval; if it throws, the caller
  // gets a clean error instead of a silent timer that fails on every tick.
  writeFileSync(args.path, "");

  const startedAt = performance.now();
  const intervalMs = 1000 / args.fps;
  const sessionId = args.session_id;
  const path = args.path;

  const rec: Recording = {
    sessionId,
    path,
    fps: args.fps,
    startedAt,
    frames: 0,
    // Initialized below after `tick` is in scope. setInterval's first
    // tick fires AFTER intervalMs, so capture frame 0 synchronously.
    timer: undefined as unknown as NodeJS.Timeout,
  };

  const tick = (): void => {
    try {
      const screen = session.terminal.readScreen(false, false);
      const cursor = session.terminal.getCursorPosition();
      const entry = JSON.stringify({
        t: +(performance.now() - startedAt).toFixed(2),
        text: screen.text,
        cursor: cursor ? { col: cursor.col, row: cursor.row } : null,
      });
      appendFileSync(path, entry + "\n");
      rec.frames++;
    } catch {
      // Swallow read errors — a session that just exited will throw on
      // readScreen but the timer should still get cleared when stop_recording
      // is called. Logging would spam stderr at FPS for dead sessions.
    }
  };

  // Frame 0 at t=0, then on the interval.
  tick();
  rec.timer = setInterval(tick, intervalMs);
  RECORDINGS.set(sessionId, rec);

  return { ok: true, path, fps: args.fps };
}

export const stopRecordingSchema = z.object({
  session_id: z.string().describe("The session ID whose recording to stop"),
});

export type StopRecordingArgs = z.infer<typeof stopRecordingSchema>;

export async function handleStopRecording(
  args: StopRecordingArgs,
): Promise<{
  ok: true;
  path: string;
  fps: number;
  frames: number;
  durationMs: number;
  fileSize: number;
}> {
  const rec = RECORDINGS.get(args.session_id);
  if (!rec) {
    throw new Error(`No active recording for session "${args.session_id}"`);
  }
  clearInterval(rec.timer);
  RECORDINGS.delete(args.session_id);
  const durationMs = +(performance.now() - rec.startedAt).toFixed(2);
  let fileSize = 0;
  try {
    fileSize = statSync(rec.path).size;
  } catch {
    // path may have been deleted under us; size 0 is honest enough.
  }
  return {
    ok: true,
    path: rec.path,
    fps: rec.fps,
    frames: rec.frames,
    durationMs,
    fileSize,
  };
}

/** Stop any recordings tied to a session. Called on close_session. */
export function stopRecordingForSession(sessionId: string): void {
  const rec = RECORDINGS.get(sessionId);
  if (!rec) return;
  clearInterval(rec.timer);
  RECORDINGS.delete(sessionId);
}
