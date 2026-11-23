import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  cellForegroundAlpha,
  foregroundChangeFromSgr,
  installForegroundAlpha,
  OPAQUE,
  type SgrParams,
} from "../src/foreground-alpha.js";
import { glyphOpacity } from "../src/skia-render.js";
import { createTerminal } from "../src/terminal.js";
import type { TerminalWrapper } from "../src/types.js";
import { canSpawnPty } from "./can-spawn-pty.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");

const RGBA = "\x1b[38:6::1:2:3:64m";
const RGB = 0x010203;

describe("foregroundChangeFromSgr", () => {
  it("treats an empty sequence and SGR 0 as a reset to full opacity", () => {
    expect(foregroundChangeFromSgr([])).toEqual({ alpha: OPAQUE, rgb: null });
    expect(foregroundChangeFromSgr([0])).toEqual({ alpha: OPAQUE, rgb: null });
  });

  it("reads the RGBA color with and without the color space slot", () => {
    expect(foregroundChangeFromSgr([38, [6, -1, 1, 2, 3, 64]])).toEqual({ alpha: 64, rgb: RGB });
    expect(foregroundChangeFromSgr([38, [6, 1, 2, 3, 64]])).toEqual({ alpha: 64, rgb: RGB });
  });

  it("ignores malformed RGBA colors", () => {
    expect(foregroundChangeFromSgr([38, [6, 1, 2, 3]])).toBeNull();
    expect(foregroundChangeFromSgr([38, [6, -1, 1, 2, 3, 300]])).toBeNull();
    expect(foregroundChangeFromSgr([38, [6, -1, 1, -1, 3, 64]])).toBeNull();
  });

  it("restores full opacity for every other foreground change", () => {
    const resets: SgrParams[] = [[30], [37], [39], [90], [97], [38, 5, 1], [38, 2, 1, 2, 3], [38, [2, -1, 1, 2, 3]], [38, [5, 1]]];
    for (const params of resets) expect(foregroundChangeFromSgr(params)).toEqual({ alpha: OPAQUE, rgb: null });
  });

  it("leaves the foreground alone for background, underline, and style changes", () => {
    const unrelated: SgrParams[] = [[1], [2], [22], [41], [49], [48, 2, 31, 32, 33], [48, 5, 31], [58, [2, -1, 1, 2, 3]], [59], [7]];
    for (const params of unrelated) expect(foregroundChangeFromSgr(params)).toBeNull();
  });

  it("lets the last foreground change in a sequence win", () => {
    expect(foregroundChangeFromSgr([38, [6, -1, 1, 2, 3, 64], 39])).toEqual({ alpha: OPAQUE, rgb: null });
    expect(foregroundChangeFromSgr([31, 38, [6, -1, 1, 2, 3, 64], 1])).toEqual({ alpha: 64, rgb: RGB });
    expect(foregroundChangeFromSgr([0, 1, 38, [6, -1, 1, 2, 3, 64], 48, 2, 31, 32, 33])).toEqual({ alpha: 64, rgb: RGB });
  });

  it("is pure", () => {
    const params: SgrParams = [1, 38, [6, -1, 1, 2, 3, 64]];
    expect(foregroundChangeFromSgr(params)).toEqual(foregroundChangeFromSgr(params));
    expect(params).toEqual([1, 38, [6, -1, 1, 2, 3, 64]]);
  });
});

describe("glyphOpacity", () => {
  it("multiplies faint text with the foreground alpha", () => {
    for (const dim of [false, true]) {
      for (const fgAlpha of [0, 64, 255]) {
        expect(glyphOpacity({ dim, fgAlpha })).toBeCloseTo((dim ? 0.5 : 1) * (fgAlpha / 255));
      }
    }
  });
});

/** A headless xterm with the RGBA extension installed. */
function makeTerminal(cols = 20, rows = 4): any {
  const xterm = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  expect(installForegroundAlpha(xterm)).toBe(true);
  return xterm;
}

function write(xterm: any, data: string): Promise<void> {
  return new Promise((resolve) => xterm.write(data, resolve));
}

/** The alpha and RGB foreground of each cell in a buffer line. */
function lineStyles(xterm: any, line: number, count: number): { alpha: number; rgb: number | null }[] {
  const buffer = xterm.buffer.active;
  const bufferLine = buffer.getLine(line);
  const cell = buffer.getNullCell();
  const styles = [];
  for (let x = 0; x < count; x++) {
    bufferLine.getCell(x, cell);
    styles.push({ alpha: cellForegroundAlpha(cell), rgb: cell.isFgRGB() ? cell.getFgColor() : null });
  }
  return styles;
}

describe("installForegroundAlpha", () => {
  it("sets the color and alpha of translucent text without leaking into later cells", async () => {
    const xterm = makeTerminal();
    await write(xterm, `${RGBA}A\x1b[39mB`);
    expect(lineStyles(xterm, 0, 2)).toEqual([
      { alpha: 64, rgb: RGB },
      { alpha: OPAQUE, rgb: null },
    ]);
  });

  it("resets on foreground changes and survives everything else", async () => {
    const cases: [string, number][] = [
      ["\x1b[0m", OPAQUE],
      ["\x1b[39m", OPAQUE],
      ["\x1b[31m", OPAQUE],
      ["\x1b[91m", OPAQUE],
      ["\x1b[38;5;123m", OPAQUE],
      ["\x1b[38;2;1;2;3m", OPAQUE],
      ["\x1b[38:2::1:2:3m", OPAQUE],
      ["\x1b[41m", 64],
      ["\x1b[48;2;31;32;33m", 64],
      ["\x1b[49m", 64],
      ["\x1b[1;2;3;4;7;9m", 64],
      ["\x1b[22;23;24;27;29m", 64],
      ["\x1b[58:2::1:2:3;59m", 64],
    ];
    for (const [sequence, alpha] of cases) {
      const xterm = makeTerminal();
      await write(xterm, `${RGBA}A${sequence}B`);
      expect(lineStyles(xterm, 0, 2).map((style) => style.alpha), JSON.stringify(sequence)).toEqual([64, alpha]);
    }
  });

  it("keeps the alpha on text that scrolls into the scrollback", async () => {
    const xterm = makeTerminal(20, 2);
    await write(xterm, `${RGBA}A\x1b[0m\r\n\n\n\n\n`);
    expect(xterm.buffer.active.baseY).toBeGreaterThan(0);
    expect(lineStyles(xterm, 0, 1)).toEqual([{ alpha: 64, rgb: RGB }]);
  });

  it("works on several terminals at once", async () => {
    const first = makeTerminal();
    const second = makeTerminal();
    await write(first, `${RGBA}A`);
    await write(second, "\x1b[38:6::9:9:9:200mA");
    expect(lineStyles(first, 0, 1)).toEqual([{ alpha: 64, rgb: RGB }]);
    expect(lineStyles(second, 0, 1)).toEqual([{ alpha: 200, rgb: 0x090909 }]);
  });

  it("leaves terminals without the expected internals untouched", () => {
    expect(installForegroundAlpha({})).toBe(false);
    expect(installForegroundAlpha(null)).toBe(false);
  });
});

const BASH = "/bin/bash";
const itPty = canSpawnPty(BASH) ? it : it.skip;

describe("translucent text from a live terminal", () => {
  let terminal: TerminalWrapper | null = null;

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
  });

  itPty("reports the alpha to the renderer and in raw ANSI output", async () => {
    terminal = await createTerminal({ command: BASH });
    terminal.write("printf 'X\\033[38:6::1:2:3:64mY\\033[0mZ\\n'\n");
    await terminal.waitForOutput(3000);
    await new Promise((r) => setTimeout(r, 300));

    const rows = terminal.getScreenCells()!.rows;
    const line = rows.find((row) => row.map((c) => c.chars).join("").startsWith("XYZ"));
    expect(line).toBeDefined();
    expect(line!.slice(0, 3).map((c) => c.fgAlpha)).toEqual([OPAQUE, 64, OPAQUE]);

    const raw = terminal.readScreen(false, true).text;
    expect(raw).toContain("X\x1b[38:6::1:2:3:64mY\x1b[39mZ");
  }, 10000);
});
