/**
 * Schema helpers for tool parameters that some MCP clients send as strings.
 * Numbers use z.coerce.number() directly; booleans need this helper, because
 * z.coerce.boolean() treats every non-empty string, including "false", as true.
 */

import { z } from "zod";

/** A boolean that also accepts the strings "true" and "false". */
export function booleanParam() {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean());
}
