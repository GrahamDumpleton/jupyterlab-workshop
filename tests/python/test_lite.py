import json
import urllib.request
from pathlib import Path

import pytest

from jupyterlab_workshop import __version__, cli
from jupyterlab_workshop.lite import (
    PANEL_PLUGIN,
    LiteBuildOptions,
    LiteError,
    build_command,
    build_lite_site,
    missing_requirements,
    patch_site_config,
    serve_directory,
    settings_overrides,
    settings_schema,
    stage_catalogs,
    stage_collections,
    stage_contents,
    stage_welcome,
    uses_terminal,
    workshop_name,
)

needs_lite = pytest.mark.skipif(
    bool(missing_requirements(terminal=False)),
    reason="needs jupyterlite-core and the Pyodide kernel (the lite extra)",
)


def _workshop(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True)
    (directory / "workshop.yaml").write_text(
        f"apiVersion: jupyterlab-workshop/v1alpha1\nname: {name}\n"
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


def test_uses_terminal_goes_by_the_capability_and_the_headless_shell(
    tmp_path: Path,
) -> None:
    def workshop(name: str, capabilities: str, page: str) -> Path:
        directory = tmp_path / name
        (directory / "pages").mkdir(parents=True)
        (directory / "workshop.yaml").write_text(
            f"name: {name}\ncapabilities: {capabilities}\npages: [pages/01.md]\n"
        )
        (directory / "pages" / "01.md").write_text(page)

        return directory

    notebook = "```{cell-run}\n:path: a.ipynb\n:cell: one\n```\n"

    # A notebook workshop has nothing for a shell to run.
    plain = workshop("notebook", "[write-files, kernel-exec]", notebook)

    assert not uses_terminal(plain)
    assert uses_terminal(workshop("declared", "[terminal]", notebook))

    # A capture and a shell check run in the terminal extension's shell
    # with no terminal shown, under kernel-exec alone.
    capture = "```{execute-capture}\n:capture: out\nls\n```\n"
    check = "```{verify}\n:substrate: shell\ntest -f a.txt\n```\n"

    assert uses_terminal(workshop("capture", "[kernel-exec]", capture))
    assert uses_terminal(workshop("check", "[kernel-exec]", check))

    # A manifest that cannot be read is given the benefit of the doubt.
    assert uses_terminal(tmp_path / "missing")


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
    settings = settings_overrides(options, ["solo"])[PANEL_PLUGIN]

    assert settings["defaultWorkshop"] == "solo"
    assert settings["workshopsDirectory"] == ""
    assert "trustPolicy" not in settings

    # A workshop that opens on start leaves the browser alone.
    assert "browseOnStart" not in settings

    # With nothing to open, the site starts in the workshop browser.
    two = settings_overrides(options, ["a", "b"])[PANEL_PLUGIN]

    assert two["defaultWorkshop"] == ""
    assert two["browseOnStart"] is True

    chosen = LiteBuildOptions(
        workshops=(),
        output=tmp_path / "out",
        default_workshop="b",
        trust="trusted",
        collections=("https://example.org/collection.json",),
        catalogs=("https://example.org/catalog.json",),
    )
    settings = settings_overrides(chosen, ["a", "b"])[PANEL_PLUGIN]

    assert settings["defaultWorkshop"] == "b"
    assert settings["trustPolicy"] == {"forcedLevel": "trusted"}
    assert settings["collections"] == ["https://example.org/collection.json"]
    assert settings["catalogs"] == ["https://example.org/catalog.json"]

    with pytest.raises(LiteError, match="no workshop named missing"):
        settings_overrides(
            LiteBuildOptions(workshops=(), output=tmp_path, default_workshop="missing"),
            ["a"],
        )


def test_stage_collections_carries_local_indexes_in_the_site(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()

    source = tmp_path / "repo"
    (source / "art").mkdir(parents=True)
    (source / "art" / "icon.svg").write_text("<svg/>")
    (source / "collection.json").write_text(
        json.dumps({"version": 1, "icon": "art/icon.svg", "workshops": []})
    )

    # A URL is left alone; a directory stands for the index it holds, and
    # the icon it names keeps its place beside the index.
    url = "https://example.org/collection.json"

    assert stage_collections([url, str(source)], staging) == [url, "collection.json"]
    assert (staging / "collection.json").is_file()
    assert (staging / "art" / "icon.svg").is_file()

    with pytest.raises(LiteError, match="would overwrite collection.json"):
        stage_collections([str(source / "collection.json")], staging)

    with pytest.raises(LiteError, match="is not a URL or a collection.json file"):
        stage_collections([str(tmp_path / "missing.json")], staging)

    escaping = tmp_path / "escaping.json"
    escaping.write_text(json.dumps({"icon": "../icon.svg"}))

    with pytest.raises(LiteError, match="outside the site's contents"):
        stage_collections([str(escaping)], staging)

    broken = tmp_path / "broken.json"
    broken.write_text("{")

    with pytest.raises(LiteError, match="cannot be read as JSON"):
        stage_collections([str(broken)], staging)


def test_stage_catalogs_carries_what_a_catalog_names_beside_it(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()

    # One repository: a catalog at the root and a collection below it,
    # sharing an icon, beside a collection published somewhere else.
    repo = tmp_path / "repo"
    (repo / "python").mkdir(parents=True)
    (repo / "logo.svg").write_text("<svg/>")
    (repo / "python" / "collection.json").write_text(
        json.dumps({"version": 1, "icon": "../logo.svg", "workshops": []})
    )
    (repo / "other").mkdir()
    (repo / "other" / "mark.svg").write_text("<svg/>")
    (repo / "other" / "index.json").write_text(json.dumps({"icon": "mark.svg"}))
    (repo / "catalog.json").write_text(
        json.dumps(
            {
                "version": 1,
                "icon": "logo.svg",
                "collections": [
                    {"url": "python/collection.json", "icon": "logo.svg"},
                    {
                        "url": "https://example.org/collection.json",
                        "icon": "other/mark.svg",
                    },
                ],
            }
        )
    )

    carried: dict[Path, str] = {}
    url = "https://example.org/catalog.json"

    assert stage_catalogs([url, str(repo)], staging, carried) == [url, "catalog.json"]
    assert (staging / "python" / "collection.json").is_file()
    assert sorted(item.name for item in staging.iterdir()) == [
        "catalog.json",
        "logo.svg",
        "other",
        "python",
    ]

    # The same collection given on its own is subscribed to where the
    # catalog put it, so the browser sees the catalog's entry as subscribed.
    chosen = stage_collections([str(repo / "python")], staging, carried)

    assert chosen == ["python/collection.json"]
    assert not (staging / "collection.json").exists()

    # An index the catalog does not name goes to the root, and its icon
    # with it, though the catalog carried that icon somewhere else.
    assert stage_collections(
        [str(repo / "other" / "index.json")], staging, carried
    ) == ["index.json"]
    assert (staging / "mark.svg").is_file()
    assert (staging / "other" / "mark.svg").is_file()

    # An entry that climbs out of the catalog's directory has no place.
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "catalog.json").write_text(
        json.dumps({"collections": [{"url": "../repo/python/collection.json"}]})
    )

    with pytest.raises(LiteError, match="outside the site's contents"):
        stage_catalogs([str(outside / "catalog.json")], tmp_path / "s2")

    with pytest.raises(LiteError, match="is not a URL or a catalog.json file"):
        stage_catalogs([str(tmp_path / "missing")], staging)


def test_staging_never_puts_a_file_inside_a_workshop(tmp_path: Path) -> None:
    staging = tmp_path / "staging"

    stage_contents([_workshop(tmp_path / "w", "python")], staging)

    repo = tmp_path / "repo"
    (repo / "python").mkdir(parents=True)
    (repo / "python" / "collection.json").write_text("{}")
    (repo / "catalog.json").write_text(
        json.dumps({"collections": [{"url": "python/collection.json"}]})
    )

    with pytest.raises(LiteError, match="inside the workshop python"):
        stage_catalogs([str(repo)], staging)


def test_stage_welcome_carries_the_message_in_the_site(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()

    assert stage_welcome(None, staging) == ""

    message = tmp_path / "lite" / "welcome.md"
    message.parent.mkdir()
    message.write_text("# Hello\n")

    assert stage_welcome(message, staging) == "welcome.md"
    assert (staging / "welcome.md").read_text() == "# Hello\n"

    with pytest.raises(LiteError, match="does not exist"):
        stage_welcome(tmp_path / "missing.md", staging)


def test_settings_overrides_lay_the_build_over_a_settings_file(
    tmp_path: Path,
) -> None:
    analytics = {
        "sink": "https://analytics.example.org/events",
        "token": "public",
        "labels": {"deployment": "lite"},
    }
    file = tmp_path / "settings.json"
    file.write_text(
        json.dumps(
            {
                PANEL_PLUGIN: {
                    "analytics": analytics,
                    "workshopsDirectory": "workshops",
                    "collections": ["https://example.org/collection.json"],
                    "trustPolicy": {"trustedSources": ["git:https://example.org/"]},
                    "disabledFeatures": ["open-url"],
                },
                "@jupyterlab/apputils-extension:themes": {"theme": "JupyterLab Dark"},
            }
        )
    )

    options = LiteBuildOptions(
        workshops=(),
        output=tmp_path / "out",
        trust="trusted",
        settings=file,
    )
    overrides = settings_overrides(
        options, ["a", "b"], ["collection.json"], "welcome.md"
    )
    settings = overrides[PANEL_PLUGIN]

    # What the file says is kept, and other plugins' settings with it.
    assert settings["analytics"] == analytics
    assert settings["disabledFeatures"] == ["open-url"]
    assert overrides["@jupyterlab/apputils-extension:themes"] == {
        "theme": "JupyterLab Dark"
    }

    # What the build decides wins, and its lists add to the file's.
    assert settings["workshopsDirectory"] == ""
    assert settings["collections"] == [
        "https://example.org/collection.json",
        "collection.json",
    ]
    assert settings["trustPolicy"] == {
        "trustedSources": ["git:https://example.org/"],
        "forcedLevel": "trusted",
    }
    assert settings["welcome"] == "welcome.md"
    assert settings["browseOnStart"] is True

    # The file can keep a site at the launcher, or name the workshop to open.
    file.write_text(json.dumps({PANEL_PLUGIN: {"browseOnStart": False}}))

    assert settings_overrides(options, ["a", "b"])[PANEL_PLUGIN]["browseOnStart"] is (
        False
    )

    file.write_text(json.dumps({PANEL_PLUGIN: {"defaultWorkshop": "b"}}))
    named = settings_overrides(options, ["a", "b"])[PANEL_PLUGIN]

    assert named["defaultWorkshop"] == "b"
    assert "browseOnStart" not in named


def test_settings_file_is_held_to_its_form_and_the_schema(tmp_path: Path) -> None:
    file = tmp_path / "settings.json"
    options = LiteBuildOptions(workshops=(), output=tmp_path / "out", settings=file)

    with pytest.raises(LiteError, match="cannot be read as JSON"):
        settings_overrides(options, ["a"])

    # Settings written without the plugin's id around them.
    file.write_text(json.dumps({"analytics": {"sink": "https://example.org"}}))

    with pytest.raises(LiteError, match="under its id"):
        settings_overrides(options, ["a"])

    if settings_schema() is None:
        pytest.skip("the extension's settings schema is not installed")

    file.write_text(json.dumps({PANEL_PLUGIN: {"analytics": {"sinc": "x"}}}))

    with pytest.raises(LiteError, match="analytics: .*sinc"):
        settings_overrides(options, ["a"])

    file.write_text(json.dumps({PANEL_PLUGIN: {"browseOnStrat": True}}))

    with pytest.raises(LiteError, match="browseOnStrat"):
        settings_overrides(options, ["a"])


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

    index = tmp_path / "collection.json"
    index.write_text(json.dumps({"version": 1, "workshops": []}))
    message = tmp_path / "welcome.md"
    message.write_text("# Hello\n")

    result = build_lite_site(
        LiteBuildOptions(
            workshops=(workshop,),
            output=tmp_path / "site",
            lite_dir=lite_dir,
            trust="trusted",
            terminal=False,
            collections=(str(index),),
            welcome=message,
        ),
        runner=runner,
    )

    assert result.workshops == ["demo"]
    assert seen[0][1] == lite_dir.resolve()
    assert (lite_dir / "contents" / "demo" / "workshop.yaml").exists()

    config = json.loads((lite_dir / "jupyter-lite.json").read_text())
    overrides = json.loads((lite_dir / "overrides.json").read_text())

    assert config["jupyter-config-data"]["exposeAppInBrowser"] is True
    assert overrides[PANEL_PLUGIN]["defaultWorkshop"] == "demo"
    assert overrides[PANEL_PLUGIN]["collections"] == ["collection.json"]
    assert overrides[PANEL_PLUGIN]["welcome"] == "welcome.md"
    assert (lite_dir / "contents" / "collection.json").is_file()
    assert (lite_dir / "contents" / "welcome.md").is_file()

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
        "jupyterlabWorkshopVersion": __version__,
        "terminalsAvailable": True,
    }
    assert lab["jupyter-config-data"]["exposeAppInBrowser"] is True


def test_patch_site_config_without_terminal_leaves_terminals_off(
    tmp_path: Path,
) -> None:
    (tmp_path / "jupyter-lite.json").write_text("{}")

    patch_site_config(tmp_path, terminal=False)

    root = json.loads((tmp_path / "jupyter-lite.json").read_text())

    assert root["jupyter-config-data"] == {
        "exposeAppInBrowser": True,
        "jupyterlabWorkshopVersion": __version__,
    }


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
        [
            "lite",
            "a",
            "b",
            "--out",
            "site",
            "--no-terminal",
            "--collection",
            "u",
            "--catalog",
            "c",
            "--settings",
            "settings.json",
            "--welcome",
            "welcome.md",
        ]
    )

    assert args.func is cli.command_lite
    assert args.workshops == [Path("a"), Path("b")]
    assert args.terminal is False
    assert args.collection == ["u"]
    assert args.catalog == ["c"]
    assert args.settings == Path("settings.json")
    assert args.welcome == Path("welcome.md")

    test = parser.parse_args(["test", "a", "--lite", "--lite-dir", "cache"])

    assert test.lite is True
    assert test.lite_dir == Path("cache")
