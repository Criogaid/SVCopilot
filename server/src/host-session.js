import {
  getApiClass,
  inferReturnedHandleType,
  validateApiCall,
} from "./api-catalog.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { decodeWireValue, stampHandleEpoch } from "./wire-codec.js";

const FATAL_VALIDATION_CODES = new Set(["INVALID_ARGUMENTS", "ARGUMENT_MISMATCH"]);
const ROOT_HANDLE_TYPES = Object.freeze({
  sv: "SV",
  project: "Project",
  timeAxis: "TimeAxis",
  mainEditor: "MainEditorView",
  arrangement: "ArrangementView",
  playback: "PlaybackControl",
});

export class HostSession {
  constructor(bridge, { logger = console, coordinator = new ExecutionCoordinator() } = {}) {
    if (!bridge || typeof bridge.call !== "function") {
      throw new TypeError("bridge must provide call(cmd)");
    }
    this.bridge = bridge;
    this.logger = logger;
    this.coordinator = coordinator;
    this.handleTypes = new Map();
    this.hostVersion = null;
    this.epoch = bridge.getStatus?.().epoch ?? 0;
    // 桥一旦重连过，同一整数 id 可能已被新桥重新分配给另一个对象；
    // 之后不带 __epoch__ 的 handle 无法证明自己来自当前 epoch，必须整体拒绝。
    this.hasReattached = false;

    bridge.on?.("attach", ({ epoch }) => this._resetForEpoch(epoch));
    bridge.on?.("detach", () => this._clearHostState());
  }

  withExclusive(task) {
    return this.coordinator.runExclusive(() => task(this._lease()));
  }

  roots() {
    return this.withExclusive((host) => host.roots());
  }

  call(request) {
    return this.withExclusive((host) => host.call(request));
  }

  index(request) {
    return this.withExclusive((host) => host.index(request));
  }

  free(handle) {
    return this.withExclusive((host) => host.free(handle));
  }

  ping() {
    return this.withExclusive((host) => host.ping());
  }

  getStatus() {
    const bridgeStatus = this.bridge.getStatus?.() ?? {
      state: "unknown",
      epoch: this.epoch,
    };
    return {
      ...bridgeStatus,
      epoch: this.epoch,
      hostVersion: this.hostVersion,
      knownHandleCount: this.handleTypes.size,
      pendingExecutions: this.coordinator.pending,
    };
  }

  _lease() {
    return Object.freeze({
      roots: () => this._roots(),
      call: (request) => this._call(request),
      index: (request) => this._index(request),
      free: (handle) => this._free(handle),
      ping: () => this._bridgeCall({ op: "ping" }),
      status: () => this.getStatus(),
      epoch: () => this.epoch,
      handleType: (handle) => this.handleTypes.get(handle) ?? null,
    });
  }

  async _roots() {
    const result = decodeWireValue(await this._bridgeCall({ op: "root" }), {
      epoch: this.epoch,
    });
    for (const [name, type] of Object.entries(ROOT_HANDLE_TYPES)) {
      this._rememberHandles(result?.[name], type);
    }
    await this._refreshHostVersion();
    return result;
  }

  async _call({
    handle,
    method,
    args = [],
    resultFormat = "legacy",
    resultShape,
    resultLength,
    inferredType,
  }) {
    if (typeof method !== "string" || !method) {
      throw codedError("INVALID_METHOD", "method must be a non-empty string");
    }
    if (!Array.isArray(args)) throw codedError("INVALID_ARGUMENTS", "args must be an array");

    const handleId = this._normalizeHandle(handle);
    const targetType = handleId === undefined ? "SV" : this.handleTypes.get(handleId) ?? null;
    const validation = validateApiCall({
      className: targetType,
      method,
      args,
      hostVersion: this.hostVersion,
      resolveHandleType: (id) => this.handleTypes.get(id) ?? null,
    });
    if (!validation.ok) {
      if (FATAL_VALIDATION_CODES.has(validation.code)) {
        throw codedError(validation.code, validation.message);
      }
      this.logger.error(
        `[sv-copilot] pre-check advisory (${validation.code}) for ${targetType ?? "SV"}.${method}; deferring to host.`
      );
    }

    const cmd = { op: "call", method, args };
    if (handleId !== undefined) cmd.handle = handleId;
    if (resultFormat === "typed-v2") {
      cmd.resultFormat = "typed-v2";
      if (resultShape) cmd.resultShape = resultShape;
      if (resultLength !== undefined) cmd.resultLength = resultLength;
    }

    const raw = await this._bridgeCall(cmd);
    const result = decodeWireValue(raw, { epoch: this.epoch });
    const returnedType =
      inferredType ?? inferReturnedHandleType(targetType, method, args, validation.overloads);
    this._rememberHandles(result, returnedType);
    return result;
  }

  async _index({ handle, field }) {
    if (typeof field !== "string" || !field) {
      throw codedError("INVALID_FIELD", "field must be a non-empty string");
    }
    const handleId = this._normalizeHandle(handle);
    const cmd = { op: "index", field };
    if (handleId !== undefined) cmd.handle = handleId;
    const result = decodeWireValue(await this._bridgeCall(cmd), { epoch: this.epoch });
    this._rememberHandles(result);
    return result;
  }

  async _free(handle) {
    const handleId = this._normalizeHandle(handle, { required: true });
    const result = await this._bridgeCall({ op: "free", handle: handleId });
    this.handleTypes.delete(handleId);
    return result;
  }

  _normalizeHandle(handle, { required = false } = {}) {
    if (handle === undefined || handle === null) {
      if (required) throw codedError("INVALID_HANDLE", "handle is required");
      return undefined;
    }
    const handleId = typeof handle === "number" ? handle : handle?.__handle__;
    if (!Number.isSafeInteger(handleId) || handleId < 1) {
      throw codedError("INVALID_HANDLE", "handle must be a positive safe integer");
    }
    const carriesEpoch =
      typeof handle === "object" && Number.isSafeInteger(handle.__epoch__);
    if (carriesEpoch && handle.__epoch__ !== this.epoch) {
      throw codedError(
        "STALE_HANDLE",
        `handle ${handleId} belongs to bridge epoch ${handle.__epoch__}; current epoch is ${this.epoch}`
      );
    }
    // 裸整数 / 无 __epoch__ 的 handle 在重连后无法与旧 epoch 区分：
    // 新桥会把低位 id 重新分配给别的对象，放行等于允许静默操作错对象。
    if (!carriesEpoch && this.hasReattached) {
      throw codedError(
        "STALE_HANDLE",
        `handle ${handleId} carries no __epoch__ and the bridge has reconnected (current epoch ${this.epoch}); re-resolve handles via sv_root/sv_call and pass the full handle objects returned by the server`
      );
    }
    return handleId;
  }

  _rememberHandles(value, inferredType = null) {
    if (Array.isArray(value)) {
      for (const item of value) this._rememberHandles(item, inferredType);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Number.isSafeInteger(value.__handle__)) {
      stampHandleEpoch(value, this.epoch);
      const explicitType = typeof value.__type__ === "string" ? value.__type__ : null;
      const type = getApiClass(explicitType) ? explicitType : inferredType;
      if (getApiClass(type)) {
        this.handleTypes.set(value.__handle__, type);
        value.__type__ = type;
      }
      return;
    }
    for (const nested of Object.values(value)) this._rememberHandles(nested);
  }

  async _bridgeCall(command) {
    try {
      return await this.bridge.call(command);
    } catch (error) {
      throw classifyHostError(error);
    }
  }

  async _refreshHostVersion() {
    this.hostVersion = null;
    try {
      const hostInfo = await this._call({ method: "getHostInfo", args: [] });
      if (typeof hostInfo?.hostVersion === "string") {
        this.hostVersion = hostInfo.hostVersion;
      } else if (Number.isSafeInteger(hostInfo?.hostVersionNumber)) {
        const version = hostInfo.hostVersionNumber;
        this.hostVersion = `${(version >>> 16) & 0xff}.${(version >>> 8) & 0xff}.${version & 0xff}`;
      }
    } catch {
      this.hostVersion = null;
    }
  }

  _resetForEpoch(epoch) {
    if (this.epoch > 0 && epoch !== this.epoch) this.hasReattached = true;
    this._clearHostState();
    this.epoch = epoch;
  }

  _clearHostState() {
    this.handleTypes.clear();
    this.hostVersion = null;
  }
}

export function isReadOnlyMethod(method) {
  return (
    /^(get|is|has)/.test(method) ||
    /^(blick|quarter|seconds|pitch|freq)/.test(method) ||
    ["T", "blackKey", "snap", "t2x", "v2y", "x2t", "y2v"].includes(method)
  );
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function classifyHostError(error) {
  if (typeof error?.code === "string") return error;
  const message = error instanceof Error ? error.message : String(error);
  const mappings = [
    ["UNKNOWN_METHOD", /no such method/i],
    ["UNKNOWN_FIELD", /no such field/i],
    ["UNKNOWN_HANDLE", /unknown handle/i],
    [
      "INDEX_OUT_OF_RANGE",
      /(?:index|subscript).*(?:out of range|out of bounds)|(?:out of range|out of bounds).*(?:index|subscript)|invalid .*index/i,
    ],
    ["HOST_TIMEOUT", /timeout waiting/i],
    ["HOST_DETACHED", /detached|disconnected|\bEOF\b/i],
  ];
  const match = mappings.find(([, pattern]) => pattern.test(message));
  return codedError(match?.[0] ?? "HOST_CALL_FAILED", message);
}
