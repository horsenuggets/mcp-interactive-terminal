import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import type { ServerConfig } from "../types.js";
import { sanitize } from "../utils/sanitizer.js";
import { redactSecrets } from "../utils/secret-redactor.js";
import { audit } from "../utils/audit-logger.js";

/**
 * Send mouse events (click, drag, release) to an interactive session
 * using the SGR mouse protocol (DEC 1006).
 *
 * This is the same protocol real terminals use when the app has enabled
 * SGR mouse tracking — so apps that react to clicks (TUI editors, file
 * managers, etc.) will respond identically to a user clicking.
 *
 * SGR mouse sequence format: CSI < button ; col ; row M  (press / drag)
 *                            CSI < button ; col ; row m  (release)
 *
 * Button codes used here:
 *   0  = left button, plain press
 *   32 = motion-while-button-held (add to base button for drag events,
 *        so left-drag is button code 0 + 32 = 32)
 *
 * Row/col are 1-indexed. (1, 1) is the top-left cell of the terminal.
 *
 * Sequences emitted:
 *   - "click":  press at (col, row), release at (col, row)
 *   - "press":  just the press (use with a later "release")
 *   - "release": just the release
 *   - "drag":   press at (fromCol, fromRow), drag through
 *               (toCol, toRow), release at (toCol, toRow).
 *               Emits motion events in a straight line between the
 *               two points so apps that track drag selection see
 *               continuous movement, not just the endpoints.
 */

const MOUSE_WAIT_MS = 200;
const DRAG_STEP_WAIT_MS = 15;

function sgrPress(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col};${row}M`;
}

function sgrRelease(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col};${row}m`;
}

function sgrDrag(col: number, row: number): string {
  // Left-button drag is button code 0 + motion bit 32 = 32.
  return `\x1b[<32;${col};${row}M`;
}

export const sendMouseSchema = z.object({
  session_id: z.string().describe("The session ID"),
  action: z
    .enum(["click", "press", "release", "drag"])
    .describe(
      "The mouse action to perform. 'click' is press+release at one point. " +
        "'drag' is press at (col,row), motion through (to_col,to_row), release at the end. " +
        "'press' and 'release' let you build more complex sequences manually.",
    ),
  col: z
    .number()
    .int()
    .min(1)
    .describe("1-indexed column (x coordinate) of the click or drag start."),
  row: z
    .number()
    .int()
    .min(1)
    .describe("1-indexed row (y coordinate) of the click or drag start."),
  to_col: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Drag end column (required for 'drag' action)."),
  to_row: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Drag end row (required for 'drag' action)."),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      "How long to wait for output after the sequence (default 200ms for click/release, longer for drag).",
    ),
});

export type SendMouseArgs = z.infer<typeof sendMouseSchema>;

export async function handleSendMouse(
  args: SendMouseArgs,
  sessionManager: SessionManager,
  config: ServerConfig,
): Promise<{ output: string }> {
  if (config.logInputs) {
    console.error(
      `[mcp-terminal] send_mouse [${args.session_id}]: ${args.action} at (${args.col},${args.row})` +
        (args.action === "drag" ? ` → (${args.to_col},${args.to_row})` : ""),
    );
  }

  const session = sessionManager.getSession(args.session_id);

  if (!session.isAlive) {
    throw new Error(`Session "${args.session_id}" is not alive`);
  }

  audit("mouse", args.session_id, {
    action: args.action,
    col: args.col,
    row: args.row,
    to_col: args.to_col,
    to_row: args.to_row,
  });
  sessionManager.touchSession(args.session_id);

  // Build the byte sequence
  let sequence = "";
  switch (args.action) {
    case "click": {
      sequence = sgrPress(0, args.col, args.row) + sgrRelease(0, args.col, args.row);
      break;
    }
    case "press": {
      sequence = sgrPress(0, args.col, args.row);
      break;
    }
    case "release": {
      sequence = sgrRelease(0, args.col, args.row);
      break;
    }
    case "drag": {
      if (args.to_col === undefined || args.to_row === undefined) {
        throw new Error(
          "'drag' action requires both to_col and to_row parameters",
        );
      }
      // Emit a press, then a series of motion events along a Bresenham
      // line from (col,row) to (to_col,to_row), then a release at the
      // endpoint. Apps typically only care about the first motion event
      // after press, but stepping through intermediate cells matches
      // real mouse behavior more closely.
      const points = bresenhamLine(args.col, args.row, args.to_col, args.to_row);
      sequence = sgrPress(0, args.col, args.row);
      // Drop the first point because the press already happened there.
      for (let i = 1; i < points.length; i++) {
        const [c, r] = points[i]!;
        sequence += sgrDrag(c, r);
      }
      sequence += sgrRelease(0, args.to_col, args.to_row);
      break;
    }
  }

  if (args.action === "drag") {
    // For drags, write the press first, wait a moment so the app sees
    // it as a real press, then dribble out the motion events with a
    // small delay between them. This gives the app time to start a
    // selection and extend it naturally.
    const points = bresenhamLine(args.col, args.row, args.to_col!, args.to_row!);
    session.terminal.write(sgrPress(0, args.col, args.row));
    await new Promise((resolve) => setTimeout(resolve, DRAG_STEP_WAIT_MS));
    for (let i = 1; i < points.length; i++) {
      const [c, r] = points[i]!;
      session.terminal.write(sgrDrag(c, r));
      await new Promise((resolve) => setTimeout(resolve, DRAG_STEP_WAIT_MS));
    }
    session.terminal.write(sgrRelease(0, args.to_col!, args.to_row!));
  } else {
    session.terminal.write(sequence);
  }

  // Wait for the app to render any UI response
  await new Promise((resolve) =>
    setTimeout(resolve, args.wait_ms ?? MOUSE_WAIT_MS),
  );

  let output = session.terminal.readScreen();
  output = sanitize(output, { maxChars: config.maxOutput });

  if (config.redactSecrets) {
    output = redactSecrets(output);
  }

  return { output };
}

/**
 * Compute a list of integer grid points along the line from (x0,y0)
 * to (x1,y1) using Bresenham's algorithm. Used to generate motion
 * events during a drag so apps see a continuous sweep across cells
 * rather than a teleport from start to end.
 */
function bresenhamLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    points.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}
