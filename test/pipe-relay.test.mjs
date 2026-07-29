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

  writeFrame(fromSv, { type: "result", id: secondCommand.id, ok: true, result: 705600000 });
  assert.deepEqual(JSON.parse(await nextReply()), { type: "noop" });
  assert.equal(await second, 705600000);
});

test("sequential awaited calls chain through the result reply without a poll wait", async (t) => {
  const session = `relay-chain-${process.pid}-${Date.now()}`;
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
  JSON.parse(await nextReply());

  // 顺序 await：第二条命令只有在第一条 resolve 之后才会入队。
  const sequence = (async () => {
    const first = await relay.call({ op: "ping" });
    const second = await relay.call({ op: "index", field: "QUARTER" });
    return [first, second];
  })();

  writeFrame(fromSv, { type: "poll" });
  const firstCommand = JSON.parse(await nextReply());
  assert.equal(firstCommand.type, "command");
  assert.equal(firstCommand.op, "ping");

  writeFrame(fromSv, { type: "result", id: firstCommand.id, ok: true, result: "pong" });
  // 关键断言：result 帧的回包直接携带下一条 command，而不是 noop 后再等一个 IDLE 轮询。
  const chained = JSON.parse(await nextReply());
  assert.equal(chained.type, "command");
  assert.equal(chained.op, "index");

  writeFrame(fromSv, { type: "result", id: chained.id, ok: true, result: 705600000 });
  assert.equal(JSON.parse(await nextReply()).type, "noop");
  assert.deepEqual(await sequence, ["pong", 705600000]);
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

test("oversized result frames fail the command without detaching the bridge", async (t) => {
  const session = `relay-oversize-${process.pid}-${Date.now()}`;
  const relay = new PipeRelay({ session, timeoutMs: 2000 });
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
  JSON.parse(await nextReply());
  let detached = false;
  relay.on("detach", () => {
    detached = true;
  });

  const first = relay.call({ op: "call", method: "getPoints" });
  writeFrame(fromSv, { type: "poll" });
  const command = JSON.parse(await nextReply());
  assert.equal(command.type, "command");

  // 超过 64 KiB 的 result 行：命令以 FRAME_TOO_LARGE 失败，但连接保持锁步存活。
  writeFrame(fromSv, {
    type: "result",
    id: command.id,
    ok: true,
    result: "x".repeat(70 * 1024),
  });
  await assert.rejects(first, (error) => error.code === "FRAME_TOO_LARGE");
  const afterOversize = JSON.parse(await nextReply());
  assert.equal(afterOversize.type, "noop");
  assert.equal(detached, false);

  const second = relay.call({ op: "call", method: "ping" });
  writeFrame(fromSv, { type: "poll" });
  const command2 = JSON.parse(await nextReply());
  assert.equal(command2.type, "command");
  writeFrame(fromSv, { type: "result", id: command2.id, ok: true, result: "pong" });
  assert.equal(await second, "pong");
  assert.equal(JSON.parse(await nextReply()).type, "noop");
  assert.equal(relay.getStatus().state, "attached");
});

test("PipeRelay negotiates bridge opcodes per connection and forgets them on detach", async (t) => {
  const session = `relay-caps-${process.pid}-${Date.now()}`;
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

  const attaches = [];
  relay.on("attach", (event) => attaches.push(event));

  assert.equal(relay.supportsOp("read_note_fingerprints_v1"), false);

  writeFrame(fromSv, {
    type: "hello",
    role: "sv",
    proto: 1,
    ops: ["read_note_fingerprints_v1", 42, "another_op"],
  });
  // 握手回复不携带 ops：能力是桥 -> Relay 的单向声明，回复保持逐字节兼容旧桥。
  assert.deepEqual(JSON.parse(await nextReply()), { type: "hello", proto: 1, session });

  assert.equal(relay.supportsOp("read_note_fingerprints_v1"), true);
  assert.equal(relay.supportsOp("another_op"), true);
  assert.equal(relay.supportsOp("not_advertised"), false);
  // 非字符串项被丢弃，不会变成可调用的 opcode。
  assert.deepEqual(relay.getStatus().hostOps, ["read_note_fingerprints_v1", "another_op"]);
  assert.deepEqual(attaches.at(-1).ops, ["read_note_fingerprints_v1", "another_op"]);

  const detached = once(relay, "detach");
  fromSv.destroy();
  await detached;
  // 能力属于单次连接：断开后必须清空，否则重连前的调用会以为旧 opcode 仍可用。
  assert.equal(relay.supportsOp("read_note_fingerprints_v1"), false);
  assert.deepEqual(relay.getStatus().hostOps, []);
});

test("PipeRelay treats a bridge without an ops field as capability-free", async (t) => {
  const session = `relay-nocaps-${process.pid}-${Date.now()}`;
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

  // 旧桥的 hello 没有 ops 字段；握手必须照常成功，只是不具备任何 internal op。
  writeFrame(fromSv, { type: "hello", role: "sv", proto: 1 });
  assert.deepEqual(JSON.parse(await nextReply()), { type: "hello", proto: 1, session });
  assert.equal(relay.getStatus().state, "attached");
  assert.equal(relay.supportsOp("read_note_fingerprints_v1"), false);
  assert.deepEqual(relay.getStatus().hostOps, []);
});

test("_closeServers tears down servers unconditionally, including ones still binding", async () => {
  const { EventEmitter } = await import("node:events");
  const relay = new PipeRelay({ session: "close-race-test" });
  const events = [];
  // 模拟 net.Server：close() 在未 listening 时以 ERR_SERVER_NOT_RUNNING 回调，
  // 但异步绑定仍可能随后完成——旧实现按 listening 短路会把它泄漏成无引用 server。
  const makeStub = (listeningNow) => {
    const stub = new EventEmitter();
    stub.listening = listeningNow;
    stub.close = (callback) => {
      if (stub.listening) {
        stub.listening = false;
        events.push("closed");
        callback?.();
        stub.emit("close");
      } else {
        const error = new Error("Server is not running.");
        error.code = "ERR_SERVER_NOT_RUNNING";
        callback?.(error);
      }
      return stub;
    };
    return stub;
  };
  const bound = makeStub(true);
  const stillBinding = makeStub(false);
  relay.servers = [bound, stillBinding];

  await relay._closeServers();
  // 已绑定的立即关闭；仍在绑定的那个此刻无 handle 可关。
  assert.equal(events.length, 1);
  assert.deepEqual(relay.servers, []);

  // 拆除请求之后绑定才完成：一次性 listening 兜底必须立即补一次 close，
  // 否则它会长期占用命名管道并让重试 init 永久 EADDRINUSE。
  stillBinding.listening = true;
  stillBinding.emit("listening");
  assert.equal(events.length, 2);
  assert.equal(stillBinding.listening, false);
  await relay.close();
});
