"""Take the screenshots used in the documentation.

A throwaway JupyterLab is started from a temporary root holding the
Hello JupyterLab example as an installed workshop and the project's
registry index as a local registry, and Playwright drives it through
the states the pages show: the trust dialog, the panel with a workshop
open, author mode, the Finish dialog and the workshop browser. The
images are written under ``docs/_static`` and are meant to be committed,
so the docs build needs neither a browser nor a server; run this again
after an interface change.

Usage: ``just screenshots`` or ``uv run python scripts/screenshots.py``.
Needs the ``test`` extra and ``playwright install chromium``.
"""

from __future__ import annotations

import json
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "_static"
PANEL_PLUGIN = "@jupyterlab-workshop/labextension:panel"
WORKSHOP = "workshops/hello-jupyterlab"
VIEWPORT = {"width": 1440, "height": 900}


def main() -> int:
    """Start JupyterLab, take every screenshot and stop it again."""

    from playwright.sync_api import sync_playwright

    OUTPUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="workshop-shots-") as temporary:
        work = Path(temporary)
        root = prepare_root(work)
        settings = write_overrides(work)
        port = free_port()
        token = secrets.token_hex(16)
        server = start_server(root, port, token, settings, work / "jupyterlab.log")

        try:
            wait_for_server(port, token)

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                page = browser.new_page(viewport=VIEWPORT)

                take_screenshots(page, f"http://127.0.0.1:{port}/lab?token={token}")
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=30)

    return 0


def prepare_root(work: Path) -> Path:
    """Lay out the JupyterLab root: one installed workshop and a registry."""

    root = work / "root"
    installed = root / WORKSHOP

    shutil.copytree(
        ROOT / "examples" / "hello-jupyterlab",
        installed,
        ignore=shutil.ignore_patterns("_workshop", "scratch", "demo"),
    )
    shutil.copy(ROOT / "registry" / "index.json", root / "registry.json")

    return root


def write_overrides(work: Path) -> Path:
    """Settings for a clean session: no default workshop, a local registry."""

    settings = work / "settings"

    settings.mkdir(parents=True, exist_ok=True)

    overrides = {
        PANEL_PLUGIN: {
            "defaultWorkshop": "",
            "registries": ["registry.json"],
            "workshopsDirectory": "workshops",
        },
        "@jupyterlab/apputils-extension:notification": {
            "checkForUpdates": False,
            "fetchNews": "false",
        },
    }

    (settings / "overrides.json").write_text(json.dumps(overrides, indent=2))

    return settings


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))

        return int(sock.getsockname()[1])


def start_server(
    root: Path, port: int, token: str, settings: Path, log: Path
) -> subprocess.Popen[bytes]:
    command = [
        sys.executable,
        "-m",
        "jupyterlab",
        "--no-browser",
        f"--port={port}",
        "--ip=127.0.0.1",
        f"--ServerApp.root_dir={root}",
        f"--IdentityProvider.token={token}",
        "--ServerApp.open_browser=False",
        "--LabApp.expose_app_in_browser=True",
        f"--LabApp.app_settings_dir={settings}",
    ]

    with log.open("wb") as handle:
        return subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT)


def wait_for_server(port: int, token: str) -> None:
    url = f"http://127.0.0.1:{port}/api/status?token={token}"

    for _ in range(120):
        try:
            urllib.request.urlopen(url, timeout=2)

            return
        except (urllib.error.URLError, OSError):
            time.sleep(1)

    raise RuntimeError("JupyterLab did not start")


def take_screenshots(page: Any, url: str) -> None:
    """Drive the session through each state and save its picture."""

    page.goto(f"{url}&reset")
    page.wait_for_function(
        "window.jupyterapp && window.jupyterapp.restored", timeout=120000
    )
    time.sleep(2)

    # Opening the workshop brings up the trust dialog; the command waits
    # for the dialog, so it is not awaited.
    page.evaluate(
        "path => { void window.jupyterapp.commands.execute("
        "'workshop:open', { path }); }",
        WORKSHOP,
    )

    dialog = page.locator(".jp-Dialog")

    dialog.locator(".jp-WorkshopTrust").wait_for(timeout=60000)
    time.sleep(1)
    save(dialog.locator(".jp-Dialog-content"), "trust-dialog.png")
    dialog.get_by_role("button", name="Trust", exact=True).click()

    # The workshop opens and applies its layout.
    panel = page.locator("#jupyterlab-workshop-panel")

    panel.locator(".jp-WorkshopPanel-title").wait_for(timeout=60000)
    time.sleep(4)
    save(page, "panel.png")

    # Author mode adds the toolbar and the action gutters.
    page.evaluate("window.jupyterapp.commands.execute('workshop:author-mode')")
    panel.locator(".jp-WorkshopPanel-authorRow").first.wait_for(timeout=30000)
    time.sleep(1)
    save(panel, "author-mode.png")
    page.evaluate("window.jupyterapp.commands.execute('workshop:author-mode')")
    time.sleep(1)

    # The Finish dialog, as the last page shows it: move to the last page
    # first, since Finish is only enabled there.
    for _ in range(20):
        if page.evaluate("window.jupyterapp.commands.isEnabled('workshop:finish')"):
            break

        page.evaluate("window.jupyterapp.commands.execute('workshop:next-page')")
        time.sleep(0.5)

    page.evaluate(
        "() => { void window.jupyterapp.commands.execute('workshop:finish'); }"
    )
    dialog.locator(".jp-WorkshopFinish").wait_for(timeout=30000)
    time.sleep(1)
    save(dialog.locator(".jp-Dialog-content"), "finish-dialog.png")
    dialog.get_by_role("button", name="Keep reading", exact=True).click()
    time.sleep(1)

    # The workshop browser, with one workshop installed and two available.
    page.evaluate("window.jupyterapp.commands.execute('workshop:browse')")

    browser = page.locator(".jp-WorkshopBrowser")

    browser.wait_for(timeout=30000)
    browser.locator(".jp-WorkshopBrowser-card").first.wait_for(timeout=60000)
    time.sleep(2)
    save(browser, "browser.png")


def save(target: Any, name: str) -> None:
    path = OUTPUT / name

    target.screenshot(path=str(path))
    print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
