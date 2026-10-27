import { describe, it, expect } from "vitest";
import { handleResizeSession, resizeSessionSchema } from "../src/tools/resize-session.js";
import type { SessionManager } from "../src/session-manager.js";

function stubSession() {
  const calls: Array<[number, number]> = [];
  const reads: Array<unknown[]> = [];
  const session = {
    cols: 120,
    rows: 30,
    terminal: {
      resize: (cols: number, rows: number) => calls.push([cols, rows]),
      readScreen: (...args: unknown[]) => {
        reads.push(args);
        return { text: "line\n\n> ", topOffset: 0 };
      },
    },
  };
  const manager = { getSession: () => session } as unknown as SessionManager;
  return { calls, manager, reads, session };
}

describe("handleResizeSession", () => {
  it("resizes the terminal and records the new size on the session", async () => {
    const { calls, manager, session } = stubSession();
    const result = await handleResizeSession(
      { session_id: "s", cols: 60, rows: 20, settle_ms: 0 },
      manager,
    );
    expect(calls).toEqual([[60, 20]]);
    expect(session.cols).toBe(60);
    expect(session.rows).toBe(20);
    expect(result).toEqual({ cols: 60, rows: 20, output: "line\n\n> " });
  });

  it("reads the screen without trimming blank rows", async () => {
    const { manager, reads } = stubSession();
    await handleResizeSession({ session_id: "s", cols: 60, rows: 20, settle_ms: 0 }, manager);
    expect(reads).toEqual([[false, false, false]]);
  });

  it("throws for an unknown session", async () => {
    const manager = {
      getSession: () => {
        throw new Error('Session "x" not found');
      },
    } as unknown as SessionManager;
    await expect(
      handleResizeSession({ session_id: "x", cols: 60, rows: 20, settle_ms: 0 }, manager),
    ).rejects.toThrow('Session "x" not found');
  });

  it("rejects sizes outside the allowed range", () => {
    for (const [cols, rows] of [[9, 20], [301, 20], [60, 4], [60, 101]]) {
      expect(resizeSessionSchema.safeParse({ session_id: "s", cols, rows }).success).toBe(false);
    }
    expect(resizeSessionSchema.safeParse({ session_id: "s", cols: 60, rows: 20 }).success).toBe(true);
  });
});
