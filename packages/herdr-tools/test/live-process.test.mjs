import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { liveProcessParentPid } from "../live-process.mjs";

function fakeChild(output, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  queueMicrotask(() => {
    child.stdout.emit("data", output);
    child.emit("close", code);
  });
  return child;
}

test("Windows parent lookup uses PowerShell WMI without a shell wrapper", async () => {
  let invocation;
  const parentPid = await liveProcessParentPid(4440, {
    platform: "win32",
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      return fakeChild("90888\r\n");
    },
  });

  assert.equal(parentPid, 90888);
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.options.shell, false);
  assert.match(invocation.args.at(-1), /Get-CimInstance/);
  assert.match(invocation.args.at(-1), /ProcessId = 4440/);
});

test("POSIX parent lookup parses ps output", async () => {
  let invocation;
  const parentPid = await liveProcessParentPid(4440, {
    platform: "darwin",
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      return fakeChild("  1234\n");
    },
  });

  assert.equal(parentPid, 1234);
  assert.equal(invocation.command, "ps");
  assert.deepEqual(invocation.args, ["-o", "ppid=", "-p", "4440"]);
  assert.equal(invocation.options.shell, false);
});
