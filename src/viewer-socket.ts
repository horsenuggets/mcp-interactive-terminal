/**
 * Unix socket server that streams rendered PNG frames to viewer clients.
 *
 * Each terminal session can optionally create a socket at
 * /tmp/mcp-terminal-<session-id>.sock. The MCP renders the emulator grid to a
 * PNG with skia-canvas (the same `renderScreenToPng` the screenshot tool uses)
 * and pushes each frame here, so the live viewer displays pixel-identical output
 * to `screenshot_session` — no second, divergent xterm.js render.
 *
 * Wire format: each frame is a 4-byte big-endian length header followed by that
 * many PNG bytes. On connect, the viewer immediately receives the latest frame
 * (if any) so it catches up to the current screen without waiting for the next
 * PTY update.
 */

import { createServer, type Server } from "node:net";
import type { Socket } from "node:net";
import { unlinkSync } from "node:fs";

export interface ViewerSocket {
  /** Path to the Unix socket file */
  socketPath: string;
  /** Send a rendered PNG frame to all connected viewers */
  writeFrame(png: Buffer): void;
  /** Close the socket server and clean up */
  close(): void;
}

/**
 * Prefix a PNG buffer with its 4-byte big-endian length header. Returned as a
 * Uint8Array because net.Socket.write's types want a Uint8Array<ArrayBuffer>,
 * which `Buffer` no longer satisfies under recent @types/node generics.
 */
function frameWithHeader(png: Buffer): Uint8Array {
  const framed = new Uint8Array(4 + png.length);
  new DataView(framed.buffer).setUint32(0, png.length, false); // big-endian
  framed.set(png, 4);
  return framed;
}

export function createViewerSocket(sessionId: string): ViewerSocket {
  const socketPath = `/tmp/mcp-terminal-${sessionId}.sock`;

  // Clean up any stale socket file
  try { unlinkSync(socketPath); } catch {}

  const clients = new Set<Socket>();
  let latestFrame: Buffer | null = null;

  // Per-client backpressure state. While a socket's write buffer is full we hold
  // back new frames and stash only the newest one, then flush it on 'drain'.
  // This keeps a slow/backgrounded viewer from accumulating one large encoded
  // frame per render in the writable queue (unbounded memory + latency); it just
  // skips ahead to the current screen once it drains.
  const backpressured = new WeakSet<Socket>();
  const pending = new WeakMap<Socket, Buffer>();

  // Send a frame to one client, honoring backpressure. Returns false and stashes
  // the frame (superseding any earlier stash) when the socket can't keep up.
  const sendToClient = (client: Socket, png: Buffer): boolean => {
    if (backpressured.has(client)) {
      pending.set(client, png);
      return false;
    }
    try {
      const ok = client.write(frameWithHeader(png));
      if (!ok) backpressured.add(client);
      return ok;
    } catch {
      clients.delete(client);
      return false;
    }
  };

  const server: Server = createServer((socket) => {
    clients.add(socket);
    console.error(`[mcp-terminal] viewer connected to session ${sessionId}`);

    // Replay the latest rendered frame so the viewer catches up immediately.
    if (latestFrame) sendToClient(socket, latestFrame);

    socket.on("drain", () => {
      backpressured.delete(socket);
      const stashed = pending.get(socket);
      if (stashed) {
        pending.delete(socket);
        sendToClient(socket, stashed);
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      pending.delete(socket);
      console.error(`[mcp-terminal] viewer disconnected from session ${sessionId}`);
    });

    socket.on("error", () => {
      clients.delete(socket);
      pending.delete(socket);
    });
  });

  server.listen(socketPath, () => {
    console.error(`[mcp-terminal] viewer socket listening: ${socketPath}`);
  });

  server.on("error", (err) => {
    console.error(`[mcp-terminal] viewer socket error: ${err.message}`);
  });

  return {
    socketPath,

    writeFrame(png: Buffer) {
      latestFrame = png;
      for (const client of clients) {
        sendToClient(client, png);
      }
    },

    close() {
      for (const client of clients) {
        try { client.destroy(); } catch {}
      }
      clients.clear();
      server.close();
      try { unlinkSync(socketPath); } catch {}
    },
  };
}
