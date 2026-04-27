/**
 * Unix socket server that streams raw PTY data to viewer clients.
 *
 * Each terminal session can optionally create a socket at
 * /tmp/mcp-terminal-<session-id>.sock. Viewer apps connect to
 * receive the same raw bytes that the xterm-headless instance
 * processes, giving them pixel-perfect terminal rendering.
 *
 * On initial connect, the viewer receives the full raw PTY buffer
 * (everything since session start) so it replays to the current state.
 * After that, new PTY bytes stream in real-time.
 */

import { createServer, type Server } from "node:net";
import type { Socket } from "node:net";
import { unlinkSync } from "node:fs";

export interface ViewerSocket {
  /** Path to the Unix socket file */
  socketPath: string;
  /** Send raw PTY data to all connected viewers */
  write(data: string): void;
  /** Set the function that returns the raw PTY data buffer for replay */
  setReplayBuffer(fn: () => string): void;
  /** Close the socket server and clean up */
  close(): void;
}

export function createViewerSocket(sessionId: string): ViewerSocket {
  const socketPath = `/tmp/mcp-terminal-${sessionId}.sock`;

  // Clean up any stale socket file
  try { unlinkSync(socketPath); } catch {}

  const clients = new Set<Socket>();
  let getReplayBuffer: (() => string) | null = null;

  const server: Server = createServer((socket) => {
    clients.add(socket);
    console.error(`[mcp-terminal] viewer connected to session ${sessionId}`);

    // Replay the full raw PTY buffer so the viewer catches up
    if (getReplayBuffer) {
      const buffer = getReplayBuffer();
      if (buffer) {
        socket.write(buffer);
      }
    }

    socket.on("close", () => {
      clients.delete(socket);
      console.error(`[mcp-terminal] viewer disconnected from session ${sessionId}`);
    });

    socket.on("error", () => {
      clients.delete(socket);
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

    write(data: string) {
      for (const client of clients) {
        try {
          client.write(data);
        } catch {
          clients.delete(client);
        }
      }
    },

    setReplayBuffer(fn: () => string) {
      getReplayBuffer = fn;
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
