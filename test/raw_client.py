#!/usr/bin/env python3
"""
raw_client.py -- 旧版 file IPC 诊断客户端。

默认桥现已使用 Windows IO PIPE 并依赖 Node Relay。本文件只用于检查历史
file IPC 桥；当前服务器不再启用该传输。

Usage:  python raw_client.py            # runs the read-only smoke sequence
        (set SV_COPILOT_DIR to match the SynthV side; defaults to %TEMP%\\sv-copilot)
"""
import json, os, time, tempfile

DIR = os.environ.get("SV_COPILOT_DIR") or os.path.join(tempfile.gettempdir(), "sv-copilot")
CMD = os.path.join(DIR, "command.json")
RESP = os.path.join(DIR, "response.json")
_id = 0


def call(timeout=5.0, **cmd):
    global _id
    _id += 1
    cmd["id"] = _id
    os.makedirs(DIR, exist_ok=True)
    try:
        os.remove(RESP)
    except FileNotFoundError:
        pass
    tmp = CMD + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cmd, f)
    os.replace(tmp, CMD)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(RESP, encoding="utf-8") as f:
                data = f.read()
        except FileNotFoundError:
            time.sleep(0.02); continue
        if not data:
            time.sleep(0.02); continue
        try:
            r = json.loads(data)
        except json.JSONDecodeError:
            time.sleep(0.02); continue
        if r.get("id") != _id:
            time.sleep(0.02); continue
        try:
            os.remove(RESP)
        except FileNotFoundError:
            pass
        return r
    return {"error": "TIMEOUT", "id": _id}


def handle(x):
    return x["__handle__"] if isinstance(x, dict) and "__handle__" in x else None


def sv(h, method, *args):
    c = {"op": "call", "method": method, "args": list(args)}
    if h is not None:
        c["handle"] = h
    return call(**c)


def show(label, resp):
    if resp.get("ok"):
        print(f"  OK    {label:38} -> {json.dumps(resp.get('result'), ensure_ascii=False)}")
    else:
        print(f"  ERR   {label:38} -> {resp.get('error') or resp}")


if __name__ == "__main__":
    print(f"dir = {DIR}\n")

    print("ping:")
    show("ping", call(op="ping"))

    print("\nroot:")
    root = call(op="root")
    show("root", root)
    res = root.get("result", {}) or {}
    projectH = handle(res.get("project"))
    timeAxisH = handle(res.get("timeAxis"))
    mainEditorH = handle(res.get("mainEditor"))

    print("\nproject (read-only):")
    show("project:getFileName", sv(projectH, "getFileName"))
    show("project:getNumTracks", sv(projectH, "getNumTracks"))
    show("project:getDuration", sv(projectH, "getDuration"))

    print("\ntimeAxis (read-only):")
    tm = sv(timeAxisH, "getTempoMarkAt", 0)
    show("timeAxis:getTempoMarkAt(0)", tm)
    mm = sv(timeAxisH, "getMeasureMarkAtBlick", 0)
    show("timeAxis:getMeasureMarkAtBlick(0)", mm)

    print("\ntrack 1 / group / notes (read-only):")
    tr = sv(projectH, "getTrack", 1)
    show("project:getTrack(1)", tr)
    trackH = handle(tr.get("result"))
    if trackH is not None:
        show("track:getName", sv(trackH, "getName"))
        show("track:getNumGroups", sv(trackH, "getNumGroups"))
        gr = sv(trackH, "getGroupReference", 1)
        show("track:getGroupReference(1)", gr)
        grH = handle(gr.get("result"))
        if grH is not None:
            g = sv(grH, "getTarget")
            show("groupRef:getTarget", g)
            groupH = handle(g.get("result"))
            if groupH is not None:
                nn = sv(groupH, "getNumNotes")
                show("group:getNumNotes", nn)
                if (nn.get("result") or 0) >= 1:
                    n = sv(groupH, "getNote", 1)
                    noteH = handle(n.get("result"))
                    show("group:getNote(1)", n)
                    if noteH is not None:
                        show("note:getLyrics", sv(noteH, "getLyrics"))
                        show("note:getPitch", sv(noteH, "getPitch"))
                        show("note:getOnset", sv(noteH, "getOnset"))

    print("\nmain editor / selection (read-only):")
    if mainEditorH is not None:
        selr = sv(mainEditorH, "getSelection")
        show("mainEditor:getSelection", selr)
        selH = handle(selr.get("result"))
        if selH is not None:
            show("selection:getSelectedNotes", sv(selH, "getSelectedNotes"))
