import net from "node:net";
import { EventEmitter } from "node:events";

const PIPE_PREFIX = "\\\\.\\pipe\\";
const DEFAULT_SESSION = "default";

export function resolveSession() {
  return process.env.SV_COPILOT_SESSION || DEFAULT_SESSION;
}

export function resolvePipePaths(session = resolveSession()) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(session)) {
    throw new Error(
      "SV_COPILOT_SESSION must contain 1-64 ASCII letters, digits, dots, underscores, or hyphens"
    );
  }
  return {
    toSv: `${PIPE_PREFIX}SVCopilot-${session}-to-sv`,
    fromSv: `${PIPE_PREFIX}SVCopilot-${session}-from-sv`,
    control: `${PIPE_PREFIX}SVCopilot-${session}-control`,
  };
}

export class PipeRelay extends EventEmitter {
  constructor({
    session = resolveSession(),
    proto = 1,
    timeoutMs = 10000,
    maxQueue = 64,
    maxFrameBytes = 64 * 1024,
  } = {}) {
    super();
    this.session = session;
    this.proto = proto;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.maxFrameBytes = maxFrameBytes;
    this.paths = resolvePipePaths(session);

    this.counter = 0;
    this.queue = [];
    this.inflight = new Map();
    this.servers = [];
    this.toSvSocket = null;
    this.fromSvSocket = null;
    this.fromSvBuffer = "";
    this.discardingOversized = false;
    this.pendingReply = null;
    this.handshakeComplete = false;
    this.shutdownRequested = false;
    this.initialized = false;
    this.closed = false;
    this.detaching = false;
    this.connectionEpoch = 0;
  }

  async init() {
    if (this.initialized) return;
    if (this.closed) throw new Error("PipeRelay is closed");

    const toSvServer = net.createServer((socket) => this._acceptToSv(socket));
    const fromSvServer = net.createServer((socket) => this._acceptFromSv(socket));
    const controlServer = net.createServer((socket) => this._acceptControl(socket));
    this.servers = [toSvServer, fromSvServer, controlServer];

    try {
      await Promise.all([
        this._listen(toSvServer, this.paths.toSv),
        this._listen(fromSvServer, this.paths.fromSv),
        this._listen(controlServer, this.paths.control),
      ]);
      this.initialized = true;
    } catch (error) {
      await this._closeServers();
      throw error;
    }
  }

  call(cmd) {
    if (!this.initialized || this.closed) {
      return Promise.reject(new Error("PipeRelay is not running"));
    }
    if (this.queue.length + this.inflight.size >= this.maxQueue) {
      return Promise.reject(new Error(`SynthV bridge queue is full (${this.maxQueue})`));
    }

    let encoded;
    try {
      encoded = JSON.stringify({ type: "command", id: this.counter + 1, ...cmd });
    } catch (error) {
      return Promise.reject(error);
    }
    if (Buffer.byteLength(encoded, "utf8") > this.maxFrameBytes) {
      return Promise.reject(new Error(`SynthV bridge command exceeds ${this.maxFrameBytes} bytes`));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        this.queue = this.queue.filter((entry) => entry.id !== id);
        reject(
          new Error(
            `Timeout waiting for SynthV bridge (id=${id}). Is "Start SV Copilot" running? session=${this.session}`
          )
        );
      }, this.timeoutMs);
      this.queue.push({ id, cmd, resolve, reject, timer });
    });
  }

  _listen(server, pipePath) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", (error) => this._detach(`pipe server error: ${error.message}`));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(pipePath);
    });
  }

  _acceptToSv(socket) {
    if (this.toSvSocket) this._detach("to-sv pipe replaced");
    this.toSvSocket = socket;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.toSvSocket === socket) this._detach("to-sv pipe closed");
    });

    // 两根数据管道的连接回调顺序不受保证；先缓存的一帧必须在写端就绪后立即发出。
    if (this.pendingReply !== null) {
      const reply = this.pendingReply;
      this.pendingReply = null;
      this._writeRaw(reply);
    }
  }

  _acceptFromSv(socket) {
    if (this.fromSvSocket) this._detach("from-sv pipe replaced");
    this.fromSvSocket = socket;
    this.fromSvBuffer = "";
    this.discardingOversized = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this._onFromSvData(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.fromSvSocket === socket) this._detach("from-sv pipe closed");
    });
  }

  _acceptControl(socket) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > this.maxFrameBytes) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.type === "shutdown") this._requestShutdown();
        } catch {
          // 控制管道是单向的；无效帧只能丢弃，不能在同一连接上回包。
        }
      }
    });
    socket.on("error", () => {});
  }

  _onFromSvData(chunk) {
    this.fromSvBuffer += chunk;
    while (true) {
      const newline = this.fromSvBuffer.indexOf("\n");
      // 超限行进入丢弃模式：只找行尾，不再缓冲内容，内存有界。
      if (this.discardingOversized) {
        if (newline < 0) {
          this.fromSvBuffer = "";
          return;
        }
        this.fromSvBuffer = this.fromSvBuffer.slice(newline + 1);
        this.discardingOversized = false;
        // 被丢弃的行是桥在本轮写出的帧（锁步下只能是 in-flight 的 result）；
        // 命令已被拒绝，这里必须回包让 Lua 的阻塞读取继续，连接保持存活。
        if (this.handshakeComplete) this._reply();
        else this._sendReply({ type: "error", code: "FRAME_TOO_LARGE" });
        continue;
      }
      if (newline < 0) {
        if (Buffer.byteLength(this.fromSvBuffer, "utf8") > this.maxFrameBytes) {
          this.discardingOversized = true;
          this.fromSvBuffer = "";
          this._rejectInflightOversized();
        }
        return;
      }
      const line = this.fromSvBuffer.slice(0, newline);
      this.fromSvBuffer = this.fromSvBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        // 行已完整但超限：拒绝命令并回包，不解析超大 JSON，也不断连。
        this._rejectInflightOversized();
        if (this.handshakeComplete) this._reply();
        else this._sendReply({ type: "error", code: "FRAME_TOO_LARGE" });
        continue;
      }
      if (line.trim()) this._onFrame(line);
    }
  }

  _rejectInflightOversized() {
    for (const [id, entry] of this.inflight) {
      clearTimeout(entry.timer);
      const error = new Error(
        `SynthV bridge result exceeds ${this.maxFrameBytes} bytes; narrow the request window`
      );
      error.code = "FRAME_TOO_LARGE";
      entry.reject(error);
      this.inflight.delete(id);
    }
  }

  _onFrame(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // Lua 正阻塞等待本帧的对应回复，解析失败时也必须回包。
      this._sendReply({ type: "error", code: "INVALID_JSON" });
      return;
    }

    if (frame.type === "hello") {
      if (frame.role !== "sv" || frame.proto !== this.proto) {
        this._sendReply({
          type: "error",
          code: "PROTO_MISMATCH",
          expected: this.proto,
        });
        return;
      }
      if (!this.handshakeComplete) {
        this.handshakeComplete = true;
        this.connectionEpoch += 1;
        this.emit("attach", { epoch: this.connectionEpoch, session: this.session });
      }
      this._sendReply({ type: "hello", proto: this.proto, session: this.session });
      return;
    }

    if (!this.handshakeComplete) {
      this._sendReply({ type: "error", code: "HANDSHAKE_REQUIRED" });
      return;
    }

    if (frame.type === "result" && frame.id != null) {
      const entry = this.inflight.get(frame.id);
      if (entry) {
        this.inflight.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok === false) entry.reject(new Error(frame.error || "SV bridge error"));
        else entry.resolve(frame.result);
      }
      // resolve 只是调度了等待方的微任务；此刻同步回包必然是 noop，顺序调用的下一条
      // 命令就要再等桥的 IDLE_MS 轮询。推迟一个 macrotask 让微任务链先跑完：等待方
      // 若紧接着发起下一次调用，本帧的回包就直接携带该 command，桥的 nextDelay=0
      // 快速通道会连续排空整串顺序调用。锁步保证推迟期间不会有新帧到来，每帧仍恰好
      // 一个回复，不变量不变。
      const generation = this.connectionEpoch;
      setImmediate(() => {
        if (generation !== this.connectionEpoch) return;
        if (!this.handshakeComplete || !this.toSvSocket) return;
        this._reply();
      });
      return;
    }

    this._reply();
  }

  _reply() {
    if (this.shutdownRequested) {
      this.shutdownRequested = false;
      this._sendReply({ type: "shutdown" });
      return;
    }
    if (this.inflight.size === 0 && this.queue.length > 0) {
      const next = this.queue.shift();
      this.inflight.set(next.id, next);
      this._sendReply({ type: "command", id: next.id, ...next.cmd });
      return;
    }
    this._sendReply({ type: "noop" });
  }

  _sendReply(frame) {
    const encoded = `${JSON.stringify(frame)}\n`;
    if (!this.toSvSocket) {
      this.pendingReply = encoded;
      return;
    }
    this._writeRaw(encoded);
  }

  _writeRaw(encoded) {
    if (!this.toSvSocket || this.toSvSocket.destroyed) return;
    this.toSvSocket.write(encoded);
  }

  _requestShutdown() {
    const error = new Error("SynthV bridge shutdown requested");
    this._rejectCommands(error);
    this.shutdownRequested = true;
  }

  _rejectCommands(error) {
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.inflight.clear();
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.queue = [];
  }

  _detach(reason) {
    if (this.detaching) return;
    this.detaching = true;
    const wasAttached = this.handshakeComplete;
    const sockets = [this.toSvSocket, this.fromSvSocket];
    this.toSvSocket = null;
    this.fromSvSocket = null;
    this.fromSvBuffer = "";
    this.discardingOversized = false;
    this.pendingReply = null;
    this.handshakeComplete = false;
    this.shutdownRequested = false;
    this._rejectCommands(new Error(`SynthV bridge detached: ${reason}`));
    for (const socket of sockets) {
      if (socket && !socket.destroyed) socket.destroy();
    }
    if (wasAttached) this.emit("detach", { epoch: this.connectionEpoch, reason });
    this.detaching = false;
  }

  getStatus() {
    return {
      state: this.handshakeComplete ? "attached" : this.initialized ? "listening" : "stopped",
      epoch: this.connectionEpoch,
      session: this.session,
    };
  }

  async _closeServers() {
    const servers = this.servers;
    this.servers = [];
    // 关闭必须无条件执行：init 局部失败时其余 server 可能仍在异步绑定。
    // 若按 listening 跳过，它们随后完成绑定就成了无引用泄漏 server，
    // 长期占用命名管道并让重试 init 永久 EADDRINUSE。
    await Promise.all(servers.map((server) => closeServerCompletely(server)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._detach("relay closing");
    await this._closeServers();
    this.initialized = false;
  }
}

// 拆除单个 pipe server，容忍它尚未完成绑定：
// - 已 listening：正常 close 并等待完成。
// - 绑定仍在进行：close() 会以 ERR_SERVER_NOT_RUNNING 回调；注册一次性 listening
//   兜底，绑定一旦完成立即补一次 close，保证不留下无引用的已绑定 server。
//   绑定最终失败则无 handle 可泄漏，直接完成。
function closeServerCompletely(server) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    server.once("listening", () => {
      server.close(() => finish());
    });
    server.close((error) => {
      if (!error) {
        finish();
        return;
      }
      if (server.listening) {
        server.close(() => finish());
        return;
      }
      // 绑定尚未完成：上面的 listening 兜底会在绑定完成时关闭它；
      // 这里不能无限等待（绑定可能已经失败、永远不会 listening）。
      finish();
    });
  });
}
