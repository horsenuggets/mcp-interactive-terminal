import { describe, it, expect } from "vitest";
import { handleScreenshotSession } from "../src/tools/screenshot-session.js";
import type { SessionManager } from "../src/session-manager.js";

// save_path is validated before the session is looked up, so a stub that only
// answers isPathAllowed is enough to exercise those checks.
function stubManager(allowed: boolean): SessionManager {
  return {
    isRealPathAllowed: () => allowed,
    getSession: () => {
      throw new Error("getSession should not be reached");
    },
  } as unknown as SessionManager;
}

describe("handleScreenshotSession save_path", () => {
  it("rejects a relative save_path", async () => {
    const result = await handleScreenshotSession(
      { session_id: "s", save_path: "shot.png" },
      stubManager(true),
    );
    expect(result).toEqual({ error: "save_path must be an absolute path" });
  });

  it("rejects a save_path outside the allowed paths", async () => {
    const result = await handleScreenshotSession(
      { session_id: "s", save_path: "/etc/shot.png" },
      stubManager(false),
    );
    expect(result).toEqual({ error: 'Path "/etc/shot.png" is outside the configured allowed paths.' });
  });

  it("rejects parent-traversal segments even when the lexical path is allowed", async () => {
    // /allowed/link/../shot.png normalizes to /allowed/shot.png, but if `link`
    // is a symlink the filesystem would resolve it somewhere else entirely.
    const result = await handleScreenshotSession(
      { session_id: "s", save_path: "/allowed/link/../shot.png" },
      stubManager(true),
    );
    expect(result).toEqual({ error: 'save_path must not contain ".." segments' });
  });
});
