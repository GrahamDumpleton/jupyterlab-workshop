import json
import urllib.request
from pathlib import Path

import pytest

from educates_jupyterlab_workshop import cli
from educates_jupyterlab_workshop.lite import (
    LiteBuildOptions,
    LiteError,
    build_command,
    build_lite_site,
    missing_requirements,
    patch_site_config,
    serve_directory,
    settings_overrides,
    stage_contents,
    workshop_name,
)

needs_lite = pytest.mark.skipif(
    bool(missing_requirements(terminal=False)),
    reason="needs jupyterlite-core and the Pyodide kernel (the lite extra)",
)


def _workshop(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True)
    (directory / "workshop.yaml").write_text(
        f"apiVersion: workshop.educates.dev/v1alpha1\nname: {name}\n"
        f"title: {name.title()}\npages: [pages/01.md]\n"
    )
    (directory / "pages").mkdir()
    (directory / "pages" / "01.md").write_text("---\ntitle: One\n---\n# One\n")
    (directory / "_workshop").mkdir()
    (directory / "_workshop" / "state.json").write_text("{}")

    return directory


def test_workshop_name_comes_from_the_manifest(tmp_path: Path) -> None:
    assert workshop_name(_workshop(tmp_path / "dir", "named")) == "named"

    with pytest.raises(LiteError, match="has no workshop.yaml"):
        workshop_name(tmp_path)


def test_stage_contents_copies_workshops_without_progress(tmp_path: Path) -> None:
    first = _workshop(tmp_path / "a", "first")
    second = _workshop(tmp_path / "b", "second")
    staging = tmp_path / "staging"

    assert stage_contents([first, second], staging) == ["first", "second"]
    assert (staging / "first" / "pages" / "01.md").exists()
    assert not (staging / "first" / "_workshop").exists()

    with pytest.raises(LiteError, match="Two workshops are named"):
        stage_contents([first, _workshop(tmp_path / "c", "first")], tmp_path / "s2")


def test_settings_overrides_open_the_only_workshop_by_default(tmp_path: Path) -> None:
    options = LiteBuildOptions(workshops=(), output=tmp_path / "out")
    settings = settings_overrides(options, ["solo"])[
        "@educates/jupyterlab-workshop:panel"
    ]

    assert settings["defaultWorkshop"] == "solo"
    assert settings["workshopsDirectory"] == ""
    assert "trustPolicy" not in settings

    two = settings_overrides(options, ["a", "b"])["@educates/jupyterlab-workshop:panel"]

    assert two["defaultWorkshop"] == ""

    chosen = LiteBuildOptions(
        workshops=(),
        output=tmp_path / "out",
        default_workshop="b",
        trust="trusted",
        registries=("https://example.org/index.json",),
    )
    settings = settings_overrides(chosen, ["a", "b"])[
        "@educates/jupyterlab-workshop:panel"
    ]

    assert settings["defaultWorkshop"] == "b"
    assert settings["trustPolicy"] == {"forcedLevel": "trusted"}
    assert settings["registries"] == ["https://example.org/index.json"]

    with pytest.raises(LiteError, match="no workshop named missing"):
        settings_overrides(
            LiteBuildOptions(workshops=(), output=tmp_path, default_workshop="missing"),
            ["a"],
        )


def test_build_command_reflects_the_options(tmp_path: Path) -> None:
    options = LiteBuildOptions(
        workshops=(), output=tmp_path / "site", terminal=False, force=False
    )
    command = build_command(
        options, tmp_path / "lite", tmp_path / "contents", tmp_path / "o.json"
    )

    assert command[1:4] == ["-m", "jupyterlite_core", "build"]
    assert f"--output-dir={tmp_path / 'site'}" in command
    assert "--disable-addons=jupyterlite-terminal" in command
    assert "--force" not in command

    forced = build_command(
        LiteBuildOptions(workshops=(), output=tmp_path / "site"),
        tmp_path / "lite",
        tmp_path / "contents",
        tmp_path / "o.json",
    )

    assert "--force" in forced
    assert not any(item.startswith("--disable-addons") for item in forced)


@needs_lite
def test_build_lite_site_stages_and_configures_before_building(tmp_path: Path) -> None:
    workshop = _workshop(tmp_path / "demo", "demo")
    lite_dir = tmp_path / "cache"
    seen: list[tuple[list[str], Path]] = []

    def runner(command, cwd):  # type: ignore[no-untyped-def]
        seen.append((list(command), cwd))

        return 0

    result = build_lite_site(
        LiteBuildOptions(
            workshops=(workshop,),
            output=tmp_path / "site",
            lite_dir=lite_dir,
            trust="trusted",
            terminal=False,
        ),
        runner=runner,
    )

    assert result.workshops == ["demo"]
    assert seen[0][1] == lite_dir.resolve()
    assert (lite_dir / "contents" / "demo" / "workshop.yaml").exists()

    config = json.loads((lite_dir / "jupyter-lite.json").read_text())
    overrides = json.loads((lite_dir / "overrides.json").read_text())

    assert config["jupyter-config-data"]["exposeAppInBrowser"] is True
    assert overrides["@educates/jupyterlab-workshop:panel"]["defaultWorkshop"] == "demo"

    def failing(command, cwd):  # type: ignore[no-untyped-def]
        return 3

    with pytest.raises(LiteError, match="exit code 3"):
        build_lite_site(
            LiteBuildOptions(
                workshops=(workshop,),
                output=tmp_path / "site",
                lite_dir=lite_dir,
                terminal=False,
            ),
            runner=failing,
        )


def test_patch_site_config_applies_the_settings(tmp_path: Path) -> None:
    (tmp_path / "lab").mkdir()
    (tmp_path / "jupyter-lite.json").write_text(
        json.dumps({"jupyter-config-data": {"appName": "JupyterLite"}})
    )
    (tmp_path / "lab" / "jupyter-lite.json").write_text("{}")

    patch_site_config(tmp_path)

    root = json.loads((tmp_path / "jupyter-lite.json").read_text())
    lab = json.loads((tmp_path / "lab" / "jupyter-lite.json").read_text())

    assert root["jupyter-config-data"] == {
        "appName": "JupyterLite",
        "exposeAppInBrowser": True,
    }
    assert lab["jupyter-config-data"]["exposeAppInBrowser"] is True


def test_serve_directory_serves_files(tmp_path: Path) -> None:
    (tmp_path / "site").mkdir()
    (tmp_path / "site" / "index.html").write_text("<p>hello</p>")

    server, port = serve_directory(tmp_path)

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/site/index.html") as r:
            assert r.read() == b"<p>hello</p>"
    finally:
        server.shutdown()


def test_cli_parses_lite_options(tmp_path: Path) -> None:
    parser = cli.build_parser()
    args = parser.parse_args(
        ["lite", "a", "b", "--out", "site", "--no-terminal", "--registry", "u"]
    )

    assert args.func is cli.command_lite
    assert args.workshops == [Path("a"), Path("b")]
    assert args.terminal is False
    assert args.registry == ["u"]

    test = parser.parse_args(["test", "a", "--lite", "--lite-dir", "cache"])

    assert test.lite is True
    assert test.lite_dir == Path("cache")
