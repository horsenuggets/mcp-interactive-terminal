import { describe, it, expect } from "vitest";
import { handleResizeSession, resizeSessionSchema } from "../src/tools/resize-session.js";
import type { SessionManager } from "../src/session-manager.js";
import type { ServerConfig } from "../src/types.js";

const SECRET = "ghp_" + "a".repeat(36);
const SCREEN = `token ${SECRET}\n\n> `;

function config(redactSecrets: boolean): ServerConfig {
  return { redactSecrets } as ServerConfig;
}

function stubSession() {
  const calls: Array<[number, number]> = [];
  const reads: Array<unknown[]> = [];
  const touched: string[] = [];
  const session = {
    cols: 120,
    rows: 30,
    terminal: {
      resize: (cols: number, rows: number) => calls.push([cols, rows]),
      readScreen: (...args: unknown[]) => {
        reads.push(args);
        return { text: SCREEN, topOffset: 0 };
      },
    },
  };
  const manager = {
    getSession: () => session,
    touchSession: (id: string) => touched.push(id),
  } as unknown as SessionManager;
  return { calls, manager, reads, session, touched };
}

const ARGS = { session_id: "s", cols: 60, rows: 20, settle_ms: 0 };

describe("handleResizeSession", () => {
  it("resizes the terminal and records the new size on the session", async () => {
    const { calls, manager, session } = stubSession();
    const result = await handleResizeSession(ARGS, manager, config(false));
    expect(calls).toEqual([[60, 20]]);
    expect(session.cols).toBe(60);
    expect(session.rows).toBe(20);
    expect(result).toEqual({ cols: 60, rows: 20, output: SCREEN });
  });

  it("reads the screen without trimming blank rows", async () => {
    const { manager, reads } = stubSession();
    await handleResizeSession(ARGS, manager, config(false));
    expect(reads).toEqual([[false, false, false]]);
  });

  it("refreshes the session's idle timer", async () => {
    const { manager, touched } = stubSession();
    await handleResizeSession(ARGS, manager, config(false));
    expect(touched).toEqual(["s"]);
  });

  it("redacts secrets only when configured, keeping blank rows either way", async () => {
    for (const redact of [false, true]) {
      const { manager } = stubSession();
      const { output } = await handleResizeSession(ARGS, manager, config(redact));
      expect(output.includes(SECRET)).toBe(!redact);
      expect(output.endsWith("\n\n> ")).toBe(true);
    }
  });

  it("throws for an unknown session", async () => {
    const manager = {
      getSession: () => {
        throw new Error('Session "x" not found');
      },
    } as unknown as SessionManager;
    await expect(
      handleResizeSession({ ...ARGS, session_id: "x" }, manager, config(false)),
    ).rejects.toThrow('Session "x" not found');
  });

  it("rejects sizes outside the allowed range", () => {
    for (const [cols, rows] of [[9, 20], [301, 20], [60, 4], [60, 101]]) {
      expect(resizeSessionSchema.safeParse({ session_id: "s", cols, rows }).success).toBe(false);
    }
    expect(resizeSessionSchema.safeParse({ session_id: "s", cols: 60, rows: 20 }).success).toBe(true);
  });
});
