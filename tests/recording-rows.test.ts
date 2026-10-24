import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../src/session-manager.js";
import { createTerminal } from "../src/terminal.js";
import { handleStartRecording, handleStopRecording } from "../src/tools/record-session.js";
import type { TerminalWrapper } from "../src/types.js";
import { trimBlankRows } from "../src/utils/trim-rows.js";
import { canSpawnPty } from "./can-spawn-pty.js";

const BASH = "/bin/bash";
const itPty = canSpawnPty(BASH) ? it : it.skip;

describe("trimBlankRows", () => {
  it("strips blank rows from both ends for every pattern of five rows", () => {
    for (let mask = 0; mask < 32; mask++) {
      const lines = Array.from({ length: 5 }, (_, i) => (mask & (1 << i) ? `row ${i}` : ""));
      const isBlank = (i: number) => lines[i] === "";
      const first = lines.findIndex((l) => l !== "");
      const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l !== "");
      const expected = first === -1 ? { lines: [], topOffset: 0 } : { lines: lines.slice(first, last + 1), topOffset: first };
      expect(trimBlankRows(lines, isBlank), `mask=${mask}`).toEqual(expected);
    }
  });

  it("keeps blank rows between content", () => {
    const lines = ["", "a", "", "b", ""];
    expect(trimBlankRows(lines, (i) => lines[i] === "")).toEqual({ lines: ["a", "", "b"], topOffset: 1 });
  });

  it("is pure", () => {
    const lines = ["", "a", ""];
    const run = () => trimBlankRows(lines, (i) => lines[i] === "");
    expect(run()).toEqual(run());
    expect(lines).toEqual(["", "a", ""]);
  });
});

describe("start_recording", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { force: true, recursive: true });
    dir = null;
  });

  it("records every screen row so a blank top row doesn't shift the frame", async () => {
    dir = mkdtempSync(join(tmpdir(), "recording-rows-"));
    const path = join(dir, "frames.jsonl");
    const screen = ["", "content", "", "status"];
    const calls: boolean[] = [];
    const terminal = {
      getCursorPosition: () => null,
      readScreen: (_fullScreen?: boolean, _rawAnsi?: boolean, trim = true) => {
        calls.push(trim);
        if (!trim) return { text: screen.join("\n"), topOffset: 0 };
        const trimmed = trimBlankRows(screen, (i) => screen[i] === "");
        return { text: trimmed.lines.join("\n"), topOffset: trimmed.topOffset };
      },
    };
    const sessionManager = { getSession: () => ({ isAlive: true, terminal }) } as unknown as SessionManager;
    // Frame 0 is captured synchronously on start.
    await handleStartRecording({ fps: 1, path, session_id: "s" }, sessionManager);
    await handleStopRecording({ session_id: "s" });
    const frames = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(frames.length).toBeGreaterThan(0);
    expect(calls.every((trim) => trim === false)).toBe(true);
    expect(frames[0].text.split("\n")).toEqual(screen);
  });
});

describe("untrimmed screen reads from a live terminal", () => {
  let terminal: TerminalWrapper | null = null;

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
  });

  itPty("keep one line per row, with content on its real row", async () => {
    terminal = await createTerminal({ command: BASH, rows: 6 });
    // Clear the screen and draw a single row partway down, leaving the rows above blank.
    terminal.write("clear; printf '\\033[3;1Hmiddle'; sleep 5\n");
    await new Promise((r) => setTimeout(r, 1500));

    const untrimmed = terminal.readScreen(false, false, false);
    const lines = untrimmed.text.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[2]).toBe("middle");
    expect(untrimmed.topOffset).toBe(0);
    // The default read still trims and reports the offset.
    const trimmed = terminal.readScreen();
    expect(trimmed.text.split("\n")[0]).toBe("middle");
    expect(trimmed.topOffset).toBe(2);
  }, 10000);
});
