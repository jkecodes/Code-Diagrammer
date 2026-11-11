"""Stage 2: run one forward pass and record module and op shapes.

This executes user code. Callers must only invoke it on explicit user request.
"""
from __future__ import annotations

import contextlib
import importlib
import importlib.util
import inspect
import os
import sys
import traceback
from dataclasses import dataclass, field

Key = tuple[int, int, int, int]
Shapes = list  # list[list[int] | None]


class TraceError(Exception):
    def __init__(self, kind: str, message: str, log: str = ""):
        super().__init__(message)
        self.kind = kind  # "import" | "construct" | "input" | "forward"
        self.message = message
        self.log = log or message


@dataclass
class ModuleInfo:
    path: str  # "" for the root
    type: str
    params: int
    class_file: str | None = None  # set only when the class source is in the workspace
    class_line: int | None = None
    in_shapes: Shapes | None = None  # first call; None if never called
    out_shapes: Shapes | None = None
    out_dtypes: list | None = None


@dataclass
class CallRecord:
    module_path: str  # module whose user-defined method is executing
    key: Key  # position of the user-code expression (lineno, col, end_lineno, end_col)
    file: str
    kind: str  # "module" | "op"
    name: str  # callee module path, or torch function name
    out_shapes: Shapes | None = None
    out_dtypes: list | None = None


@dataclass
class TraceResult:
    modules: list[ModuleInfo] = field(default_factory=list)
    calls: list[CallRecord] = field(default_factory=list)
    device: str = "meta"


_REFLECTED = {"add", "sub", "mul", "truediv", "div", "floordiv", "mod", "pow", "matmul",
              "and", "or", "xor", "lshift", "rshift"}


def normalize_op_name(name: str) -> str:
    """`__radd__` / `__iadd__` / `__add__` -> `add`; `__truediv__` -> `div`."""
    if name.startswith("__") and name.endswith("__") and len(name) > 4:
        core = name[2:-2]
        if core[:1] in ("r", "i") and core[1:] in _REFLECTED:
            core = core[1:]
        return "div" if core == "truediv" else core
    return name


def _norm(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


class _Workspace:
    def __init__(self, root: str):
        self.root = _norm(root).rstrip("\\/") + os.sep
        self._cache: dict[str, bool] = {}

    def contains(self, filename: str) -> bool:
        hit = self._cache.get(filename)
        if hit is None:
            p = _norm(filename) if not filename.startswith("<") else ""
            hit = p.startswith(self.root) and "site-packages" not in p
            self._cache[filename] = hit
        return hit


def _is_module_py(filename: str) -> bool:
    f = filename.replace("\\", "/")
    return f.endswith("torch/nn/modules/module.py")


_positions_cache: dict = {}


def _frame_key(frame) -> Key | None:
    code = frame.f_code
    positions = _positions_cache.get(code)
    if positions is None:
        positions = list(code.co_positions())
        _positions_cache[code] = positions
    index = frame.f_lasti // 2
    if index < 0 or index >= len(positions):
        return None
    lineno, end_lineno, col, end_col = positions[index]
    if None in (lineno, end_lineno, col, end_col):
        return None
    return (lineno, col, end_lineno, end_col)


def _import_user_file(path: str, root: str):
    """Import without running `__main__`; by dotted name when inside packages."""
    directory = os.path.dirname(path)
    parts = [os.path.splitext(os.path.basename(path))[0]]
    while os.path.isfile(os.path.join(directory, "__init__.py")):
        parts.insert(0, os.path.basename(directory))
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    for p in (root, os.path.dirname(path), directory):
        if p not in sys.path:
            sys.path.insert(0, p)
    if len(parts) > 1:
        return importlib.import_module(".".join(parts))
    name = "_code_diagrammer_user_" + parts[0]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _check_inputs(cls, inputs: dict) -> None:
    sig = inspect.signature(cls.forward)
    params = list(sig.parameters.values())[1:]  # drop self
    names = {p.name for p in params}
    accepts_kwargs = any(p.kind is p.VAR_KEYWORD for p in params)
    for key in inputs:
        if key not in names and not accepts_kwargs:
            raise TraceError("input", f"forward has no argument '{key}'")
    for p in params:
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        if p.default is p.empty and p.name not in inputs:
            raise TraceError("input", f"Missing input for forward argument '{p.name}'")


def _make_input(torch, spec, device: str):
    if isinstance(spec, dict) and "value" in spec:
        return spec["value"]
    if isinstance(spec, dict) and "shape" in spec:
        shape, dtype_name = spec["shape"], spec.get("dtype", "float32")
    elif isinstance(spec, list):
        shape, dtype_name = spec, "float32"
    else:
        raise TraceError("input", f"Unrecognized input spec: {spec!r}")
    dtype = getattr(torch, dtype_name, None)
    if dtype is None or not isinstance(dtype, torch.dtype):
        raise TraceError("input", f"Unknown dtype '{dtype_name}'")
    if device == "meta":
        return torch.empty(*shape, dtype=dtype, device="meta")
    if dtype.is_floating_point:
        return torch.randn(*shape, dtype=dtype)
    return torch.zeros(*shape, dtype=dtype)


def _shapes(torch, value):
    """(shapes, dtypes) per output; None for non-tensor elements. (None, None) if no tensor."""
    items = list(value) if isinstance(value, (tuple, list)) else [value]
    shapes, dtypes, found = [], [], False
    for v in items:
        if isinstance(v, torch.Tensor):
            found = True
            shapes.append([int(d) for d in v.shape])
            dtypes.append(str(v.dtype).replace("torch.", ""))
        else:
            shapes.append(None)
            dtypes.append(None)
    return (shapes, dtypes) if found else (None, None)


def _run(torch, cls, ctor_kwargs: dict, inputs: dict, device: str, ws: _Workspace) -> TraceResult:
    try:
        with torch.device(device):
            model = cls(**ctor_kwargs)
        model = model.to(device)
        model.eval()
    except Exception as e:  # noqa: BLE001 - user code can raise anything
        raise TraceError("construct", f"{type(e).__name__}: {e}", traceback.format_exc()) from e

    result = TraceResult(device=device)
    paths: dict[int, str] = {}
    infos: dict[str, ModuleInfo] = {}
    for path, m in model.named_modules():
        paths[id(m)] = path
        info = ModuleInfo(path=path, type=type(m).__name__,
                          params=sum(p.numel() for p in m.parameters()))
        try:
            src = inspect.getsourcefile(type(m))
            if src and ws.contains(src):
                info.class_file = os.path.abspath(src)
                info.class_line = inspect.getsourcelines(type(m))[1]
        except (TypeError, OSError):
            pass
        infos[path] = info
        result.modules.append(info)

    def owner_path(frame) -> str:
        f = frame
        while f is not None:
            owner = f.f_locals.get("self")
            if owner is not None and id(owner) in paths:
                return paths[id(owner)]
            f = f.f_back
        return ""

    def user_frame(frame):
        """Nearest workspace frame above `frame`, unless a module call lies in between."""
        f = frame
        while f is not None:
            name = f.f_code.co_filename
            if ws.contains(name):
                return f
            if _is_module_py(name):
                return None
            f = f.f_back
        return None

    pending: dict[int, list[CallRecord]] = {}

    def pre_hook(module, args, kwargs):
        path = paths.get(id(module))
        if path is None:
            return
        info = infos[path]
        if info.in_shapes is None:
            values = [*args, *kwargs.values()]
            info.in_shapes = [[int(d) for d in v.shape] if isinstance(v, torch.Tensor) else None
                              for v in values]
        f = sys._getframe(1)
        while f is not None and _is_module_py(f.f_code.co_filename):
            f = f.f_back
        record = None
        if f is not None and ws.contains(f.f_code.co_filename):
            key = _frame_key(f)
            if key is not None:
                record = CallRecord(owner_path(f), key, os.path.abspath(f.f_code.co_filename),
                                    "module", path)
                result.calls.append(record)
        pending.setdefault(id(module), []).append(record)

    def post_hook(module, args, output):
        path = paths.get(id(module))
        if path is None:
            return
        shapes, dtypes = _shapes(torch, output)
        info = infos[path]
        if info.out_shapes is None:
            info.out_shapes, info.out_dtypes = shapes, dtypes
        stack = pending.get(id(module))
        record = stack.pop() if stack else None
        if record is not None:
            record.out_shapes, record.out_dtypes = shapes, dtypes

    class Recorder(torch.overrides.TorchFunctionMode):
        def __torch_function__(self, func, types, args=(), kwargs=None):
            out = func(*args, **(kwargs or {}))
            shapes, dtypes = _shapes(torch, out)
            if shapes is not None:
                f = user_frame(sys._getframe(1))
                key = _frame_key(f) if f is not None else None
                if key is not None:
                    name = normalize_op_name(getattr(func, "__name__", str(func)))
                    result.calls.append(CallRecord(
                        owner_path(f), key, os.path.abspath(f.f_code.co_filename), "op", name,
                        shapes, dtypes))
            return out

    handles = []
    for m in model.modules():
        handles.append(m.register_forward_pre_hook(pre_hook, with_kwargs=True))
        handles.append(m.register_forward_hook(post_hook))
    try:
        values = {k: _make_input(torch, v, device) for k, v in inputs.items()}
        bound = inspect.signature(model.forward).bind(**values)
        with torch.no_grad(), Recorder():
            model(*bound.args, **bound.kwargs)
    except TraceError:
        raise
    except Exception as e:  # noqa: BLE001
        raise TraceError("forward", f"{type(e).__name__}: {e}", traceback.format_exc()) from e
    finally:
        for h in handles:
            h.remove()
    return result


def trace(file: str, entry: str, ctor_kwargs: dict, inputs: dict, device: str = "auto",
          workspace_root: str | None = None) -> TraceResult:
    path = os.path.abspath(file)
    root = os.path.abspath(workspace_root or os.path.dirname(path))
    if sys.version_info < (3, 11):
        raise TraceError("import", "Tracing shapes needs Python 3.11 or newer; this interpreter is "
                         f"{sys.version_info.major}.{sys.version_info.minor}")
    with contextlib.redirect_stdout(sys.stderr):
        try:
            import torch
        except ImportError as e:
            raise TraceError("import", "torch is not installed in this Python interpreter",
                             traceback.format_exc()) from e
        if not hasattr(torch.overrides, "TorchFunctionMode"):
            raise TraceError("import", f"Tracing shapes needs torch 2.0 or newer; found {torch.__version__}")
        try:
            module = _import_user_file(path, root)
        except Exception as e:  # noqa: BLE001
            raise TraceError("import", f"{type(e).__name__}: {e}", traceback.format_exc()) from e
        cls = getattr(module, entry, None)
        if cls is None:
            raise TraceError("import", f"Class '{entry}' not found in {path}")
        _check_inputs(cls, inputs)
        ws = _Workspace(root)
        if device != "auto":
            return _run(torch, cls, ctor_kwargs, inputs, device, ws)
        try:
            return _run(torch, cls, ctor_kwargs, inputs, "meta", ws)
        except TraceError as meta_error:
            if meta_error.kind == "input":
                raise
            try:
                return _run(torch, cls, ctor_kwargs, inputs, "cpu", ws)
            except TraceError as cpu_error:
                cpu_error.log = (f"--- cpu ---\n{cpu_error.log}\n--- meta ---\n{meta_error.log}")
                raise
