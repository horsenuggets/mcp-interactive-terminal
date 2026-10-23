/**
 * Reads the user's Ghostty font stack so screenshots and the live viewer render
 * with the same fonts as their terminal by default.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Applies the `font-family` entries in a Ghostty config to `families`, in order.
 * `font-family` is repeatable: each entry appends a fallback, and an empty value
 * (`font-family = ""`) clears everything set so far.
 */
export function applyGhosttyFontFamilies(text: string, families: string[] = []): string[] {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^font-family\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1]!.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value === "") {
      families.length = 0;
    } else {
      families.push(value);
    }
  }
  return families;
}

/** Ghostty's config file locations, in the order Ghostty loads them. */
function ghosttyConfigPaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const paths = [join(xdg, "ghostty", "config"), join(xdg, "ghostty", "config.ghostty")];
  if (process.platform === "darwin") {
    const appSupport = join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty");
    paths.push(join(appSupport, "config"), join(appSupport, "config.ghostty"));
  }
  return paths;
}

let cachedStack: string | null | undefined;

/**
 * The user's Ghostty `font-family` stack as a CSS-style comma-separated list,
 * or null when Ghostty isn't configured with any font families. Read once per
 * process; restart the MCP server to pick up config changes.
 */
export function ghosttyFontFamilyStack(): string | null {
  if (cachedStack !== undefined) return cachedStack;
  const families: string[] = [];
  for (const path of ghosttyConfigPaths()) {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    applyGhosttyFontFamilies(text, families);
  }
  cachedStack = families.length > 0 ? families.join(", ") : null;
  return cachedStack;
}
