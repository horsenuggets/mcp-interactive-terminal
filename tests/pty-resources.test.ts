import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createTerminal } from "../src/terminal.js";

function countPtyDescriptors(): number {
  const output = execFileSync("lsof", [
    "-nP", "-a", "-p", String(process.pid), "-F", "n",
  ], { encoding: "utf8" });
  return output.split("\n").filter((line) => /^n\/dev\/(ptmx|ttys\w+)$/.test(line)).length;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe.skipIf(process.platform !== "darwin")("macOS PTY resources", () => {
  for (const command of ["/bin/sh", "/bin/zsh"]) {
    for (const action of ["exit", "dispose"] as const) {
      it(`releases every PTY descriptor after repeated ${command} ${action}`, async () => {
        const baseline = countPtyDescriptors();
        for (let index = 0; index < 4; index++) {
          const terminal = await createTerminal({ command, args: ["-f"] });
          try {
            expect(terminal.mode).toBe("pty");
            if (action === "exit") terminal.write("exit\n");
            else {
              terminal.kill("SIGTERM");
              terminal.dispose();
            }
            await expect.poll(() => processExists(terminal.pid), { timeout: 5000 }).toBe(false);
          } finally {
            terminal.dispose();
            if (processExists(terminal.pid)) process.kill(terminal.pid, "SIGKILL");
          }
        }
        await expect.poll(countPtyDescriptors, { timeout: 5000 }).toBe(baseline);
      }, 30000);
    }
  }

  it("terminates a process that ignores shutdown signals and tolerates repeated disposal", async () => {
    const baseline = countPtyDescriptors();
    const terminal = await createTerminal({
      command: process.execPath,
      args: ["-e", [
        'process.on("SIGTERM", () => {});',
        'process.on("SIGHUP", () => {});',
        'setInterval(() => {}, 1000);',
        'console.log("READY");',
      ].join("\n")],
    });
    try {
      expect(terminal.mode).toBe("pty");
      await expect.poll(() => terminal.readScreen().text).toContain("READY");
      terminal.kill("SIGTERM");
      terminal.dispose();
      terminal.dispose();
      await expect.poll(() => processExists(terminal.pid), { timeout: 5000 }).toBe(false);
      await expect.poll(countPtyDescriptors, { timeout: 5000 }).toBe(baseline);
    } finally {
      terminal.dispose();
      if (processExists(terminal.pid)) process.kill(terminal.pid, "SIGKILL");
    }
  }, 10000);

  it("releases every PTY descriptor when native spawning fails", () => {
    // A missing executable normally fails inside spawn-helper, after native spawning.
    // Call the pinned native adapter with a missing helper to exercise its error path.
    const require = createRequire(import.meta.url);
    const { loadNativeModule } = require("node-pty/lib/utils.js");
    const native = loadNativeModule("pty").module;
    const baseline = countPtyDescriptors();
    for (let index = 0; index < 4; index++) {
      expect(() => native.fork(
        "/bin/sh", [], [], process.cwd(), 80, 24, -1, -1, true,
        "/dev/null/missing-spawn-helper", () => {},
      )).toThrow(/spawn/i);
    }
    expect(countPtyDescriptors()).toBe(baseline);
  });
});
