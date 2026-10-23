/**
 * Reads the user's Ghostty font stack so screenshots and the live viewer render
 * with the same fonts as their terminal by default.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { quoteFontFamily } from "./font-stack.js";

export interface GhosttyConfigEntries {
  families: string[];
  /** `config-file` references in the order they appear, as written. */
  includes: string[];
}

function unquoteValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Applies the `font-family` entries in one Ghostty config file to `families`, in
 * order, and collects its `config-file` references. `font-family` is repeatable:
 * each entry appends a fallback, and an empty value clears everything so far.
 */
export function applyGhosttyFontFamilies(
  text: string,
  families: string[] = [],
): GhosttyConfigEntries {
  const includes: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^(font-family|config-file)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    if (match[1] === "config-file") {
      if (raw !== "") includes.push(raw);
      continue;
    }
    const value = unquoteValue(raw);
    if (value === "") {
      families.length = 0;
    } else {
      families.push(value);
    }
  }
  return { families, includes };
}

/**
 * Resolves a `config-file` value relative to the file that references it. A
 * leading `?` (outside quotes) marks the include as optional.
 */
export function resolveGhosttyInclude(
  raw: string,
  fromFile: string,
): { path: string; optional: boolean } {
  let value = raw;
  let optional = false;
  if (value.startsWith("?")) {
    optional = true;
    value = value.slice(1);
  }
  value = unquoteValue(value);
  if (value === "~" || value.startsWith("~/")) value = join(homedir(), value.slice(1));
  const path = isAbsolute(value) ? value : resolve(dirname(fromFile), value);
  return { path, optional };
}

/**
 * Loads a config file, then its `config-file` includes in order, matching
 * Ghostty: includes take effect after the file that references them. Files
 * already on the load chain are skipped so include cycles terminate.
 */
function loadGhosttyConfig(path: string, families: string[], chain: Set<string>): void {
  if (chain.has(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  chain.add(path);
  const { includes } = applyGhosttyFontFamilies(text, families);
  for (const raw of includes) {
    loadGhosttyConfig(resolveGhosttyInclude(raw, path).path, families, chain);
  }
  chain.delete(path);
}

/** Ghostty's default config file locations, in the order Ghostty loads them. */
function ghosttyConfigPaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const paths = [join(xdg, "ghostty", "config"), join(xdg, "ghostty", "config.ghostty")];
  if (process.platform === "darwin") {
    const appSupport = join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty");
    paths.push(join(appSupport, "config"), join(appSupport, "config.ghostty"));
  }
  return paths;
}

/** Reads the Ghostty font families from the given root config files. */
export function readGhosttyFontFamilies(rootPaths: string[]): string[] {
  const families: string[] = [];
  for (const path of rootPaths) loadGhosttyConfig(path, families, new Set());
  return families;
}

let cachedStack: string | null | undefined;

/**
 * The user's Ghostty `font-family` stack as a CSS font stack with each family
 * quoted, or null when Ghostty isn't configured with any font families. Read
 * once per process; restart the MCP server to pick up config changes.
 */
export function ghosttyFontFamilyStack(): string | null {
  if (cachedStack !== undefined) return cachedStack;
  const families = readGhosttyFontFamilies(ghosttyConfigPaths());
  cachedStack = families.length > 0 ? families.map(quoteFontFamily).join(", ") : null;
  return cachedStack;
}
