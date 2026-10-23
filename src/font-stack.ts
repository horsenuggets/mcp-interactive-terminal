/**
 * Helpers for CSS-style font-family stacks ("A", 'B', C). Family names can
 * contain commas when quoted, so stacks must be split and joined quote-aware.
 */

/** Quotes a literal family name for use in a CSS font stack. */
export function quoteFontFamily(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Splits a stack on top-level commas, keeping each entry's quoting intact. */
export function splitFontStack(stack: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < stack.length; i++) {
    const ch = stack[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < stack.length) {
        current += stack[++i];
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      entries.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  entries.push(current.trim());
  return entries.filter(Boolean);
}

/** The family name an entry refers to, with surrounding quotes and escapes removed. */
export function unquoteFontFamily(entry: string): string {
  const q = entry[0];
  if ((q === '"' || q === "'") && entry.length >= 2 && entry.endsWith(q)) {
    return entry.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return entry;
}
