// transport.js -- file-IPC transport between the MCP server and the SynthV Lua bridge.
//
// One JSON command file + one JSON response file, matched by an integer id.
// Commands are serialized (one in flight at a time) to match the single-execution
// model on the SynthV side. This whole module is the swap point: a named-pipe
// transport implements the same `init()` + `call(cmd)` surface and index.js is
// unchanged.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export function resolveDir() {
  const d = process.env.SV_COPILOT_DIR;
  if (d && d.length) return d;
  return path.join(os.tmpdir(), "sv-copilot");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FileTransport {
  constructor(dir = resolveDir(), { pollMs = 15, timeoutMs = 15000 } = {}) {
    this.dir = dir;
    this.commandFile = path.join(dir, "command.json");
    this.responseFile = path.join(dir, "response.json");
    this.stateFile = path.join(dir, "state.txt");
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.counter = 0;
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.commandFile, "").catch(() => {});
    await fs.rm(this.responseFile, { force: true }).catch(() => {});
  }

  // Serialize commands: one in flight at a time.
  call(cmd) {
    const run = () => this._call(cmd);
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  async _call(cmd) {
    const id = ++this.counter;
    const payload = { id, ...cmd };
    await fs.rm(this.responseFile, { force: true }).catch(() => {});
    await fs.writeFile(this.commandFile, JSON.stringify(payload));

    const start = Date.now();
    while (Date.now() - start < this.timeoutMs) {
      let text;
      try {
        text = await fs.readFile(this.responseFile, "utf8");
      } catch {
        await sleep(this.pollMs);
        continue;
      }
      if (!text) {
        await sleep(this.pollMs);
        continue;
      }
      let resp;
      try {
        resp = JSON.parse(text);
      } catch {
        await sleep(this.pollMs); // partial write; retry
        continue;
      }
      if (resp.id !== id) {
        await sleep(this.pollMs);
        continue;
      }
      await fs.rm(this.responseFile, { force: true }).catch(() => {});
      if (resp.ok === false) {
        throw new Error(resp.error || "SV bridge error");
      }
      return resp.result;
    }
    throw new Error(
      `Timeout waiting for SynthV bridge response. Is "Start SV Copilot" running in SynthV? (dir=${this.dir})`
    );
  }
}
