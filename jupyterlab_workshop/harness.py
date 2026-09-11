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
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import yaml

from .environment import EnvironmentSetupError, environment_status, remove_environment
from .lite import LiteBuildOptions, LiteError, build_lite_site, serve_directory
from .publish import DEFAULT_WORKSPACE

PANEL_PLUGIN = "@jupyterlab-workshop/labextension:panel"

#: Sub-path the JupyterLite site is served under during a self-test.
LITE_PREFIX = "lite"

RUN_ALL_COMMAND = "workshop:run-all"

PROGRESS_COMMAND = "workshop:self-test-progress"

#: Where the page keeps the outcome of the run-all command while the
#: harness polls for it.
RESULT_SLOT = "__jupyterlabWorkshopSelfTest"

#: How often the harness polls the page for progress, in milliseconds.
POLL_MS = 2000


def _emit(text: str, *, error: bool = False) -> None:
    """Write a line to stdout, or stderr with ``error``, waiting out a
    pipe that has been put into non-blocking mode.

    Node, which Playwright runs its driver in, puts every pipe it
    inherits into non-blocking mode, and the flag lives on the file
    description the harness shares with it. When stderr and stdout are
    the same pipe (``2>&1 | tee`` in a CI job, say) a plain print() then
    raises BlockingIOError whenever the pipe is momentarily full, which
    loses progress lines and, in an exception handler, hides the failure
    being reported. So harness output is written at the descriptor
    level, retrying until the reader has made room.
    """

    stream = sys.stderr if error else sys.stdout
    line = text + "\n"

    # A stream that is not a real file (pytest's capture, pythonw) has
    # no descriptor to write to, and no non-blocking flag either.
    try:
        fd = stream.fileno()
    except (AttributeError, OSError, ValueError):
        stream.write(line)
        stream.flush()
        return

    # Anything the stream still buffers goes first, so lines keep their
    # order; a flush can hit the same error, and leaves the rest buffered
    # for the next attempt.
    while True:
        try:
            stream.flush()
            break
        except BlockingIOError:
            _wait_writable(fd)

    data = line.encode(stream.encoding or "utf-8", errors="replace")

    while data:
        try:
            written = os.write(fd, data)
        except BlockingIOError:
            _wait_writable(fd)
            continue

        data = data[written:]


def _wait_writable(fd: int) -> None:
    # A pipe refills in small steps once it has been full (macOS hands
    # out a few hundred bytes at a time), so waiting on select() rather
    # than sleeping keeps up with the reader instead of pausing after
    # every step. select() cannot watch a pipe on Windows, but no pipe
    # is non-blocking there either, so a short sleep is the fallback.
    try:
        select.select([], [fd], [], 1.0)
    except (OSError, ValueError):
        time.sleep(0.02)


def _restore_blocking() -> None:
    """Put stdout and stderr back into blocking mode.

    Called once Playwright's Node driver is running, since that is what
    sets the non-blocking flag (see ``_emit``). ``_emit`` copes either
    way; this is for everything that does not go through it, such as a
    traceback Python prints on the way out, and for anything else in the
    process that writes to the same pipes.
    """

    for stream in (sys.stdout, sys.stderr):
        try:
            os.set_blocking(stream.fileno(), True)
        except (AttributeError, OSError, ValueError):
            continue


def _say(message: str) -> None:
    """Print a progress line straight away, so a CI log shows where a run is."""

    _emit(f"[self-test] {message}")


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
        _emit(
            "error: `jupyter workshop test` needs the test extra: pip install "
            '"jupyterlab-workshop[test]" and then '
            "`playwright install chromium`",
            error=True,
        )

        raise SystemExit(2) from error

    # The root is removed by hand rather than by a TemporaryDirectory
    # context, whose cleanup raises on Windows when a process from the
    # server's tree still holds a file, turning a passed run into a
    # failure after the report; see remove_work_directory.
    work = Path(tempfile.mkdtemp(prefix="workshop-test-"))

    try:
        if options.lite:
            raw = _run_lite(options, work, sync_playwright)
        else:
            raw = _run_server(options, work, sync_playwright)
    finally:
        remove_work_directory(work)

    report = _to_report(raw)

    _print_report(report)

    if options.junit:
        options.junit.write_text(_junit(report), encoding="utf-8")
        _emit(f"wrote {options.junit}")

    if options.json_out:
        options.json_out.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
        _emit(f"wrote {options.json_out}")

    return 1 if report.failed > 0 else 0


def _run_server(options: SelfTestOptions, work: Path, sync_playwright: Any) -> object:
    root, name = _prepare_root(options, work)
    settings = _write_overrides(work, options.trust)
    port = _free_port()
    token = secrets.token_hex(16)
    log = work / "jupyterlab.log"

    _say(f"starting JupyterLab on port {port} with root {root}")

    server = _start_server(root, port, token, settings, work / "lab", log)

    try:
        _wait_for_server(port, token, server, log)
        _say("server is answering; opening the browser")

        raw = _drive(
            sync_playwright,
            f"http://127.0.0.1:{port}/lab?token={token}",
            name,
            options,
            ready_timeout=120000,
        )
    except BaseException:
        _dump_server_log(log)

        raise
    else:
        # A failure with no more than the browser's word for it is hard to
        # explain later, so the server side of the story is kept too.
        if isinstance(raw, dict) and (
            raw.get("timedOut") or _to_report(raw).failed > 0
        ):
            _dump_server_log(log)

        return raw
    finally:
        _stop_server(server)

        # The copy is about to be deleted, and a kernelspec pointing into
        # it would linger in every kernel picker; in place the workshop
        # stays, and so does its kernel.
        if not options.in_place:
            forget_environment(root, name)


def forget_environment(root: Path, name: str) -> str | None:
    """Unregister the kernel of the environment a self-test created for
    the workshop ``name`` under ``root``, and drop the venv with it.

    Returns the kernel name when one was registered, else None. A workshop
    that declares no environment, or has none created, is left alone.
    """

    try:
        environment = yaml.safe_load((root / name / "workshop.yaml").read_text())
    except (OSError, yaml.YAMLError):
        return None

    if not isinstance(environment, dict):
        return None

    declared = environment.get("environment")

    if not isinstance(declared, dict) or not declared.get("requirements"):
        return None

    kernel = str(declared.get("kernel") or f"workshop-{environment.get('name')}")

    try:
        status = environment_status(root, name, kernel)

        remove_environment(root, name, kernel)
    except EnvironmentSetupError as error:
        _say(f"unable to remove the workshop environment: {error}")

        return None

    if status.registered:
        _say(f"unregistered the kernel {status.kernel} the test created")

    return status.kernel if status.registered else None


def _dump_server_log(log: Path) -> None:
    tail = _tail(log).strip()

    if tail:
        _emit("[self-test] JupyterLab server log (tail):")
        _emit(tail)


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
        # The driver is running now, and has had its way with the pipes.
        _restore_blocking()

        browser = playwright.chromium.launch(headless=not options.headed)
        page = browser.new_page()

        # Browser-side failures are the likeliest reason for a run that
        # never starts, so surface them in the harness output. A message
        # that arrives as the browser closes can no longer be read, and
        # is not worth failing the run over.
        def report_console(message: Any) -> None:
            try:
                kind = message.type
                text = message.text
            except Exception:
                return

            if kind == "error" and not _is_routine_console_noise(text):
                _say(f"browser console error: {text}")

        page.on("console", report_console)
        page.on("pageerror", lambda error: _say(f"browser page error: {error}"))

        _say(f"loading {url.split('?')[0]}")
        page.goto(url)

        try:
            page.wait_for_function(
                "() => window.jupyterapp !== undefined", timeout=ready_timeout
            )
        except PlaywrightTimeoutError as error:
            raise SystemExit(
                f"JupyterLab did not expose its application object within "
                f"{ready_timeout / 1000:.0f}s"
            ) from error

        _say("application object present; waiting for JupyterLab to restore")

        # The restore promise is awaited through a flag so the wait can carry
        # a deadline; a bare evaluate of the promise would block forever.
        page.evaluate(
            f"() => {{ window.{RESULT_SLOT}Restored = false;"
            f" window.jupyterapp.restored.then("
            f"() => {{ window.{RESULT_SLOT}Restored = true; }}); }}"
        )

        try:
            page.wait_for_function(
                f"() => window.{RESULT_SLOT}Restored === true", timeout=ready_timeout
            )
        except PlaywrightTimeoutError as error:
            raise SystemExit(
                f"JupyterLab did not finish restoring within "
                f"{ready_timeout / 1000:.0f}s"
            ) from error

        _say(f"JupyterLab restored; starting {RUN_ALL_COMMAND} for {name}")

        # Start the run and park its outcome on the window rather than
        # awaiting the promise, so the polling below can carry a deadline.
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

        outcome = _poll_until_done(page, options.timeout)

        if outcome is None:
            progress = page.evaluate(
                "command => window.jupyterapp.commands.execute(command)",
                PROGRESS_COMMAND,
            )
            browser.close()

            return timed_out_report(name, progress, options.timeout)

        browser.close()

    if not isinstance(outcome, dict) or "result" not in outcome:
        failure = outcome.get("error") if isinstance(outcome, dict) else outcome

        raise SystemExit(f"{RUN_ALL_COMMAND} failed: {failure}")

    return outcome["result"]


def _is_routine_console_noise(text: str) -> bool:
    # JupyterLab logs a 404 for every optional resource it probes, such as
    # the run's own (empty) workspace and per-user settings, so those say
    # nothing about a run.
    return text.startswith("Failed to load resource:")


def _poll_until_done(page: Any, timeout: float) -> object:
    """Poll the page until the run finishes, echoing progress as it goes.

    Returns the outcome parked on the window, or None once ``timeout``
    seconds pass without it.
    """

    deadline = time.monotonic() + timeout
    reported = 0
    running: str | None = None

    while True:
        outcome = page.evaluate(f"() => window.{RESULT_SLOT}")

        if isinstance(outcome, dict) and outcome.get("done"):
            return outcome

        progress = page.evaluate(
            "command => window.jupyterapp.commands.execute(command)",
            PROGRESS_COMMAND,
        )

        if isinstance(progress, dict):
            results = progress.get("results")
            current = progress.get("current")

            if isinstance(results, list):
                for item in results[reported:]:
                    if isinstance(item, dict):
                        _say(
                            f"{item.get('status')}: {item.get('page')}/"
                            f"{item.get('id')} ({item.get('type')})"
                        )

                reported = len(results)

            label = (
                f"{current.get('page')}/{current.get('id')} ({current.get('type')})"
                if isinstance(current, dict)
                else None
            )

            if label is not None and label != running:
                _say(f"running: {label}")

            running = label

        if time.monotonic() > deadline:
            _say(f"time limit of {timeout:.0f}s reached; abandoning the run")

            return None

        page.wait_for_timeout(POLL_MS)


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

    # A declared workspace is generated when the workshop opens, so a
    # copy of a working checkout leaves it behind and the test starts
    # from the state a learner starts from.
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns(
            "_workshop", ".git", "node_modules", *declared_workspace(source)
        ),
    )

    return root, source.name


def declared_workspace(directory: Path) -> list[str]:
    """The workspace directory of a workshop, ``work`` unless its
    manifest says otherwise, as a one-name list for an ignore pattern;
    empty when there is no manifest to read."""

    try:
        manifest = yaml.safe_load((directory / "workshop.yaml").read_text("utf-8"))
    except (OSError, yaml.YAMLError):
        return []

    workspace = manifest.get("workspace") if isinstance(manifest, dict) else None

    return [str(workspace or DEFAULT_WORKSPACE).strip("/")]


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
    root: Path, port: int, token: str, settings: Path, state: Path, log: Path
) -> subprocess.Popen[bytes]:
    """Start JupyterLab on ``root`` with the overrides in ``settings`` and
    its workspaces and user settings under ``state``, logging to ``log``.
    """

    # JupyterLab keys its workspace file by workspace name, not by server,
    # so every server the user runs shares the layout saved under
    # ~/.jupyter/lab/, and the layout restorer would put tabs from the
    # user's other sessions back into the run: a console whose kernel this
    # server does not have raises a "Select Kernel" dialog under the first
    # action. User settings (a default kernel, a theme, a disabled
    # extension) would shape the run the same way. Both live under the
    # work directory instead, so the run sees neither and writes into
    # neither.

    workspaces = state / "workspaces"
    user_settings = state / "user-settings"

    workspaces.mkdir(parents=True, exist_ok=True)
    user_settings.mkdir(parents=True, exist_ok=True)

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
        f"--LabApp.workspaces_dir={workspaces}",
        f"--LabApp.user_settings_dir={user_settings}",
    ]

    # Nothing is added to the environment: a command that pages, in a
    # workshop that has not set PAGER in its manifest, should hang here
    # as it would for a learner and be reported as a timeout.
    env = {**os.environ}

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


#: How many times, and how far apart, to retry removing the work directory.
REMOVE_ATTEMPTS = 10

REMOVE_DELAY = 1.0


def remove_work_directory(
    work: Path,
    remover: Callable[[Path], None] = shutil.rmtree,
    sleep: Callable[[float], None] = time.sleep,
    attempts: int = REMOVE_ATTEMPTS,
    delay: float = REMOVE_DELAY,
) -> bool:
    """Remove the self-test's root, retrying while something holds it.

    Stopping the server takes its kernels and terminals down with it,
    but on Windows they can release their files a moment after the
    server has gone, and a directory with an open handle cannot be
    removed. The removal is retried for a while; if it still fails the
    directory is left behind with a warning, since by then the report is
    what matters. Returns whether the directory is gone. The remover and
    sleep are parameters so tests can drive them.
    """

    for attempt in range(1, attempts + 1):
        try:
            remover(work)

            return True
        except FileNotFoundError:
            return True
        except OSError as error:
            if attempt == attempts:
                _emit(
                    f"warning: leaving {work} behind, still in use: {error}",
                    error=True,
                )

                return False

            sleep(delay)

    return False


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

        _emit(
            f"{mark} {result.get('page')}/{result.get('id')} ({result.get('type')},"
            f" {float(result.get('seconds', 0)):.1f}s){detail}"
        )

    _emit(f"\n{report.passed} passed, {report.failed} failed, {report.skipped} skipped")


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
