/**
 * The SGR parameters that move text from one bold and faint state to another. SGR 22
 * turns off both at once, so when either one turns off, the other is turned back on if
 * it should stay.
 */
export function intensitySgr(
  previous: { bold: boolean; dim: boolean },
  next: { bold: boolean; dim: boolean },
): string[] {
  if ((previous.bold && !next.bold) || (previous.dim && !next.dim)) {
    return ["22", ...(next.bold ? ["1"] : []), ...(next.dim ? ["2"] : [])];
  }
  return [...(next.bold && !previous.bold ? ["1"] : []), ...(next.dim && !previous.dim ? ["2"] : [])];
}
