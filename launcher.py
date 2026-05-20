"""
launcher.py — PyInstaller entry point for StaffRoster.

Double-click the built EXE: uvicorn starts, browser opens, app is ready.
Works both when run from source (python launcher.py) and when frozen.
"""
import multiprocessing
import os
import socket
import sys
import threading
import time
import webbrowser


def _resource_dir() -> str:
    if getattr(sys, "frozen", False):
        return sys._MEIPASS  # type: ignore[attr-defined]
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _resource_dir()

# server/ uses bare relative imports (from models import ...), so it must be
# on sys.path before any import of uvicorn/main touches it.
SERVER_DIR = os.path.join(BASE_DIR, "server")
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

# OR-Tools spawns worker processes on Windows; freeze_support() must be called
# before any multiprocessing code runs, otherwise the frozen exe re-executes
# itself in a loop on every worker spawn.
multiprocessing.freeze_support()


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _find_free_port(start: int = 8000) -> int:
    for p in range(start, start + 20):
        if _port_free(p):
            return p
    raise RuntimeError(f"No free port found in range {start}–{start + 19}")


def _open_browser(port: int) -> None:
    deadline = time.time() + 15
    while time.time() < deadline:
        if not _port_free(port):
            webbrowser.open(f"http://127.0.0.1:{port}/")
            return
        time.sleep(0.2)


if __name__ == "__main__":
    port = _find_free_port()
    os.environ["STAFFROSTER_BASE_DIR"] = BASE_DIR
    os.environ["STAFFROSTER_PORT"] = str(port)

    threading.Thread(target=_open_browser, args=(port,), daemon=True).start()

    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=port, log_level="warning")
