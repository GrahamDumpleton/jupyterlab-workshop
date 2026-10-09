import io
import json
import tarfile
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.collection import list_installed
from jupyterlab_workshop.fetch import FetchError
from jupyterlab_workshop.install import (
    apply_update,
    find_updates,
    install_collection,
    remove_installed,
    select_installed,
)
from jupyterlab_workshop.launch import (
    LaunchOptions,
    install_collections,
    launch_overrides,
)
from jupyterlab_workshop.library import (
    LIBRARY_VARIABLE,
    empty_library,
    read_library,
    write_library,
)


def course(root: Path) -> str:
    """The directory the library chose for the course, under installed/collections/."""

    (directory,) = (read_library(root, ".") or {})["directories"].values()

    return f"installed/collections/{directory}"


MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: {name}\ntitle: {title}\nversion: {version}\npages: [pages/01.md]\n"
)


def archive_for(name: str, version: str) -> bytes:
    files = {
        "workshop.yaml": MANIFEST.format(
            name=name, title=name.title(), version=version
        ),
        "pages/01.md": "---\ntitle: Start\n---\n\n# Start\n",
    }
    stream = io.BytesIO()

    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(f"{name}-{version}/{path}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    return stream.getvalue()


def write_index(root: Path, version: str) -> Path:
    index = root / "collection.json"

    index.write_text(
        json.dumps(
            {
                "version": 1,
                "id": "example.org/course",
                "title": "Course",
                "workshops": [
                    {
                        "name": "alpha",
                        "title": "Alpha",
                        "versions": [
                            {
                                "version": version,
                                "source": {"archive": f"https://h/alpha-{version}.tgz"},
                            }
                        ],
                    }
                ],
            }
        )
    )

    return index


def downloader(url: str) -> bytes:
    version = url.rsplit("-", 1)[1].removesuffix(".tgz")

    return archive_for("alpha", version)


def test_library_creates_the_default_library_once_and_stops_with_init_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(LIBRARY_VARIABLE, str(tmp_path / "mine"))

    assert cli.main(["library", "--init-only"]) == 0
    assert read_library(tmp_path / "mine", ".") == {"version": 2}
    assert "created a workshop library" in capsys.readouterr().out

    write_library(tmp_path / "mine", ".", {"version": 2, "catalogs": ["k.json"]})

    assert cli.main(["library", "--init-only"]) == 0
    assert read_library(tmp_path / "mine", ".") == {
        "version": 2,
        "catalogs": ["k.json"],
    }
    assert "created" not in capsys.readouterr().out


def test_library_starts_jupyterlab_with_the_library_as_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(options: LaunchOptions) -> int:
        captured["options"] = options

        return 0

    monkeypatch.setattr("jupyterlab_workshop.launch.run_launch", fake_run)

    target = tmp_path / "lib"

    assert (
        cli.main(
            [
                "library",
                str(target),
                "--no-browser",
                "--collection",
                "https://example.org/c.json",
                "--",
                "--ip=0.0.0.0",
            ]
        )
        == 0
    )

    options = captured["options"]

    assert options.root == target
    assert options.workshops_directory == "."
    assert options.target is None
    assert options.collections == ["https://example.org/c.json"]
    assert options.open_browser is False
    assert options.lab_args == ("--ip=0.0.0.0",)
    assert read_library(target, ".") == {"version": 2}


def test_a_launch_for_a_library_names_the_root_as_the_workshops_directory() -> None:
    options = LaunchOptions(workshops_directory=".")
    panel = launch_overrides({}, options, browse=True)[
        "@jupyterlab-workshop/labextension:panel"
    ]

    assert panel["workshopsDirectory"] == "."
    assert (
        "workshopsDirectory"
        not in launch_overrides({}, LaunchOptions(), True)[
            "@jupyterlab-workshop/labextension:panel"
        ]
    )


def test_install_collections_installs_into_the_library_it_is_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    index = write_index(tmp_path, "1.0")
    write_library(tmp_path, ".", empty_library())

    monkeypatch.setattr("jupyterlab_workshop.fetch.download", downloader)
    install_collections(
        LaunchOptions(root=tmp_path, collections=[str(index)], workshops_directory="."),
        tmp_path,
        report=lambda line: None,
    )

    assert (tmp_path / course(tmp_path) / "alpha").is_dir()


def test_subscribe_unsubscribe_and_list_act_on_a_library(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(LIBRARY_VARIABLE, str(tmp_path / "lib"))
    write_library(tmp_path / "lib", ".", empty_library())

    assert cli.main(["subscribe", "--library", "https://example.org/c.json"]) == 0
    assert cli.main(["subscribe", "--library", "--catalog", "k.json"]) == 0
    assert cli.main(["unsubscribe", "--library", "https://example.org/x.json"]) == 2
    assert cli.main(["subscribe", "--library", "--root", ".", "x"]) == 2

    capsys.readouterr()

    assert cli.main(["list", "--library", "--json"]) == 0

    listing = json.loads(capsys.readouterr().out)

    assert listing["library"] is True
    assert listing["collections"] == ["https://example.org/c.json"]
    assert listing["catalogs"] == ["k.json"]
    assert listing["workshops"] == []

    assert cli.main(["unsubscribe", "--library", "https://example.org/c.json/"]) == 0
    assert read_library(tmp_path / "lib", ".")["collections"] == []


def test_subscribing_outside_a_library_explains_where_subscriptions_are(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["subscribe", "--root", str(tmp_path), "c.json"]) == 2
    assert "kept in the JupyterLab settings" in capsys.readouterr().err

    # Listing works without a library.
    assert cli.main(["list", "--root", str(tmp_path), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["library"] is False


def test_find_and_apply_updates_replace_an_older_install(tmp_path: Path) -> None:
    index = write_index(tmp_path, "1.0")
    write_library(tmp_path, ".", empty_library())
    install_collection(str(index), tmp_path, ".", downloader=downloader)

    records = list_installed(tmp_path, ".", library=True)

    assert find_updates(tmp_path, records) == []

    write_index(tmp_path, "2.0")
    (update,) = find_updates(tmp_path, records)

    assert update.version == "2.0"
    assert apply_update(tmp_path, update, downloader=downloader) == (
        f"{course(tmp_path)}/alpha"
    )

    (record,) = list_installed(tmp_path, ".", library=True)

    assert record["version"] == "2.0"
    assert record["collection"] == "collection.json"


def test_update_asks_before_resetting_progress(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    index = write_index(tmp_path, "1.0")
    write_library(tmp_path, ".", empty_library())
    install_collection(str(index), tmp_path, ".", downloader=downloader)

    assert cli.main(["update", "--root", str(tmp_path), "--directory", "."]) == 0
    assert "up to date" in capsys.readouterr().out

    write_index(tmp_path, "2.0")

    # Not at a terminal, nothing is replaced without --yes.
    assert cli.main(["update", "--root", str(tmp_path), "--directory", "."]) == 2
    assert "Pass --yes" in capsys.readouterr().err


def test_remove_deletes_a_download_and_keeps_a_local_workshop(tmp_path: Path) -> None:
    index = write_index(tmp_path, "1.0")
    write_library(tmp_path, ".", empty_library())
    install_collection(str(index), tmp_path, ".", downloader=downloader)

    mine = tmp_path / "personal" / "workshops" / "alpha"

    (mine / "_workshop").mkdir(parents=True)
    (mine / "workshop.yaml").write_text(
        MANIFEST.format(name="alpha", title="Mine", version="1")
    )
    (mine / "_workshop" / "state.json").write_text("{}")

    records = list_installed(tmp_path, ".", library=True)

    # Two workshops are called alpha, so one is named by its path.
    with pytest.raises(FetchError, match="ambiguous"):
        select_installed(records, ["alpha"])

    installed = f"{course(tmp_path)}/alpha"

    (download,) = select_installed(records, [installed])
    (own,) = select_installed(records, ["personal/workshops/alpha"])

    assert remove_installed(tmp_path, download) == installed
    assert not (tmp_path / installed).exists()

    assert remove_installed(tmp_path, own) == "personal/workshops/alpha/_workshop"
    assert (mine / "workshop.yaml").is_file()
    assert not (mine / "_workshop").exists()

    # Deleting the files takes the owner's own directory as well.
    assert (
        remove_installed(tmp_path, own, delete_files=True) == "personal/workshops/alpha"
    )
    assert not mine.exists()


def test_library_offers_to_upgrade_the_previous_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    library = tmp_path / "old"
    mine = library / "personal" / "alpha"

    mine.mkdir(parents=True)
    (mine / "workshop.yaml").write_text(
        MANIFEST.format(name="alpha", title="Mine", version="1")
    )
    (library / "library.json").write_text('{"version": 1}\n')
    monkeypatch.setenv(LIBRARY_VARIABLE, str(library))

    # Without a terminal to ask at, the library is left as it is and the
    # commands that would write to it say why.
    assert cli.main(["library", "--init-only"]) == 0

    out = capsys.readouterr().out

    assert "personal/ to personal/workshops/ (1 workshop)" in out
    assert "left as it is" in out
    assert read_library(library, ".") == {"version": 1}

    assert cli.main(["list", "--library"]) == 0
    assert "previous layout" in capsys.readouterr().out
    assert cli.main(["subscribe", "--library", "https://example.org/c.json"]) == 2
    assert "previous layout" in capsys.readouterr().err

    # Told yes, it upgrades.
    assert cli.main(["library", "--init-only", "--yes"]) == 0
    assert "upgraded the workshop library" in capsys.readouterr().out
    assert (library / "personal" / "workshops" / "alpha" / "workshop.yaml").is_file()
    assert read_library(library, ".") == {"version": 2}

    assert cli.main(["library", "--init-only"]) == 0
    assert "previous layout" not in capsys.readouterr().out


def test_course_commands_link_list_and_unlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    library = tmp_path / "lib"
    repo = tmp_path / "repo"

    (repo / ".git").mkdir(parents=True)
    write_library(library, ".", empty_library())
    monkeypatch.setenv(LIBRARY_VARIABLE, str(library))

    assert cli.main(["course", "link", str(repo), "--workshops", "examples"]) == 0
    assert "does not ignore _workshop/" in capsys.readouterr().out

    assert cli.main(["course", "list", "--json"]) == 0

    (course,) = json.loads(capsys.readouterr().out)["courses"]

    assert course["name"] == "repo"
    assert course["workshops"] == "examples"
    assert course["linked"] is True

    # The same library named by its root.
    assert (
        cli.main(
            ["course", "unlink", "repo", "--root", str(library), "--directory", "."]
        )
        == 0
    )
    assert repo.is_dir()
    assert read_library(library, ".")["courses"] == []
