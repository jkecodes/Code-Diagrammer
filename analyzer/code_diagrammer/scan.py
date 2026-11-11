"""Static list of every module class in a workspace (never imports torch or user code)."""
from __future__ import annotations

import ast
import os

from .static_analysis import StaticError, SubmoduleDecl, TemplateIndex, _method

SKIP_DIRS = {"node_modules", "__pycache__", "venv", "env", "build", "dist", "site-packages"}
MAX_FILES = 2000


def _python_files(root: str) -> list[str]:
    found: list[str] = []
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        for name in sorted(files):
            if name.endswith(".py"):
                found.append(os.path.join(folder, name))
                if len(found) >= MAX_FILES:
                    return found
    return found


def _docstring(cls: ast.ClassDef) -> str:
    text = ast.get_docstring(cls) or ""
    first = text.strip().split("\n\n")[0]
    return " ".join(first.split())[:300]


def _flatten(decls: list[SubmoduleDecl]):
    for d in decls:
        yield d
        yield from _flatten(d.items)


def scan_workspace(root: str) -> list[dict]:
    root = os.path.abspath(root)
    index = TemplateIndex(root)
    classes: list[dict] = []
    used: set[tuple[str, str]] = set()
    for path in _python_files(root):
        try:
            info = index.file_info(path)
            names = [n for n in info.classes if index.is_module_class(info, n)]
        except (StaticError, OSError, ValueError, RecursionError):
            continue  # unreadable, not UTF-8 or not valid Python: nothing to list
        for name in names:
            cls = info.classes[name]
            try:
                tpl = index.get(path, name)
                decls = list(_flatten(tpl.submodules)) if tpl else []
            except (StaticError, OSError, ValueError, RecursionError):
                decls = []
            types: list[str] = []
            for d in decls:
                if d.class_ref is not None and d.class_ref != (info.path, name):
                    used.add(d.class_ref)
                short = d.type.rsplit(".", 1)[-1]
                if short and short not in types:
                    types.append(short)
            forward = _method(cls, "forward")
            params = []
            if forward is not None:
                a = forward.args
                params = [x.arg for x in [*a.posonlyargs, *a.args][1:]] + [x.arg for x in a.kwonlyargs]
            classes.append({
                "name": name, "file": info.path, "line": cls.lineno, "forwardParams": params,
                "docstring": _docstring(cls), "submoduleTypes": types,
                "hasForward": forward is not None,
            })
    for c in classes:
        c["candidate"] = c.pop("hasForward") and (c["file"], c["name"]) not in used
    return classes
