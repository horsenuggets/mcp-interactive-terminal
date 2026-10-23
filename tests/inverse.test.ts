import { describe, it, expect, afterEach } from "vitest";
import { cellPaintColors } from "../src/skia-render.js";
import { createTerminal } from "../src/terminal.js";
import type { CellColorSpec, TerminalWrapper } from "../src/types.js";
import { canSpawnPty } from "./can-spawn-pty.js";

const COLORS = { background: "#000000", foreground: "#ffffff" };
const RED: CellColorSpec = { mode: "rgb", value: 0xff0000 };
const BLUE: CellColorSpec = { mode: "rgb", value: 0x0000ff };
const DEFAULT: CellColorSpec = { mode: "default" };

// Mirrors the renderer's resolver for rgb and default specs.
function resolve(spec: CellColorSpec, fallback: string | null): string | null {
  if (spec.mode === "rgb") return `#${spec.value.toString(16).padStart(6, "0")}`;
  return fallback;
}

describe("cellPaintColors", () => {
  it("walks every combination of inverse and explicit or default colors", () => {
    for (const inverse of [false, true]) {
      for (const fg of [DEFAULT, RED]) {
        for (const bg of [DEFAULT, BLUE]) {
          const fgHex = fg === RED ? "#ff0000" : null;
          const bgHex = bg === BLUE ? "#0000ff" : null;
          const expected = inverse
            ? { bg: fgHex ?? COLORS.foreground, fg: bgHex ?? COLORS.background }
            : { bg: bgHex, fg: fgHex ?? COLORS.foreground };
          expect(cellPaintColors({ bg, fg, inverse }, resolve, COLORS)).toEqual(expected);
        }
      }
    }
  });

  it("always fills an inverse cell, even with default colors", () => {
    expect(cellPaintColors({ bg: DEFAULT, fg: DEFAULT, inverse: true }, resolve, COLORS).bg).toBe(COLORS.foreground);
  });
});

// Pattern for one SGR sequence that includes `param` among its parameters.
function sgrWith(param: string): string {
  return `\\x1b\\[(?:[0-9;]*;)?${param}(?:;[0-9;]*)?m`;
}

const BASH = "/bin/bash";
const itPty = canSpawnPty(BASH) ? it : it.skip;

describe("inverse cells from a live terminal", () => {
  let terminal: TerminalWrapper | null = null;

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
  });

  itPty("marks SGR 7 cells inverse and keeps SGR 7 in raw ANSI output", async () => {
    terminal = await createTerminal({ command: BASH });
    // A thumb-colored lower block drawn inverted, like a scrollbar's bottom edge,
    // then a plain one.
    terminal.write("printf 'A\\033[7;38;2;177;185;249mB\\033[0mC\\n'\n");
    await terminal.waitForOutput(3000);
    await new Promise((r) => setTimeout(r, 300));

    const rows = terminal.getScreenCells()!.rows;
    const line = rows.find((row) => row.map((c) => c.chars).join("").startsWith("ABC"));
    expect(line).toBeDefined();
    expect(line!.slice(0, 3).map((c) => c.inverse)).toEqual([false, true, false]);

    const raw = terminal.readScreen(false, true).text;
    expect(raw).toMatch(new RegExp(`A${sgrWith("7")}B${sgrWith("27")}C`));
  }, 10000);

  itPty("keeps inverse-space rows at both screen boundaries in raw output", async () => {
    terminal = await createTerminal({ command: BASH, rows: 6 });
    // Clear the screen, paint an inverse-space row at the very top, then home the
    // cursor to the bottom row and paint another one there.
    terminal.write("clear; printf '\\033[1;1H\\033[7m   \\033[0m\\033[6;1H\\033[7m   \\033[0m'; sleep 5\n");
    await new Promise((r) => setTimeout(r, 1500));

    const plain = terminal.readScreen(false, false);
    const raw = terminal.readScreen(false, true);
    // Raw mode keeps both painted rows, so nothing is trimmed from either end.
    expect(raw.topOffset).toBe(0);
    const rawLines = raw.text.split("\n");
    expect(rawLines).toHaveLength(6);
    for (const line of [rawLines[0]!, rawLines[5]!]) expect(line).toMatch(new RegExp(`${sgrWith("7")} {3}`));
    // Plain-text trimming is unchanged: the space-only rows still trim away.
    expect(plain.text).toBe("");
  }, 10000);
});
