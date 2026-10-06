import json
import shutil
from pathlib import Path

import pytest

from jupyterlab_workshop.collection import collection_hash
from jupyterlab_workshop.fetch import (
    FetchError,
    _relative,
    _resolve_inside,
    remove_workshop,
)
from jupyterlab_workshop.library import (
    LIBRARY_VARIABLE,
    LibraryError,
    assign_collection_directory,
    choose_collection_directory,
    default_library,
    empty_library,
    is_library,
    is_link,
    library_file,
    link_project,
    linked_project_path,
    normalize_workshops_directory,
    parse_library,
    project_entry,
    project_workshops,
    read_library,
    recorded_directory,
    repair_links,
    serialize_library,
    slugify_collection_id,
    unlink_project,
    update_library,
    write_library,
)

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "packages/core/src/__tests__/library-vectors.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize(("collection_id", "slug"), VECTORS["slugs"])
def test_slugs_agree_with_the_browser(collection_id: str, slug: str | None) -> None:
    assert slugify_collection_id(collection_id) == slug


@pytest.mark.parametrize(("location", "digest"), VECTORS["hashes"])
def test_hashes_agree_with_the_browser(location: str, digest: str) -> None:
    assert collection_hash(location) == digest


def test_choose_collection_directory_falls_back_and_suffixes_a_clash() -> None:
    location = "https://example.org/course/collection.json"

    assert choose_collection_directory(location, None, []) == "858442f"
    assert choose_collection_directory(location, "CON", []) == "858442f"
    assert choose_collection_directory(location, "example.org/c", []) == (
        "example.org-c"
    )
    assert choose_collection_directory(
        location, "example.org/c", ["Example.org-c"]
    ) == ("example.org-c-858442f")


def test_assign_collection_directory_records_once_and_keeps_it() -> None:
    directory, library = assign_collection_directory(
        empty_library(), "https://Example.org/c.json", "example.org/c"
    )

    assert directory == "example.org-c"
    assert library["directories"] == {"https://Example.org/c.json": "example.org-c"}

    # A later install keeps the directory, even with a different id.
    again, unchanged = assign_collection_directory(
        library, "https://example.org/c.json/", "another/id"
    )

    assert again == "example.org-c"
    assert unchanged == library
    assert recorded_directory(library, "elsewhere.json") is None


def test_parse_library_accepts_what_the_schema_does_and_refuses_the_rest() -> None:
    assert parse_library({"version": 1}) == {"version": 1}
    assert parse_library(
        {
            "version": 1,
            "collections": [],
            "directories": {"c.json": "c"},
            "projects": [{"name": "repo", "workshops": "examples"}],
        }
    ) == {
        "version": 1,
        "collections": [],
        "directories": {"c.json": "c"},
        "projects": [{"name": "repo", "workshops": "examples"}],
    }

    for bad, message in [
        ([], "must contain an object"),
        ({"version": 2}, "unsupported version"),
        ({"version": 1, "colour": "red"}, "unknown keys colour"),
        ({"version": 1, "collections": [""]}, "list of locations"),
        ({"version": 1, "directories": {"a": "../x"}}, "lower case name"),
        ({"version": 1, "projects": [{"name": ".hidden"}]}, 'valid "name"'),
        ({"version": 1, "projects": [{"name": "p", "path": "x"}]}, "unknown keys"),
        ({"version": 1, "projects": [{"name": "p", "target": ""}]}, '"target"'),
    ]:
        with pytest.raises(LibraryError, match=message):
            parse_library(bad)


def test_serialize_library_matches_the_browser_layout() -> None:
    text = serialize_library(
        {"projects": [{"name": "p"}], "collections": ["ü.json"], "version": 1}
    )

    assert text == (
        '{\n  "version": 1,\n  "collections": [\n    "ü.json"\n  ],\n'
        '  "projects": [\n    {\n      "name": "p"\n    }\n  ]\n}\n'
    )


def test_a_directory_is_a_library_only_with_its_registry(tmp_path: Path) -> None:
    assert not is_library(tmp_path, "workshops")
    assert read_library(tmp_path, "workshops") is None

    write_library(tmp_path, "workshops", {"version": 1, "collections": ["c.json"]})

    assert is_library(tmp_path, "workshops")
    assert read_library(tmp_path, "workshops") == {
        "version": 1,
        "collections": ["c.json"],
    }

    # The root itself can be the library, however it is spelled.
    write_library(tmp_path, ".", empty_library())

    assert library_file(tmp_path, "") == tmp_path / "library.json"
    assert is_library(tmp_path, "./")

    # No temporary file is left beside it.
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "library.json",
        "workshops",
    ]


def test_write_library_refuses_an_invalid_registry_and_keeps_the_old_one(
    tmp_path: Path,
) -> None:
    write_library(tmp_path, "w", {"version": 1, "catalogs": ["k.json"]})

    with pytest.raises(LibraryError):
        write_library(tmp_path, "w", {"version": 1, "catalogs": [""]})

    assert read_library(tmp_path, "w") == {"version": 1, "catalogs": ["k.json"]}


def test_read_library_reports_a_broken_file(tmp_path: Path) -> None:
    (tmp_path / "library.json").write_text("{not json")

    with pytest.raises(LibraryError, match="Unable to read"):
        read_library(tmp_path, ".")


def test_update_library_rereads_before_writing(tmp_path: Path) -> None:
    with pytest.raises(LibraryError, match="not a workshop library"):
        update_library(tmp_path, ".", lambda library: library)

    write_library(tmp_path, ".", {"version": 1, "collections": ["a.json"]})

    # Something else adds a catalog after this caller last looked.
    write_library(
        tmp_path, ".", {"version": 1, "collections": ["a.json"], "catalogs": ["k"]}
    )

    updated = update_library(
        tmp_path,
        ".",
        lambda library: {**library, "collections": [*library["collections"], "b"]},
    )

    assert updated == {
        "version": 1,
        "collections": ["a.json", "b"],
        "catalogs": ["k"],
    }
    assert read_library(tmp_path, ".") == updated


def test_normalize_workshops_directory_treats_every_root_alike() -> None:
    for root in ["", ".", "./", " ./ ", "/", ".\\"]:
        assert normalize_workshops_directory(root) == ""

    assert normalize_workshops_directory("./workshops/") == "workshops"


def test_default_library_prefers_the_environment(tmp_path: Path) -> None:
    assert default_library({}, home=tmp_path) == tmp_path / "Workshops"
    assert default_library({LIBRARY_VARIABLE: "  "}, home=tmp_path) == (
        tmp_path / "Workshops"
    )
    assert default_library({LIBRARY_VARIABLE: str(tmp_path / "mine")}) == (
        tmp_path / "mine"
    )
    assert default_library({LIBRARY_VARIABLE: "~/lib"}) == Path("~/lib").expanduser()


def test_projects_default_their_workshops_directory() -> None:
    library = parse_library(
        {"version": 1, "projects": [{"name": "repo", "workshops": "examples"}]}
    )

    assert project_workshops(project_entry(library, "repo")) == "examples"
    assert project_entry(library, "other") == {"name": "other"}
    assert project_workshops({"name": "other"}) == "workshops"


def _linked_library(tmp_path: Path) -> tuple[Path, Path]:
    """A library at ``root/lib`` and a repository kept outside the root."""

    root = tmp_path / "root"
    library = root / "lib"
    repo = tmp_path / "outside" / "my-repo"

    (repo / "workshops" / "draft").mkdir(parents=True)
    (repo / "workshops" / "draft" / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: draft\ntitle: Draft\n"
        "pages: [pages/01.md]\n"
    )
    (repo / "notes.txt").write_text("keep me\n")
    write_library(library, "", empty_library())

    return root, repo


def test_link_project_links_and_records_the_target(tmp_path: Path) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"

    entry = link_project(library, repo, workshops="workshops")

    assert entry == {
        "name": "my-repo",
        "target": repo.resolve().as_posix(),
        "workshops": "workshops",
    }
    assert is_link(library / "projects" / "my-repo")
    assert (library / "projects" / "my-repo" / "notes.txt").read_text() == "keep me\n"
    assert read_library(library, "")["projects"] == [entry]

    # Linking again is harmless; linking another directory under the
    # same name is refused.
    link_project(library, repo, workshops="workshops")

    other = tmp_path / "other"
    other.mkdir()

    with pytest.raises(LibraryError, match="already links"):
        link_project(library, other, name="my-repo")

    with pytest.raises(LibraryError, match="not a directory"):
        link_project(library, tmp_path / "missing")

    with pytest.raises(LibraryError, match="not a usable project name"):
        link_project(library, other, name="../up")


def test_unlink_project_removes_only_the_link(tmp_path: Path) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"

    link_project(library, repo)
    unlink_project(library, "my-repo")

    assert not (library / "projects" / "my-repo").exists()
    assert not is_link(library / "projects" / "my-repo")
    assert (repo / "notes.txt").read_text() == "keep me\n"
    assert read_library(library, "")["projects"] == []

    # A cloned project is not a link and is never removed by unlinking.
    (library / "projects" / "cloned").mkdir()

    with pytest.raises(LibraryError, match="not a linked project"):
        unlink_project(library, "cloned")


def test_unlink_and_repair_cope_with_a_target_that_has_gone(tmp_path: Path) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"
    link = library / "projects" / "my-repo"

    link_project(library, repo)

    # The link went but its target is still there: it comes back.
    link.unlink()

    assert repair_links(library) == ["my-repo"]
    assert is_link(link)

    # The target went: the link dangles, nothing is relinked, and
    # unlinking still cleans up.
    shutil.rmtree(repo)

    assert repair_links(library) == []

    unlink_project(library, "my-repo")

    assert not is_link(link)
    assert read_library(library, "")["projects"] == []


def test_linked_project_path_lets_through_only_a_registered_link(
    tmp_path: Path,
) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"
    parts = ["lib", "projects", "my-repo", "workshops", "draft"]

    link_project(library, repo)

    resolved_root = root.resolve()
    linked = linked_project_path(resolved_root, parts)

    assert linked == resolved_root.joinpath(*parts)
    assert _resolve_inside(root, "lib/projects/my-repo/workshops/draft") == linked
    assert _relative(root, linked) == "lib/projects/my-repo/workshops/draft"

    # A link the registry does not list, or one pointing somewhere other
    # than its recorded target, is refused.
    stray = tmp_path / "stray"
    stray.mkdir()
    (library / "projects" / "unlisted").symlink_to(stray, target_is_directory=True)

    assert linked_project_path(resolved_root, ["lib", "projects", "unlisted"]) is None

    with pytest.raises(FetchError, match="outside"):
        _resolve_inside(root, "lib/projects/unlisted")

    (library / "projects" / "my-repo").unlink()
    (library / "projects" / "my-repo").symlink_to(stray, target_is_directory=True)

    assert linked_project_path(resolved_root, parts[:3]) is None


def test_remove_workshop_refuses_a_workshop_in_a_linked_project(
    tmp_path: Path,
) -> None:
    root, repo = _linked_library(tmp_path)

    link_project(root / "lib", repo)

    with pytest.raises(FetchError, match="linked project"):
        remove_workshop(root, "lib/projects/my-repo/workshops/draft")

    assert (repo / "workshops" / "draft" / "workshop.yaml").is_file()
