import { describe, it, expect } from "vitest";
import { applyGhosttyFontFamilies } from "../src/ghostty-config.js";

describe("applyGhosttyFontFamilies", () => {
  it("collects repeated font-family entries in order", () => {
    const config = [
      "# Font",
      "font-family = My Mono",
      "font-family = My Mono Emoji",
      "font-family = Fallback Nerd Font Mono",
      "font-size = 12",
    ].join("\n");
    expect(applyGhosttyFontFamilies(config)).toEqual([
      "My Mono",
      "My Mono Emoji",
      "Fallback Nerd Font Mono",
    ]);
  });

  it("strips quotes and ignores comments and other keys", () => {
    const config = ['font-family = "Quoted Mono"', "# font-family = Commented Out", "font-family-bold = Bold Mono"].join("\n");
    expect(applyGhosttyFontFamilies(config)).toEqual(["Quoted Mono"]);
  });

  it("resets the list on an empty value, including across files", () => {
    const families = applyGhosttyFontFamilies("font-family = First\nfont-family = Second");
    applyGhosttyFontFamilies('font-family = ""\nfont-family = Third', families);
    expect(families).toEqual(["Third"]);
  });

  it("returns an empty list when no font-family is set", () => {
    expect(applyGhosttyFontFamilies("theme = dark\n")).toEqual([]);
  });
});
