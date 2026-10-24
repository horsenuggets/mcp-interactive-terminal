/**
 * Strip blank rows from both ends of a screen, and report how many leading rows were
 * removed so callers can map rows back to real screen coordinates.
 *
 * Trimming makes screen reads compact, but it also means row 0 of the result is only
 * screen row 0 when `topOffset` is 0. Anything that compares rows across reads, like a
 * frame recorder, must either skip trimming or account for `topOffset`.
 */
export function trimBlankRows(lines: string[], isBlank: (i: number) => boolean): { lines: string[]; topOffset: number } {
  let end = lines.length;
  while (end > 0 && isBlank(end - 1)) end--;
  let start = 0;
  while (start < end && isBlank(start)) start++;
  return { lines: lines.slice(start, end), topOffset: start };
}
