import { describe, expect, it } from "vitest";
import { intensitySgr } from "../src/utils/intensity-sgr.js";

/** Apply SGR parameters to a bold and faint state, as a terminal would. */
function apply(state: { bold: boolean; dim: boolean }, params: string[]): { bold: boolean; dim: boolean } {
  const next = { ...state };
  for (const param of params) {
    if (param === "1") next.bold = true;
    else if (param === "2") next.dim = true;
    else if (param === "22") next.bold = next.dim = false;
  }
  return next;
}

describe("intensitySgr", () => {
  it("reaches the next state from every previous state", () => {
    const states = [false, true].flatMap((bold) => [false, true].map((dim) => ({ bold, dim })));
    for (const previous of states) {
      for (const next of states) {
        expect(apply(previous, intensitySgr(previous, next)), JSON.stringify({ next, previous })).toEqual(next);
      }
    }
  });

  it("emits nothing when the state doesn't change", () => {
    expect(intensitySgr({ bold: true, dim: true }, { bold: true, dim: true })).toEqual([]);
    expect(intensitySgr({ bold: false, dim: false }, { bold: false, dim: false })).toEqual([]);
  });

  it("keeps faint text faint when bold turns off", () => {
    expect(intensitySgr({ bold: true, dim: true }, { bold: false, dim: true })).toEqual(["22", "2"]);
  });
});
