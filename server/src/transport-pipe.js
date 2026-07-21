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
    if (Buffer.byteLength(this.fromSvBuffer, "utf8") > this.maxFrameBytes) {
      this._sendReply({ type: "error", code: "FRAME_TOO_LARGE" });
      this._detach(`bridge frame exceeds ${this.maxFrameBytes} bytes`);
      return;
    }

    let newline;
    while ((newline = this.fromSvBuffer.indexOf("\n")) >= 0) {
      const line = this.fromSvBuffer.slice(0, newline);
      this.fromSvBuffer = this.fromSvBuffer.slice(newline + 1);
      if (line.trim()) this._onFrame(line);
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
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          })
      )
    );
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._detach("relay closing");
    await this._closeServers();
    this.initialized = false;
  }
}
