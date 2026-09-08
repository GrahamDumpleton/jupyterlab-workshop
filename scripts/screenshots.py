"""Take the screenshots used in the documentation.

A throwaway JupyterLab is started from a temporary root holding the
showcase collection's workshops as installed workshops, a fixture
collection and a fixture catalog, and Playwright drives it through the
states the pages show: the trust dialog, the panel with a workshop
open, author mode, the Finish dialog, the workshop browser with its
collection groups, and the Collections dialog. The images are written
under ``docs/_static`` and are meant to be committed, so the docs build
needs neither a browser nor a server; run this again after an interface
change.

The showcase is cloned from GitHub, or taken from the checkout named by
the ``WORKSHOP_SHOWCASE`` environment variable.

Usage: ``just screenshots`` or ``uv run python scripts/screenshots.py``.
Needs the ``test`` extra and ``playwright install chromium``.
"""

from __future__ import annotations

import json
import os
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
SHOWCASE_REPO = "https://github.com/GrahamDumpleton/jupyterlab-workshop-showcase"
WORKSHOP = "workshops/why-a-workshop"
VIEWPORT = {"width": 1440, "height": 900}

#: Collections that stand in for published ones in the pictures.
FIXTURE_COLLECTIONS: dict[str, dict[str, Any]] = {
    "python-basics": {
        "version": 1,
        "title": "Python basics",
        "description": (
            "The language from the first print to a small program: values, "
            "control flow, functions and modules."
        ),
        "publisher": {"name": "Example Academy", "url": "https://example.org"},
        "icon": "icon.svg",
        "tags": ["python", "beginner"],
        "workshops": [
            {
                "name": "python-first-steps",
                "title": "First steps in Python",
                "description": "Values, names and the notebook.",
                "tags": ["python", "beginner"],
                "platforms": ["linux", "macos", "windows", "lite"],
                "capabilities": ["kernel-exec"],
                "duration": "45m",
                "versions": [
                    {
                        "version": "1.0.0",
                        "source": {
                            "git": "https://github.com/example-org/python-basics",
                            "ref": "main",
                            "subdir": "first-steps",
                        },
                    }
                ],
            },
            {
                "name": "python-control-flow",
                "title": "Loops and conditions",
                "description": "Making decisions and repeating work.",
                "tags": ["python", "beginner"],
                "platforms": ["linux", "macos", "windows", "lite"],
                "capabilities": ["kernel-exec"],
                "duration": "40m",
                "versions": [
                    {
                        "version": "1.0.0",
                        "source": {
                            "git": "https://github.com/example-org/python-basics",
                            "ref": "main",
                            "subdir": "control-flow",
                        },
                    }
                ],
            },
        ],
    },
    "kubernetes-intro": {
        "version": 1,
        "title": "Kubernetes from the command line",
        "description": (
            "Pods, deployments and services with kubectl against a local cluster."
        ),
        "publisher": {"name": "Example Academy", "url": "https://example.org"},
        "icon": "icon.svg",
        "tags": ["kubernetes", "cli"],
        "workshops": [
            {
                "name": "kubernetes-pods",
                "title": "Running your first pod",
                "description": "Create, inspect and delete a pod.",
                "tags": ["kubernetes"],
                "platforms": ["linux", "macos"],
                "capabilities": ["terminal"],
                "duration": "30m",
                "versions": [
                    {
                        "version": "0.3.0",
                        "source": {
                            "git": "https://github.com/example-org/kubernetes-intro",
                            "ref": "main",
                            "subdir": "pods",
                        },
                    }
                ],
            }
        ],
    },
}

#: A catalog offering the fixture collections, one of them not subscribed to.
FIXTURE_CATALOG: dict[str, Any] = {
    "version": 1,
    "title": "Example Academy",
    "description": "Courses from Example Academy.",
    "publisher": {"name": "Example Academy", "url": "https://example.org"},
    "collections": [
        {
            "url": "python-basics/collection.json",
            "title": "Python basics",
            "description": FIXTURE_COLLECTIONS["python-basics"]["description"],
            "publisher": {"name": "Example Academy"},
            "icon": "python-basics/icon.svg",
            "tags": ["python", "beginner"],
        },
        {
            "url": "kubernetes-intro/collection.json",
            "title": "Kubernetes from the command line",
            "description": FIXTURE_COLLECTIONS["kubernetes-intro"]["description"],
            "publisher": {"name": "Example Academy"},
            "icon": "kubernetes-intro/icon.svg",
            "tags": ["kubernetes", "cli"],
        },
    ],
}


def fixture_icon(title: str) -> str:
    """A simple square SVG mark with the title's initial."""

    hue = sum(ord(char) for char in title) % 360

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="12" fill="hsl({hue} 55% 42%)"/>'
        '<text x="32" y="42" text-anchor="middle" font-family="sans-serif" '
        f'font-size="34" font-weight="700" fill="#fff">{title[0]}</text></svg>'
    )


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


def showcase_checkout(work: Path) -> Path:
    """The showcase repository: a local checkout when one is named, else
    a fresh shallow clone."""

    named = os.environ.get("WORKSHOP_SHOWCASE")

    if named:
        return Path(named).resolve()

    checkout = work / "showcase"

    subprocess.run(
        ["git", "clone", "--quiet", "--depth", "1", SHOWCASE_REPO, str(checkout)],
        check=True,
    )

    return checkout


def prepare_root(work: Path) -> Path:
    """Lay out the JupyterLab root: the showcase workshops installed, its
    collection and a fixture collection subscribed to, and a catalog
    offering another."""

    root = work / "root"
    showcase = showcase_checkout(work)

    # The showcase workshops as they are in its checkout, so the browser
    # lists them as installed and matches them to its collection by name.
    for workshop in sorted((showcase / "workshops").iterdir()):
        if (workshop / "workshop.yaml").is_file():
            shutil.copytree(
                workshop,
                root / "workshops" / workshop.name,
                ignore=shutil.ignore_patterns("_workshop"),
            )

    (root / "showcase").mkdir(parents=True, exist_ok=True)
    shutil.copy(showcase / "collection.json", root / "showcase" / "collection.json")

    # Fixture collections with plausible titles so the grouped browser
    # has something to offer.

    for name, collection in FIXTURE_COLLECTIONS.items():
        target = root / name

        target.mkdir(parents=True, exist_ok=True)
        (target / "collection.json").write_text(json.dumps(collection, indent=2))
        (target / "icon.svg").write_text(fixture_icon(collection["title"]))

    (root / "catalog.json").write_text(json.dumps(FIXTURE_CATALOG, indent=2))

    return root


def write_overrides(work: Path) -> Path:
    """Settings for a clean session: no default workshop, local collections."""

    settings = work / "settings"

    settings.mkdir(parents=True, exist_ok=True)

    overrides = {
        PANEL_PLUGIN: {
            "defaultWorkshop": "",
            "collections": [
                "showcase/collection.json",
                "python-basics/collection.json",
            ],
            "catalogs": ["catalog.json"],
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
        # The developer's own user settings and workspaces would override
        # the fixtures, so the session gets empty ones of its own.
        f"--LabApp.user_settings_dir={settings.parent / 'user-settings'}",
        f"--LabApp.workspaces_dir={settings.parent / 'workspaces'}",
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

    # The workshop opens; its second page is the one with the actions, so
    # move there and run the first, which opens a terminal and passes the
    # check beneath it.
    panel = page.locator("#jupyterlab-workshop-panel")

    panel.locator(".jp-WorkshopPanel-title").wait_for(timeout=60000)
    time.sleep(2)
    page.evaluate("window.jupyterapp.commands.execute('workshop:next-page')")
    panel.locator(".jp-WorkshopPanel-action.jp-mod-execute").first.wait_for(
        timeout=30000
    )
    panel.locator(".jp-WorkshopPanel-action.jp-mod-execute").first.click()
    panel.locator(".jp-WorkshopPanel-verify.jp-mod-verify-pass").wait_for(timeout=60000)
    time.sleep(3)
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

    # The workshop browser, with the showcase installed in full and the
    # other subscribed collection's workshops grouped under its heading.
    # The browser scrolls inside the main area, so the window is made
    # tall enough for both sections to show.
    page.set_viewport_size({"width": VIEWPORT["width"], "height": 1900})
    page.evaluate("window.jupyterapp.commands.execute('workshop:browse')")

    browser = page.locator(".jp-WorkshopBrowser")

    browser.wait_for(timeout=30000)
    browser.locator(".jp-WorkshopBrowser-group").nth(1).wait_for(timeout=60000)
    time.sleep(2)
    save(browser, "browser.png")

    # The Collections dialog, listing what is subscribed to and what the
    # catalog offers.
    page.evaluate(
        "() => { void window.jupyterapp.commands.execute('workshop:collections'); }"
    )
    dialog.locator(".jp-WorkshopSources").wait_for(timeout=30000)
    offered = dialog.locator(".jp-WorkshopSources-catalogs .jp-WorkshopSources-row")

    offered.first.wait_for(timeout=60000)
    time.sleep(1)
    save(dialog.locator(".jp-Dialog-content"), "collections-dialog.png")
    dialog.get_by_role("button", name="Close", exact=True).click()


def save(target: Any, name: str) -> None:
    path = OUTPUT / name

    target.screenshot(path=str(path))
    print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
