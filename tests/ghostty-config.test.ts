import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGhosttyFontFamilies,
  readGhosttyFontFamilies,
  resolveGhosttyInclude,
} from "../src/ghostty-config.js";
import { quoteFontFamily, splitFontStack, unquoteFontFamily } from "../src/font-stack.js";
import { emojiFirstFontStack } from "../src/skia-render.js";

describe("applyGhosttyFontFamilies", () => {
  it("collects repeated font-family entries in order", () => {
    const config = [
      "# Font",
      "font-family = My Mono",
      "font-family = My Mono Emoji",
      "font-family = Fallback Nerd Font Mono",
      "font-size = 12",
    ].join("\n");
    expect(applyGhosttyFontFamilies(config).families).toEqual([
      "My Mono",
      "My Mono Emoji",
      "Fallback Nerd Font Mono",
    ]);
  });

  it("strips quotes and ignores comments and other keys", () => {
    const config = ['font-family = "Quoted Mono"', "# font-family = Commented Out", "font-family-bold = Bold Mono"].join("\n");
    expect(applyGhosttyFontFamilies(config).families).toEqual(["Quoted Mono"]);
  });

  it("resets the list on an empty value, including across files", () => {
    const { families } = applyGhosttyFontFamilies("font-family = First\nfont-family = Second");
    applyGhosttyFontFamilies('font-family = ""\nfont-family = Third', families);
    expect(families).toEqual(["Third"]);
  });

  it("returns an empty list when no font-family is set", () => {
    expect(applyGhosttyFontFamilies("theme = dark\n").families).toEqual([]);
  });

  it("collects config-file references in order", () => {
    expect(applyGhosttyFontFamilies("config-file = a.conf\nconfig-file = ?b.conf\n").includes).toEqual([
      "a.conf",
      "?b.conf",
    ]);
  });

  it("clears accumulated includes on an empty config-file value", () => {
    const result = applyGhosttyFontFamilies("config-file = old.conf\nconfig-file =\nconfig-file = fonts.conf\n");
    expect(result.includes).toEqual(["fonts.conf"]);
    expect(result.clearedIncludes).toBe(true);
  });
});

describe("resolveGhosttyInclude", () => {
  it("resolves relative paths against the including file and parses ?", () => {
    expect(resolveGhosttyInclude("fonts.conf", "/cfg/ghostty/config")).toEqual({
      path: "/cfg/ghostty/fonts.conf",
      optional: false,
    });
    expect(resolveGhosttyInclude("?/abs/x", "/cfg/config")).toEqual({ path: "/abs/x", optional: true });
    expect(resolveGhosttyInclude('"?literal"', "/cfg/config")).toEqual({ path: "/cfg/?literal", optional: false });
  });
});

describe("readGhosttyFontFamilies", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghostty-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads fonts from an include-only main config", () => {
    writeFileSync(join(dir, "config"), "config-file = fonts.conf\n");
    writeFileSync(join(dir, "fonts.conf"), "font-family = Included Mono\n");
    expect(readGhosttyFontFamilies([join(dir, "config")])).toEqual(["Included Mono"]);
  });

  it("applies includes after the file that references them", () => {
    writeFileSync(join(dir, "config"), 'config-file = reset.conf\nfont-family = Main Mono\n');
    writeFileSync(join(dir, "reset.conf"), 'font-family = ""\nfont-family = Override Mono\n');
    expect(readGhosttyFontFamilies([join(dir, "config")])).toEqual(["Override Mono"]);
  });

  it("resolves nested includes relative to their own file and stops on cycles", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "config"), "font-family = A\nconfig-file = sub/b.conf\n");
    writeFileSync(join(dir, "sub", "b.conf"), "font-family = B\nconfig-file = ../config\nconfig-file = ?missing.conf\n");
    expect(readGhosttyFontFamilies([join(dir, "config")])).toEqual(["A", "B"]);
  });

  it("processes nested includes after their siblings (shared queue order)", () => {
    // Ghostty loads a, b, then c (queued by a), so c's reset wins over b.
    writeFileSync(join(dir, "config"), "config-file = a.conf\nconfig-file = b.conf\n");
    writeFileSync(join(dir, "a.conf"), "config-file = c.conf\n");
    writeFileSync(join(dir, "b.conf"), 'font-family = ""\nfont-family = B Mono\n');
    writeFileSync(join(dir, "c.conf"), 'font-family = ""\nfont-family = C Mono\n');
    expect(readGhosttyFontFamilies([join(dir, "config")])).toEqual(["C Mono"]);
  });

  it("loads every root before any include", () => {
    mkdirSync(join(dir, "r2"));
    writeFileSync(join(dir, "config"), "font-family = Root One\nconfig-file = inc.conf\n");
    writeFileSync(join(dir, "inc.conf"), 'font-family = ""\nfont-family = Included\n');
    writeFileSync(join(dir, "r2", "config"), "font-family = Root Two\n");
    expect(readGhosttyFontFamilies([join(dir, "config"), join(dir, "r2", "config")])).toEqual(["Included"]);
  });

  it("drops pending includes when an empty config-file is seen", () => {
    writeFileSync(join(dir, "config"), "config-file = old.conf\nconfig-file =\nconfig-file = fonts.conf\n");
    writeFileSync(join(dir, "old.conf"), "font-family = Old Mono\n");
    writeFileSync(join(dir, "fonts.conf"), "font-family = New Mono\n");
    expect(readGhosttyFontFamilies([join(dir, "config")])).toEqual(["New Mono"]);
  });
});

describe("font stacks", () => {
  it("quotes and escapes literal family names", () => {
    expect(quoteFontFamily("Mono, Special")).toBe('"Mono, Special"');
    expect(quoteFontFamily('Odd "Name"')).toBe('"Odd \\"Name\\""');
  });

  it("splits on top-level commas only and round-trips quoted names", () => {
    const stack = ['"Mono, Special"', "'My Mono'", "Menlo"].join(", ");
    const entries = splitFontStack(stack);
    expect(entries).toEqual(['"Mono, Special"', "'My Mono'", "Menlo"]);
    expect(entries.map(unquoteFontFamily)).toEqual(["Mono, Special", "My Mono", "Menlo"]);
  });

  it("moves emoji families first without splitting quoted names", () => {
    const stack = [quoteFontFamily("Mono, Emoji Extras"), quoteFontFamily("My Mono"), "Menlo"].join(", ");
    expect(emojiFirstFontStack(stack)).toBe('"Mono, Emoji Extras", EmojiFallback, "My Mono", Menlo');
  });
});
