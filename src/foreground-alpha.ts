/**
 * Foreground text opacity from the WezTerm RGBA SGR extension (`ESC [ 38:6::R:G:B:A m`),
 * which terminals like GhosttyX support.
 *
 * xterm.js ignores color space 6, so this layers it on top. After xterm applies each SGR
 * sequence, the last foreground change in it decides the opacity. An RGBA color sets the
 * RGB foreground and its alpha, and any other foreground change (SGR 0, 30 to 37, 38,
 * 39, or 90 to 97) restores full opacity. Background and underline colors leave it
 * alone, as in GhosttyX. The alpha lives on xterm's per-cell extended attributes, so it
 * moves with the text through scrolling, erasing, and reflow like any other attribute.
 */

/** SGR parameters as xterm's `Params.toArray()` lists them, with each parameter's
 *  colon sub-parameters in an array right after it. */
export type SgrParams = (number | number[])[];

/** The foreground change an SGR sequence makes, as an alpha and an optional RGB color. */
export interface ForegroundChange {
  /** The opacity from 0 (transparent) to 255 (opaque). */
  alpha: number;
  /** The `0xRRGGBB` color an RGBA sequence sets, or null to keep xterm's color. */
  rgb: number | null;
}

export const OPAQUE = 255;

// xterm's attribute bits. The foreground word keeps its color in the low 24 bits and the
// color mode in the next 2, and the background word flags cells with extended attributes.
const FG_COLOR_BITS = 0x3ffffff;
const FG_MODE_RGB = 0x3000000;
const BG_HAS_EXTENDED = 0x10000000;

const ALPHA_KEY = Symbol("foregroundAlpha");
const PATCHED_KEY = Symbol("foregroundAlphaPatched");

/**
 * The RGBA change from the sub-parameters of `38:6`, accepting both the standard form
 * with an empty color space slot (`38:6::R:G:B:A`) and the shorter form without it
 * (`38:6:R:G:B:A`). Returns null for anything malformed, which leaves the color alone.
 */
function rgbaChange(subParams: number[]): ForegroundChange | null {
  let channels: number[];
  if (subParams.length === 6) channels = subParams.slice(2);
  else if (subParams.length === 5) channels = subParams.slice(1);
  else return null;
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  const [r, g, b, a] = channels as [number, number, number, number];
  return { alpha: a, rgb: (r << 16) | (g << 8) | b };
}

/**
 * The last foreground change in one SGR sequence, or null when it doesn't touch the
 * foreground. An empty sequence is a reset. Semicolon forms of extended colors (e.g.
 * `48;2;R;G;B`) skip their arguments, so a channel value like 31 isn't read as red.
 */
export function foregroundChangeFromSgr(params: SgrParams): ForegroundChange | null {
  const groups: { subParams: number[] | null; value: number }[] = [];
  for (const param of params) {
    if (Array.isArray(param)) {
      const owner = groups[groups.length - 1];
      if (owner) owner.subParams = param;
    } else {
      groups.push({ subParams: null, value: param });
    }
  }
  const opaque: ForegroundChange = { alpha: OPAQUE, rgb: null };
  if (groups.length === 0) return opaque;

  let change: ForegroundChange | null = null;
  for (let i = 0; i < groups.length; i++) {
    const { subParams, value } = groups[i]!;
    if (value === 38 || value === 48 || value === 58) {
      if (subParams) {
        if (value === 38) change = subParams[0] === 6 ? (rgbaChange(subParams) ?? change) : opaque;
        continue;
      }
      const mode = groups[i + 1]?.value;
      if (value === 38 && (mode === 2 || mode === 5)) change = opaque;
      if (mode === 2) i += 4;
      else if (mode === 5) i += 2;
      continue;
    }
    if (value === 0 || value === 39 || (value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
      change = opaque;
    }
  }
  return change;
}

/**
 * Let xterm's extended attributes carry a foreground alpha. Cloning copies it, and an
 * attribute set with only an alpha still counts as non-empty, so cells keep it.
 */
function patchExtendedAttrs(proto: any): void {
  if (proto[PATCHED_KEY]) return;
  const clone = proto.clone;
  const isEmpty = proto.isEmpty;
  proto.clone = function (this: any) {
    const copy = clone.call(this);
    if (this[ALPHA_KEY] !== undefined) copy[ALPHA_KEY] = this[ALPHA_KEY];
    return copy;
  };
  proto.isEmpty = function (this: any) {
    return isEmpty.call(this) && (this[ALPHA_KEY] ?? OPAQUE) === OPAQUE;
  };
  proto[PATCHED_KEY] = true;
}

/** Apply a foreground change to xterm's current attributes. */
function applyChange(attr: any, change: ForegroundChange): void {
  if (change.rgb !== null) attr.fg = (attr.fg & ~FG_COLOR_BITS) | FG_MODE_RGB | change.rgb;
  if ((attr.extended[ALPHA_KEY] ?? OPAQUE) === change.alpha) return;
  attr.extended = attr.extended.clone();
  attr.extended[ALPHA_KEY] = change.alpha;
  attr.updateExtended();
}

/**
 * Teach an xterm.js terminal the RGBA foreground extension. Returns false, leaving the
 * terminal untouched, when its internals don't have the expected shape.
 */
export function installForegroundAlpha(xterm: unknown): boolean {
  const inputHandler = (xterm as any)?._core?._inputHandler;
  const attr = inputHandler?._curAttrData;
  const proto = attr?.extended ? Object.getPrototypeOf(attr.extended) : null;
  if (
    typeof inputHandler?.charAttributes !== "function" ||
    typeof attr?.updateExtended !== "function" ||
    typeof proto?.clone !== "function" ||
    typeof proto?.isEmpty !== "function"
  ) {
    return false;
  }
  patchExtendedAttrs(proto);
  const charAttributes = inputHandler.charAttributes;
  inputHandler.charAttributes = function (this: any, params: any) {
    const handled = charAttributes.call(this, params);
    const change = foregroundChangeFromSgr(params.toArray());
    if (change) applyChange(this._curAttrData, change);
    return handled;
  };
  return true;
}

/**
 * The foreground alpha of a cell loaded from an xterm buffer line. A reused cell keeps
 * the extended attributes of an earlier cell unless the flag says this one has its own.
 */
export function cellForegroundAlpha(cell: any): number {
  if (!(cell?.bg & BG_HAS_EXTENDED)) return OPAQUE;
  return cell.extended?.[ALPHA_KEY] ?? OPAQUE;
}
