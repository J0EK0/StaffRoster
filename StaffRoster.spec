# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules

# OR-Tools has 100+ native C++ libs; collect_all grabs everything automatically.
ortools_datas, ortools_binaries, ortools_hiddenimports = collect_all("ortools")

extra_hidden = (
    collect_submodules("uvicorn")
    + collect_submodules("fastapi")
    + collect_submodules("starlette")
    + collect_submodules("anyio")
    + collect_submodules("pydantic")
    + collect_submodules("pydantic_core")
    + [
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.loops.asyncio",
        "anyio._backends._asyncio",
        "anyio._backends._trio",
    ]
)

static_datas = [
    ("index.html", "."),
    ("css", "css"),
    ("js", "js"),
    ("lib", "lib"),
]

server_datas = [
    ("server/main.py", "server"),
    ("server/solver.py", "server"),
    ("server/models.py", "server"),
    ("server/rules.py", "server"),
    # test_july.py intentionally excluded — imports `requests` which is not
    # in requirements.txt and is not needed at runtime.
]

a = Analysis(
    ["launcher.py"],
    pathex=[".", "server"],
    binaries=ortools_binaries,
    datas=static_datas + server_datas + ortools_datas,
    hiddenimports=ortools_hiddenimports + extra_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["test_july", "pytest", "requests", "tkinter", "matplotlib",
              "numpy", "pandas", "scipy"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StaffRoster",
    debug=False,
    strip=False,
    upx=False,      # UPX can corrupt native libs — keep off
    console=True,   # visible console so users see startup progress
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="StaffRoster",  # output: dist/StaffRoster/
)
