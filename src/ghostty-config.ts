/**
 * Reads the user's Ghostty font stack so screenshots and the live viewer render
 * with the same fonts as their terminal by default.
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { quoteFontFamily } from "./font-stack.js";

export interface GhosttyConfigEntries {
  families: string[];
  /** `config-file` references after the last reset, in order, as written. */
  includes: string[];
  /** True if an empty `config-file =` cleared the include list in this file. */
  clearedIncludes: boolean;
}

function unquoteValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Applies the `font-family` entries in one Ghostty config file to `families`, in
 * order, and collects its `config-file` references. Both keys are repeatable:
 * each entry appends, and an empty value clears everything accumulated so far.
 */
export function applyGhosttyFontFamilies(
  text: string,
  families: string[] = [],
): GhosttyConfigEntries {
  const includes: string[] = [];
  let clearedIncludes = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^(font-family|config-file)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    if (match[1] === "config-file") {
      if (unquoteValue(raw) === "") {
        includes.length = 0;
        clearedIncludes = true;
      } else {
        includes.push(raw);
      }
      continue;
    }
    const value = unquoteValue(raw);
    if (value === "") {
      families.length = 0;
    } else {
      families.push(value);
    }
  }
  return { families, includes, clearedIncludes };
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
  const lexical = isAbsolute(value) ? value : resolve(dirname(fromFile), value);
  // Like Ghostty, use the real path of an existing file so its own relative
  // includes resolve next to the symlink target. Missing files keep the lexical path.
  let path = lexical;
  try {
    path = realpathSync(lexical);
  } catch {}
  return { path, optional };
}

/**
 * Loads one config file into `families` and queues its includes. An empty
 * `config-file =` drops every include still waiting in the queue.
 */
function loadGhosttyConfigFile(path: string, families: string[], queue: string[]): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  const { includes, clearedIncludes } = applyGhosttyFontFamilies(text, families);
  if (clearedIncludes) queue.length = 0;
  for (const raw of includes) queue.push(resolveGhosttyInclude(raw, path).path);
  return clearedIncludes;
}

/**
 * Ghostty's default config file locations, in the order Ghostty loads them:
 * in each directory `config.ghostty` then the legacy `config`, XDG before the
 * macOS Application Support directory (https://ghostty.org/docs/config).
 */
export function ghosttyConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const dirs = [join(env.XDG_CONFIG_HOME || join(home, ".config"), "ghostty")];
  if (platform === "darwin") {
    dirs.push(join(home, "Library", "Application Support", "com.mitchellh.ghostty"));
  }
  return dirs.flatMap((dir) => [join(dir, "config.ghostty"), join(dir, "config")]);
}

/**
 * Reads the Ghostty font families from the given root config files, matching
 * Ghostty's load order: every root loads first, then one shared include queue
 * is processed in insertion order (includes found along the way are appended).
 * Any file already loaded is skipped, so include cycles terminate.
 */
export function readGhosttyFontFamilies(rootPaths: string[]): string[] {
  const families: string[] = [];
  const queue: string[] = [];
  const loaded = new Set<string>();
  for (const rootPath of rootPaths) {
    let path = rootPath;
    try {
      path = realpathSync(rootPath);
    } catch {}
    loaded.add(path);
    loadGhosttyConfigFile(path, families, queue);
  }
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i]!;
    if (loaded.has(path)) continue;
    loaded.add(path);
    // An empty config-file in this file emptied the queue (keeping only what it
    // added afterwards), so continue from the start of the new queue.
    if (loadGhosttyConfigFile(path, families, queue)) i = -1;
  }
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
