import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.install import InstallOutcome
from jupyterlab_workshop.launch import (
    CONTAINER_PORT,
    PANEL_PLUGIN,
    LaunchError,
    LaunchOptions,
    install_collections,
    launch_overrides,
    launch_query,
    launch_url,
    link_base,
    parse_variable,
    resolve_container,
    server_command,
    wait_for_server,
)


def make_workshop(root: Path, name: str) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    (directory / "workshop.yaml").write_text(f"name: {name}\n")

    return directory


def test_launch_query_names_a_directory_relative_to_the_root(tmp_path: Path) -> None:
    make_workshop(tmp_path / "workshops", "git-basics")

    params = launch_query(
        LaunchOptions(
            target=str(tmp_path / "workshops" / "git-basics"),
            root=tmp_path,
            variables={"repo_dir": "sandbox"},
            restart="ask",
        )
    )

    assert params == [
        ("workshop", "workshops/git-basics"),
        ("var.repo_dir", "sandbox"),
        ("restart", None),
    ]


def test_launch_query_passes_a_url_with_its_selectors(tmp_path: Path) -> None:
    params = launch_query(
        LaunchOptions(
            target="https://github.com/example-org/workshops",
            root=tmp_path,
            ref="v1.2.0",
            subdir="git-basics",
            restart="force",
        )
    )

    assert params == [
        ("workshop", "https://github.com/example-org/workshops"),
        ("ref", "v1.2.0"),
        ("subdir", "git-basics"),
        ("restart", "force"),
    ]


def test_launch_query_keeps_a_name_with_a_collection(tmp_path: Path) -> None:
    params = launch_query(
        LaunchOptions(
            target="lesson-three",
            root=tmp_path,
            collections=[
                "https://example.org/course/collection.json",
                "https://example.org/extra/collection.json",
            ],
        )
    )

    assert params == [
        ("workshop", "lesson-three"),
        ("collection", "https://example.org/course/collection.json"),
        ("collection", "https://example.org/extra/collection.json"),
    ]


def test_launch_query_resolves_local_indexes_and_welcome(tmp_path: Path) -> None:
    course = tmp_path / "course"
    course.mkdir()
    (course / "collection.json").write_text("{}")
    (tmp_path / "catalog.json").write_text("{}")
    (tmp_path / "hello.md").write_text("# Hi\n")

    params = launch_query(
        LaunchOptions(
            root=tmp_path,
            collections=[str(course)],
            catalog=str(tmp_path / "catalog.json"),
            welcome=str(tmp_path / "hello.md"),
        )
    )

    assert params == [
        ("collection", "course/collection.json"),
        ("catalog", "catalog.json"),
        ("welcome", "hello.md"),
    ]


def test_launch_query_refuses_what_a_link_cannot_say(tmp_path: Path) -> None:
    outside = make_workshop(tmp_path / "elsewhere", "ws")
    root = tmp_path / "root"
    root.mkdir()
    make_workshop(root, "git-basics")
    (root / "plain").mkdir()

    with pytest.raises(LaunchError, match="--root"):
        launch_query(LaunchOptions(target=str(outside), root=root))

    with pytest.raises(LaunchError, match="no workshop.yaml"):
        launch_query(LaunchOptions(target=str(root / "plain"), root=root))

    with pytest.raises(LaunchError, match="not a directory or a URL"):
        launch_query(LaunchOptions(target="missing", root=root))

    with pytest.raises(LaunchError, match="URL target only"):
        launch_query(
            LaunchOptions(target=str(root / "git-basics"), root=root, ref="main")
        )

    # A bare name that is also a directory is ambiguous with a collection.
    with pytest.raises(LaunchError, match="both a directory"):
        launch_query(
            LaunchOptions(
                target="git-basics",
                root=root,
                collections=["https://example.org/collection.json"],
            )
        )

    with pytest.raises(LaunchError, match="collection.json"):
        launch_query(LaunchOptions(root=root, collections=[str(root / "nowhere")]))


def test_launch_url_puts_the_token_first_and_keeps_bare_keys() -> None:
    url = launch_url(
        "http://127.0.0.1:8899/",
        "abc",
        [
            ("workshop", "https://github.com/x/y"),
            ("var.name", "a b&c"),
            ("restart", None),
        ],
    )

    assert url == (
        "http://127.0.0.1:8899/lab?token=abc"
        "&workshop=https://github.com/x/y&var.name=a%20b%26c&restart"
    )


def test_launch_overrides_merge_into_the_deployment_settings() -> None:
    existing = {
        PANEL_PLUGIN: {
            "workshopsDirectory": "lessons",
            "trustPolicy": {"trustedSources": ["local:lessons/"]},
        },
        "@jupyterlab/apputils-extension:themes": {"theme": "JupyterLab Dark"},
    }

    # A launch that asks for nothing still turns the news prompt off.
    plain = launch_overrides(existing, LaunchOptions(), browse=False)

    assert plain == {
        **existing,
        "@jupyterlab/apputils-extension:notification": {"fetchNews": "false"},
    }

    merged = launch_overrides(existing, LaunchOptions(trust="trusted"), browse=True)

    assert merged == {
        PANEL_PLUGIN: {
            "workshopsDirectory": "lessons",
            "trustPolicy": {
                "trustedSources": ["local:lessons/"],
                "forcedLevel": "trusted",
            },
            "browseOnStart": True,
        },
        "@jupyterlab/apputils-extension:themes": {"theme": "JupyterLab Dark"},
        "@jupyterlab/apputils-extension:notification": {"fetchNews": "false"},
    }

    # A deployment that has settled the prompt is left alone.
    settled = {
        **existing,
        "@jupyterlab/apputils-extension:notification": {"fetchNews": "true"},
    }

    assert launch_overrides(settled, LaunchOptions(), browse=False)[
        "@jupyterlab/apputils-extension:notification"
    ] == {"fetchNews": "true"}

    # The deployment's own settings are not changed in place.
    assert "forcedLevel" not in existing[PANEL_PLUGIN]["trustPolicy"]


def test_server_command_pins_the_port_and_isolates_when_fresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed = tmp_path / "installed"
    installed.mkdir()
    (installed / "overrides.json").write_text(
        json.dumps({PANEL_PLUGIN: {"welcome": "hello.md"}})
    )
    (installed / "page_config.json").write_text('{"exposeAppInBrowser": true}')

    monkeypatch.setattr(
        "jupyterlab_workshop.launch.installed_settings_dir", lambda: installed
    )

    work = tmp_path / "work"
    root = tmp_path / "root"
    root.mkdir()

    command = server_command(
        root,
        8899,
        "tok",
        LaunchOptions(root=root, trust="restricted", fresh=True, lab_args=("--debug",)),
        work,
        browse=True,
    )

    assert command[1:4] == ["-m", "jupyterlab", "--no-browser"]
    assert "--port=8899" in command
    assert "--ServerApp.port_retries=0" in command
    assert f"--ServerApp.root_dir={root}" in command
    assert "--IdentityProvider.token=tok" in command
    assert f"--LabApp.app_settings_dir={work / 'settings'}" in command
    assert f"--LabApp.workspaces_dir={work / 'workspaces'}" in command
    assert f"--LabApp.user_settings_dir={work / 'user-settings'}" in command
    assert command[-1] == "--debug"

    written = json.loads((work / "settings" / "overrides.json").read_text())

    assert written[PANEL_PLUGIN] == {
        "welcome": "hello.md",
        "trustPolicy": {"forcedLevel": "restricted"},
        "browseOnStart": True,
    }
    assert written["@jupyterlab/apputils-extension:notification"] == {
        "fetchNews": "false"
    }
    assert (work / "settings" / "page_config.json").read_text() == (
        '{"exposeAppInBrowser": true}'
    )


def test_server_command_writes_only_the_news_setting_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "jupyterlab_workshop.launch.installed_settings_dir", lambda: None
    )

    work = tmp_path / "work"
    command = server_command(
        tmp_path, 8899, "tok", LaunchOptions(root=tmp_path), work, False
    )

    # A launch that asks for nothing still gives JupyterLab a settings
    # directory, holding only the block that turns the news prompt off,
    # and leaves the workspaces and user settings where they are.
    assert f"--LabApp.app_settings_dir={work / 'settings'}" in command
    assert not any(item.startswith("--LabApp.workspaces_dir") for item in command)
    assert not any(item.startswith("--LabApp.user_settings_dir") for item in command)

    written = json.loads((work / "settings" / "overrides.json").read_text())

    assert written == {
        "@jupyterlab/apputils-extension:notification": {"fetchNews": "false"}
    }
    assert not (work / "settings" / "page_config.json").exists()


def test_resolve_container_applies_the_container_defaults() -> None:
    environ = {"JUPYTER_TOKEN": "kept"}

    # Detected, with nothing asked for: the container defaults apply.
    resolved = resolve_container(LaunchOptions(), environ, detected=True)

    assert resolved.container is True
    assert resolved.port == CONTAINER_PORT
    assert resolved.token == "kept"
    assert resolved.trust == "trusted"
    assert resolved.open_browser is False

    # Anything given explicitly wins over the defaults.
    chosen = resolve_container(
        LaunchOptions(port=9000, token="mine", trust="ask"), environ, detected=True
    )

    assert (chosen.port, chosen.token, chosen.trust) == (9000, "mine", "ask")

    # Without the variable the token is left for the launch to generate.
    assert resolve_container(LaunchOptions(), {}, detected=True).token is None


def test_resolve_container_is_decided_by_the_flag_before_detection() -> None:
    environ = {"JUPYTER_TOKEN": "kept"}

    # Not detected and not asked for: the options come back unchanged
    # apart from the mode being settled.
    plain = resolve_container(LaunchOptions(), environ, detected=False)

    assert plain == LaunchOptions(container=False)

    # --container on a desktop, and --no-container in a container.
    forced = resolve_container(LaunchOptions(container=True), environ, detected=False)

    assert forced.container is True
    assert forced.port == CONTAINER_PORT

    declined = resolve_container(LaunchOptions(container=False), environ, detected=True)

    assert declined.container is False
    assert declined.port is None
    assert declined.open_browser is True


def test_link_base_prefers_the_url_option() -> None:
    assert link_base(LaunchOptions(), 8899) == "http://127.0.0.1:8899"
    assert (
        link_base(LaunchOptions(url="https://lab.example.org/"), 8888)
        == "https://lab.example.org"
    )


def test_server_command_listens_on_every_interface_in_a_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "jupyterlab_workshop.launch.installed_settings_dir", lambda: None
    )

    inside = server_command(
        tmp_path, 8888, "tok", LaunchOptions(container=True), tmp_path / "a", False
    )
    outside = server_command(
        tmp_path, 8888, "tok", LaunchOptions(container=False), tmp_path / "b", False
    )

    assert "--ServerApp.ip=0.0.0.0" in inside
    assert "--ServerApp.ip=0.0.0.0" not in outside


def test_install_collections_installs_each_collection_into_the_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed = tmp_path / "installed"
    installed.mkdir()
    (installed / "overrides.json").write_text(
        json.dumps({PANEL_PLUGIN: {"workshopsDirectory": "lessons"}})
    )
    monkeypatch.setattr(
        "jupyterlab_workshop.launch.installed_settings_dir", lambda: installed
    )

    course = tmp_path / "course"
    course.mkdir()
    (course / "collection.json").write_text("{}")

    calls: list[tuple[Any, ...]] = []

    def fake_install(
        location: str, root: Path, directory: str, **kwargs: Any
    ) -> list[InstallOutcome]:
        calls.append((location, root, directory, kwargs["platform"]))

        return [InstallOutcome("one", "One", "installed", "lessons/one")]

    monkeypatch.setattr("jupyterlab_workshop.launch.install_collection", fake_install)
    monkeypatch.setattr("jupyterlab_workshop.launch.current_os", lambda: "linux")

    lines: list[str] = []
    install_collections(
        LaunchOptions(collections=["https://example.org/collection.json", str(course)]),
        tmp_path,
        report=lines.append,
    )

    assert calls == [
        ("https://example.org/collection.json", tmp_path, "lessons", "linux"),
        (str(course / "collection.json"), tmp_path, "lessons", "linux"),
    ]


def test_install_collections_refuses_a_failure_and_an_empty_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "jupyterlab_workshop.launch.installed_settings_dir", lambda: None
    )

    def failing_install(*args: Any, **kwargs: Any) -> list[InstallOutcome]:
        return [
            InstallOutcome("one", "One", "installed", "workshops/one"),
            InstallOutcome("two", "Two", "failed", "404"),
        ]

    monkeypatch.setattr(
        "jupyterlab_workshop.launch.install_collection", failing_install
    )

    with pytest.raises(LaunchError, match="unable to install two"):
        install_collections(
            LaunchOptions(collections=["https://example.org/collection.json"]),
            tmp_path,
            report=lambda line: None,
        )

    with pytest.raises(LaunchError, match="--collection"):
        install_collections(LaunchOptions(), tmp_path, report=lambda line: None)


def test_wait_for_server_reports_an_early_exit() -> None:
    class Exited:
        returncode = 3

        def poll(self) -> int:
            return self.returncode

    with pytest.raises(LaunchError, match="status 3"):
        wait_for_server(1, "tok", Exited(), timeout=5)  # type: ignore[arg-type]


def test_wait_for_server_gives_up_after_the_timeout() -> None:
    class Running:
        def poll(self) -> None:
            return None

    with pytest.raises(LaunchError, match="did not start"):
        wait_for_server(1, "tok", Running(), timeout=0.2, sleep=0.05)  # type: ignore[arg-type]


def test_parse_variable() -> None:
    assert parse_variable("repo_dir=sandbox") == ("repo_dir", "sandbox")
    assert parse_variable("empty=") == ("empty", "")

    with pytest.raises(LaunchError):
        parse_variable("novalue")

    with pytest.raises(LaunchError):
        parse_variable("bad-name=1")


def test_launch_command_builds_options_and_passes_arguments_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(options: LaunchOptions) -> int:
        captured["options"] = options

        return 0

    monkeypatch.setattr("jupyterlab_workshop.launch.run_launch", fake_run)
    monkeypatch.chdir(tmp_path)

    assert (
        cli.main(
            [
                "launch",
                "https://github.com/x/y",
                "--ref",
                "v1",
                "--var",
                "a=1",
                "--var",
                "b=2",
                "--restart=force",
                "--trust",
                "trusted",
                "--no-browser",
                "--fresh",
                "--collection",
                "https://example.org/collection.json",
                "--install",
                "--container",
                "--token",
                "tok",
                "--url",
                "https://lab.example.org",
                "--",
                "--ip=0.0.0.0",
                "--debug",
            ]
        )
        == 0
    )

    options = captured["options"]

    assert options.target == "https://github.com/x/y"
    assert options.ref == "v1"
    assert options.variables == {"a": "1", "b": "2"}
    assert options.restart == "force"
    assert options.trust == "trusted"
    assert options.open_browser is False
    assert options.fresh is True
    assert options.collections == ["https://example.org/collection.json"]
    assert options.install is True
    assert options.container is True
    assert options.token == "tok"
    assert options.url == "https://lab.example.org"
    assert options.lab_args == ("--ip=0.0.0.0", "--debug")
    assert options.root == tmp_path

    # Container mode is left to detection unless a flag settles it.
    assert cli.main(["launch", "--no-browser"]) == 0
    assert captured["options"].container is None

    assert cli.main(["launch", "--no-browser", "--no-container"]) == 0
    assert captured["options"].container is False


def test_launch_command_reports_a_bad_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)

    # The error is raised before any server starts.
    monkeypatch.setattr(
        subprocess, "Popen", lambda *a, **k: pytest.fail("server started")
    )

    assert cli.main(["launch", "nowhere", "--no-browser"]) == 2
    assert "not a directory or a URL" in capsys.readouterr().err
