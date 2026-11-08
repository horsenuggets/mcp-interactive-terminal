import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createSessionSchema } from "../src/tools/create-session.js";
import { readOutputSchema } from "../src/tools/read-output.js";
import { resizeSessionSchema } from "../src/tools/resize-session.js";
import { sendCommandSchema } from "../src/tools/send-command.js";
import { sendControlSchema } from "../src/tools/send-control.js";
import { sendMouseSchema } from "../src/tools/send-mouse.js";
import { viewSessionSchema } from "../src/tools/view-session.js";
import { booleanParam } from "../src/utils/params.js";

// Some MCP clients send every argument as a string. The server validates against the
// tool's shape, the same way these tests parse it.
const parse = <T extends z.ZodRawShape>(shape: T, args: Record<string, unknown>) =>
  z.object(shape).parse(args);

describe("booleanParam", () => {
  it("accepts booleans and their string forms", () => {
    const schema = booleanParam();
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
    expect(schema.parse("true")).toBe(true);
    // z.coerce.boolean() would turn this into true.
    expect(schema.parse("false")).toBe(false);
  });

  it("still rejects anything else", () => {
    const schema = booleanParam();
    for (const value of ["yes", "1", "", 1, null]) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("tool parameters sent as strings", () => {
  it("coerce numbers for create_session and keep the defaults", () => {
    const args = parse(createSessionSchema.shape, { command: "bash", cols: "160", rows: "40", timeout_seconds: "1800", viewer: "false" });
    expect(args).toMatchObject({ cols: 160, rows: 40, timeout_seconds: 1800, viewer: false });
    expect(parse(createSessionSchema.shape, { command: "bash" })).toMatchObject({ timeout_seconds: 300, viewer: false });
  });

  it("coerce send_control, send_command, read_output, and view_session parameters", () => {
    expect(parse(sendControlSchema.shape, { session_id: "s", control: "ctrl+c", count: "2", interval_ms: "150" })).toMatchObject({ count: 2, interval_ms: 150 });
    expect(parse(sendCommandSchema.shape, { session_id: "s", input: "x", timeout_ms: "15000", newline: "false" })).toMatchObject({ timeout_ms: 15000, newline: false });
    expect(parse(readOutputSchema.shape, { session_id: "s", full_screen: "true" })).toMatchObject({ full_screen: true });
    expect(parse(viewSessionSchema.shape, { session_id: "s", foreground: "true" })).toMatchObject({ foreground: true });
  });

  it("coerce resize_session and send_mouse parameters", () => {
    expect(parse(resizeSessionSchema.shape, { session_id: "s", cols: "100", rows: "30" })).toMatchObject({ cols: 100, rows: 30 });
    expect(parse(sendMouseSchema.shape, { session_id: "s", action: "click", col: "3", row: "4" })).toMatchObject({ col: 3, row: 4 });
  });

  it("still enforce the bounds after coercing", () => {
    expect(z.object(sendControlSchema.shape).safeParse({ session_id: "s", control: "c", count: "0" }).success).toBe(false);
    expect(z.object(sendControlSchema.shape).safeParse({ session_id: "s", control: "c", count: "1.5" }).success).toBe(false);
    expect(z.object(createSessionSchema.shape).safeParse({ command: "bash", cols: "lots" }).success).toBe(false);
  });
});
