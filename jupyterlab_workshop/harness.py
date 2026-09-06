"""The self-test harness behind ``jupyter workshop test``.

It starts a JupyterLab server on a free port with the workshop's parent
directory as its root and trust forced through a settings override, opens
JupyterLab in a headless browser with Playwright, runs the extension's
``workshop:run-all`` command, and reports every action's outcome.

With ``lite`` set it builds a static JupyterLite site carrying the
workshop instead, serves it from a plain static file server under a
sub-path (as GitHub Pages would), and drives that the same way.
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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from .lite import LiteBuildOptions, LiteError, build_lite_site, serve_directory

PANEL_PLUGIN = "@jupyterlab-workshop/labextension:panel"

#: Sub-path the JupyterLite site is served under during a self-test.
LITE_PREFIX = "lite"

RUN_ALL_COMMAND = "workshop:run-all"

PROGRESS_COMMAND = "workshop:self-test-progress"

#: Where the page keeps the outcome of the run-all command while the
#: harness polls for it.
RESULT_SLOT = "__jupyterlabWorkshopSelfTest"


@dataclass(frozen=True)
class SelfTestOptions:
    """What ``run_self_test`` needs."""

    directory: Path
    in_place: bool = False
    headed: bool = False

    #: Seconds to allow for the whole run before it is abandoned.
    timeout: float = 1200.0

    #: Seconds one action may take before the run stops at it.
    action_timeout: float = 300.0
    trust: str = "trusted"
    junit: Path | None = None
    json_out: Path | None = None

    #: Run in a JupyterLite build rather than a JupyterLab server.
    lite: bool = False

    #: JupyterLite build cache directory; None for the default.
    lite_dir: Path | None = None


@dataclass
class SelfTestReport:
    """The outcome of a run, mirroring the extension's report."""

    workshop: str
    results: list[dict[str, Any]] = field(default_factory=list)
    passed: int = 0
    failed: int = 0
    skipped: int = 0


def run_self_test(options: SelfTestOptions) -> int:
    """Run the self-test and print a summary; return the exit code."""

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        print(
            "error: `jupyter workshop test` needs the test extra: pip install "
            '"jupyterlab-workshop[test]" and then '
            "`playwright install chromium`",
            file=sys.stderr,
        )

        raise SystemExit(2) from error

    with tempfile.TemporaryDirectory(prefix="workshop-test-") as tmp:
        work = Path(tmp)

        if options.lite:
            raw = _run_lite(options, work, sync_playwright)
        else:
            raw = _run_server(options, work, sync_playwright)

    report = _to_report(raw)

    _print_report(report)

    if options.junit:
        options.junit.write_text(_junit(report), encoding="utf-8")
        print(f"wrote {options.junit}")

    if options.json_out:
        options.json_out.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {options.json_out}")

    return 1 if report.failed > 0 else 0


def _run_server(options: SelfTestOptions, work: Path, sync_playwright: Any) -> object:
    root, name = _prepare_root(options, work)
    settings = _write_overrides(work, options.trust)
    port = _free_port()
    token = secrets.token_hex(16)
    log = work / "jupyterlab.log"
    server = _start_server(root, port, token, settings, log)

    try:
        _wait_for_server(port, token, server, log)

        return _drive(
            sync_playwright,
            f"http://127.0.0.1:{port}/lab?token={token}",
            name,
            options,
            ready_timeout=120000,
        )
    finally:
        _stop_server(server)


def _run_lite(options: SelfTestOptions, work: Path, sync_playwright: Any) -> object:
    # The site sits one level down so it is served under a sub-path, which
    # is how GitHub Pages serves a project site.
    site = work / "site" / LITE_PREFIX
    name = options.directory.name

    try:
        result = build_lite_site(
            LiteBuildOptions(
                workshops=(options.directory,),
                output=site,
                lite_dir=options.lite_dir,
                trust=options.trust,
            )
        )
    except LiteError as error:
        raise SystemExit(f"error: {error}") from error

    name = result.workshops[0]
    server, port = serve_directory(site.parent)

    try:
        # Pyodide and the terminal's WebAssembly load from a CDN on first
        # use, so the application takes longer to be ready than a server.
        return _drive(
            sync_playwright,
            f"http://127.0.0.1:{port}/{LITE_PREFIX}/lab/index.html",
            name,
            options,
            ready_timeout=300000,
        )
    finally:
        server.shutdown()


def _drive(
    sync_playwright: Any,
    url: str,
    name: str,
    options: SelfTestOptions,
    ready_timeout: int,
) -> object:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not options.headed)
        page = browser.new_page()

        page.goto(url)
        page.wait_for_function(
            "() => window.jupyterapp !== undefined", timeout=ready_timeout
        )
        page.evaluate("() => window.jupyterapp.restored")

        # Start the run and park its outcome on the window rather than
        # awaiting the promise, so the wait below can carry a deadline.
        page.evaluate(
            "([command, path, actionTimeout, slot]) => {"
            "  window[slot] = { done: false };"
            "  window.jupyterapp.commands"
            "    .execute(command, { path, actionTimeout })"
            "    .then("
            "      result => { window[slot] = { done: true, result }; },"
            "      error => {"
            "        window[slot] = { done: true, error: String(error) };"
            "      }"
            "    );"
            "}",
            [RUN_ALL_COMMAND, name, options.action_timeout, RESULT_SLOT],
        )

        try:
            page.wait_for_function(
                f"() => window.{RESULT_SLOT} && window.{RESULT_SLOT}.done",
                timeout=options.timeout * 1000,
            )
        except PlaywrightTimeoutError:
            progress = page.evaluate(
                "command => window.jupyterapp.commands.execute(command)",
                PROGRESS_COMMAND,
            )
            browser.close()

            return timed_out_report(name, progress, options.timeout)

        outcome = page.evaluate(f"() => window.{RESULT_SLOT}")
        browser.close()

    if not isinstance(outcome, dict) or "result" not in outcome:
        error = outcome.get("error") if isinstance(outcome, dict) else outcome

        raise SystemExit(f"{RUN_ALL_COMMAND} failed: {error}")

    return outcome["result"]


def timed_out_report(name: str, progress: object, timeout: float) -> dict[str, Any]:
    """Build a report for a run abandoned at the overall time limit.

    The results gathered so far are kept, and the action that was running
    when time ran out is recorded as a failure so the report says where
    the run stuck.
    """

    results: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    if isinstance(progress, dict):
        raw_results = progress.get("results")
        raw_current = progress.get("current")

        if isinstance(raw_results, list):
            results = [dict(item) for item in raw_results if isinstance(item, dict)]

        if isinstance(raw_current, dict):
            current = raw_current

    if current is not None:
        started = float(current.get("startedAt", 0)) / 1000
        elapsed = max(0.0, time.time() - started) if started else timeout

        results.append(
            {
                "page": current.get("page", ""),
                "id": current.get("id", ""),
                "type": current.get("type", ""),
                "status": "error",
                "message": (
                    f"Still running when the self-test hit its {timeout:.0f}s limit"
                ),
                "seconds": elapsed,
                "timedOut": True,
            }
        )
    else:
        results.append(
            {
                "page": "",
                "id": "self-test",
                "type": "run",
                "status": "error",
                "message": (
                    f"No action was reported as running when the self-test hit "
                    f"its {timeout:.0f}s limit"
                ),
                "seconds": timeout,
                "timedOut": True,
            }
        )

    return {
        "workshop": name,
        "results": results,
        "passed": sum(1 for item in results if item.get("status") == "ok"),
        "failed": sum(1 for item in results if item.get("status") == "error"),
        "skipped": sum(1 for item in results if item.get("status") == "skipped"),
        "timedOut": True,
    }


def _prepare_root(options: SelfTestOptions, work: Path) -> tuple[Path, str]:
    # By default the workshop is copied so the run leaves no files behind.
    source = options.directory

    if options.in_place:
        return source.parent, source.name

    root = work / "root"
    target = root / source.name

    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns("_workshop", ".git", "node_modules"),
    )

    return root, source.name


def _write_overrides(work: Path, trust: str) -> Path:
    settings = work / "settings"

    settings.mkdir(parents=True, exist_ok=True)

    overrides = {
        PANEL_PLUGIN: {
            "defaultWorkshop": "",
            "trustPolicy": {"forcedLevel": trust},
        }
    }

    (settings / "overrides.json").write_text(json.dumps(overrides, indent=2))

    return settings


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))

        return int(sock.getsockname()[1])


def _start_server(
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

    # Pagers would wait for a key press nobody presses, so terminals
    # started by this server get non-interactive ones.
    env = {**os.environ, "PAGER": "cat", "GIT_PAGER": "cat"}

    # The log goes to a file: a pipe nobody reads would fill up and block
    # the server once it had printed enough.
    with log.open("wb") as handle:
        return subprocess.Popen(
            command,
            stdout=handle,
            stderr=subprocess.STDOUT,
            cwd=root,
            env=env,
        )


def _wait_for_server(
    port: int, token: str, server: subprocess.Popen[bytes], log: Path
) -> None:
    deadline = time.monotonic() + 120
    url = f"http://127.0.0.1:{port}/api/status?token={token}"

    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise SystemExit(f"JupyterLab exited before it was ready:\n{_tail(log)}")

        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except (urllib.error.URLError, OSError):
            time.sleep(0.5)

    raise SystemExit(f"JupyterLab did not start within two minutes:\n{_tail(log)}")


def _tail(log: Path) -> str:
    return log.read_text(errors="replace")[-4000:] if log.exists() else ""


def _stop_server(server: subprocess.Popen[bytes]) -> None:
    if server.poll() is not None:
        return

    # On Windows terminate() only ends the server process itself and would
    # leave its kernels and terminals running, so take the whole tree down.
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(server.pid)],
            capture_output=True,
            check=False,
        )
    else:
        server.terminate()

    try:
        server.wait(timeout=15)
    except subprocess.TimeoutExpired:
        server.kill()


def _to_report(raw: object) -> SelfTestReport:
    if not isinstance(raw, dict):
        raise SystemExit(f"Unexpected result from {RUN_ALL_COMMAND}: {raw!r}")

    results = raw.get("results")

    return SelfTestReport(
        workshop=str(raw.get("workshop", "")),
        results=list(results) if isinstance(results, list) else [],
        passed=int(raw.get("passed", 0)),
        failed=int(raw.get("failed", 0)),
        skipped=int(raw.get("skipped", 0)),
    )


def _print_report(report: SelfTestReport) -> None:
    marks = {"ok": "PASS", "error": "FAIL", "skipped": "SKIP"}

    for result in report.results:
        mark = marks.get(str(result.get("status")), "????")
        message = str(result.get("message") or "").strip().splitlines()
        detail = f"  {message[0]}" if message else ""

        print(
            f"{mark} {result.get('page')}/{result.get('id')} ({result.get('type')},"
            f" {float(result.get('seconds', 0)):.1f}s){detail}"
        )

    print(f"\n{report.passed} passed, {report.failed} failed, {report.skipped} skipped")


def _attr(text: str) -> str:
    # Attribute values need quotes escaped as well as the usual characters.
    return escape(text, {'"': "&quot;"})


def _junit(report: SelfTestReport) -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    total = len(report.results)
    time_taken = sum(float(item.get("seconds", 0)) for item in report.results)

    lines.append(
        f'<testsuite name="{_attr(report.workshop)}" tests="{total}" '
        f'failures="{report.failed}" skipped="{report.skipped}" '
        f'time="{time_taken:.3f}">'
    )

    for item in report.results:
        name = _attr(f"{item.get('id')} ({item.get('type')})")
        classname = _attr(str(item.get("page", "")))
        seconds = float(item.get("seconds", 0))
        message = _attr(str(item.get("message") or ""))

        lines.append(
            f'  <testcase classname="{classname}" name="{name}" time="{seconds:.3f}">'
        )

        if item.get("status") == "error":
            lines.append(f'    <failure message="{message}"></failure>')
        elif item.get("status") == "skipped":
            lines.append(f'    <skipped message="{message}"/>')

        lines.append("  </testcase>")

    lines.append("</testsuite>")

    return "\n".join(lines) + "\n"
