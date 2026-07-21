import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";

import { PipeRelay } from "../server/src/transport-pipe.js";

function connect(pipePath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function createLineReader(socket) {
  let buffer = "";
  const lines = [];
  const waiters = [];

  const deliver = (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else lines.push(line);
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      deliver(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  socket.on("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("pipe closed"));
  });

  return function nextLine(timeoutMs = 1000) {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for pipe frame"));
      }, timeoutMs);
      waiter.resolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  };
}

function writeFrame(socket, frame) {
  const line = typeof frame === "string" ? frame : JSON.stringify(frame);
  socket.write(`${line}\n`);
}

test("PipeRelay validates handshake and preserves lockstep serialization", async (t) => {
  const session = `relay-test-${process.pid}-${Date.now()}`;
  const relay = new PipeRelay({ session, timeoutMs: 1000 });
  await relay.init();

  const toSv = await connect(relay.paths.toSv);
  const fromSv = await connect(relay.paths.fromSv);
  const nextReply = createLineReader(toSv);
  t.after(async () => {
    toSv.destroy();
    fromSv.destroy();
    await relay.close();
  });

  writeFrame(fromSv, { type: "hello", role: "sv", proto: 999 });
  assert.deepEqual(JSON.parse(await nextReply()), {
    type: "error",
    code: "PROTO_MISMATCH",
    expected: 1,
  });

  writeFrame(fromSv, { type: "hello", role: "sv", proto: 1 });
  assert.deepEqual(JSON.parse(await nextReply()), { type: "hello", proto: 1, session });

  writeFrame(fromSv, "{invalid-json");
  assert.deepEqual(JSON.parse(await nextReply()), { type: "error", code: "INVALID_JSON" });

  const first = relay.call({ op: "ping" });
  const second = relay.call({ op: "index", field: "QUARTER" });

  writeFrame(fromSv, { type: "poll" });
  const firstCommand = JSON.parse(await nextReply());
  assert.equal(firstCommand.type, "command");
  assert.equal(firstCommand.op, "ping");

  writeFrame(fromSv, { type: "poll" });
  assert.deepEqual(JSON.parse(await nextReply()), { type: "noop" });

  writeFrame(fromSv, { type: "result", id: firstCommand.id, ok: true, result: "pong" });
  const secondCommand = JSON.parse(await nextReply());
  assert.equal(secondCommand.type, "command");
  assert.equal(secondCommand.op, "index");
  assert.equal(await first, "pong");

  writeFrame(fromSv, { type: "result", id: secondCommand.id, ok: true, result: 705600 });
  assert.deepEqual(JSON.parse(await nextReply()), { type: "noop" });
  assert.equal(await second, 705600);
});

test("control pipe requests bridge shutdown", async (t) => {
  const session = `control-test-${process.pid}-${Date.now()}`;
  const relay = new PipeRelay({ session, timeoutMs: 1000 });
  await relay.init();

  const toSv = await connect(relay.paths.toSv);
  const fromSv = await connect(relay.paths.fromSv);
  const nextReply = createLineReader(toSv);
  t.after(async () => {
    toSv.destroy();
    fromSv.destroy();
    await relay.close();
  });

  writeFrame(fromSv, { type: "hello", role: "sv", proto: 1 });
  await nextReply();

  const control = await connect(relay.paths.control);
  control.end('{"type":"shutdown"}\n');
  await once(control, "close");

  writeFrame(fromSv, { type: "poll" });
  assert.deepEqual(JSON.parse(await nextReply()), { type: "shutdown" });
});
