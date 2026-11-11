"""JSON-over-stdin command protocol: one request in, one response out (UTF-8)."""
from __future__ import annotations

import json
import os
import sys
import traceback

from .static_analysis import StaticError, TemplateIndex, build_static_graph, list_classes


def _error(kind: str, message: str, log: str = "") -> dict:
    return {"ok": False, "error": {"kind": kind, "message": message, "log": log}}


def _trace(request: dict) -> dict:
    file, entry = request["file"], request["entry"]
    root = request.get("workspaceRoot") or os.path.dirname(os.path.abspath(file))
    ctor_kwargs = request.get("ctorKwargs") or {}
    inputs = request.get("inputs") or {}
    index = TemplateIndex(root)
    static = build_static_graph(index, file, entry)  # StaticError propagates: nothing to show
    static.meta.ctor_kwargs, static.meta.inputs = ctor_kwargs, inputs
    # imported lazily so `list` and `static` never load torch
    from .merge import build_traced_graph
    from .tracing import TraceError, trace
    try:
        result = trace(file, entry, ctor_kwargs, inputs, request.get("device") or "auto", root)
        graph = build_traced_graph(index, result, file, entry, ctor_kwargs, inputs)
        return {"ok": True, "graph": graph.to_dict()}
    except TraceError as e:
        static.meta.trace_error = f"{e.kind}: {e.message}"
        return {"ok": True, "graph": static.to_dict(), "log": e.log}
    except Exception as e:  # noqa: BLE001 - never lose the static graph
        static.meta.trace_error = f"internal: {type(e).__name__}: {e}"
        return {"ok": True, "graph": static.to_dict(), "log": traceback.format_exc()}


def handle(request: dict) -> dict:
    try:
        if not isinstance(request, dict):
            return _error("bad-request", "Request must be a JSON object")
        command = request.get("command")
        if command == "list":
            return {"ok": True, "classes": list_classes(request["file"])}
        if command == "static":
            root = request.get("workspaceRoot") or os.path.dirname(os.path.abspath(request["file"]))
            graph = build_static_graph(TemplateIndex(root), request["file"], request["entry"])
            return {"ok": True, "graph": graph.to_dict()}
        if command == "trace":
            return _trace(request)
        return _error("bad-request", f"Unknown command: {command!r}")
    except StaticError as e:
        return _error(e.kind, e.message)
    except KeyError as e:
        return _error("bad-request", f"Missing field: {e.args[0]}")
    except Exception as e:  # noqa: BLE001
        return _error("internal", f"{type(e).__name__}: {e}", traceback.format_exc())


def main() -> int:
    out = sys.stdout.buffer
    sys.stdout = sys.stderr  # anything user code prints must not corrupt the response
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        response = _error("bad-request", f"Request is not valid JSON: {e}")
    else:
        response = handle(request)
    out.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))
    out.flush()
    return 0
