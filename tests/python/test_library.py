import json
import shutil
from pathlib import Path
from typing import Any

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
    catalog_collections,
    choose_collection_directory,
    collection_title,
    collection_workshops,
    course_entry,
    course_of_path,
    course_path,
    course_workshops,
    default_library,
    download_key,
    empty_library,
    is_library,
    is_link,
    is_own_library_path,
    library_file,
    link_course,
    linked_course_path,
    may_replace_download,
    needs_upgrade,
    normalize_workshops_directory,
    parse_library,
    plan_upgrade,
    read_library,
    recorded_directory,
    repair_links,
    serialize_library,
    slugify_collection_id,
    standalone_directory,
    unlink_course,
    update_library,
    upgrade_library,
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


@pytest.mark.parametrize(("directory", "path", "own"), VECTORS["ownPaths"])
def test_own_paths_agree_with_the_browser(directory: str, path: str, own: bool) -> None:
    assert is_own_library_path(directory, path) is own


@pytest.mark.parametrize(("directory", "path", "course"), VECTORS["courseOf"])
def test_course_of_path_agrees_with_the_browser(
    directory: str, path: str, course: list[str] | None
) -> None:
    assert course_of_path(directory, path) == (
        tuple(course) if course is not None else None
    )


@pytest.mark.parametrize(("location", "digest"), VECTORS["hashes"])
def test_hashes_agree_with_the_browser(location: str, digest: str) -> None:
    assert collection_hash(location) == digest


@pytest.mark.parametrize(
    ("location", "collection_id", "directory"), VECTORS["collectionDirectories"]
)
def test_collection_directories_agree_with_the_browser(
    location: str, collection_id: str | None, directory: str
) -> None:
    assert choose_collection_directory(location, collection_id) == directory


@pytest.mark.parametrize(("kind", "url", "subdir", "key"), VECTORS["downloadKeys"])
def test_download_keys_agree_with_the_browser(
    kind: str, url: str, subdir: str, key: str
) -> None:
    assert download_key(kind, url, subdir) == key


@pytest.mark.parametrize(
    ("name", "kind", "url", "subdir", "directory"), VECTORS["standalone"]
)
def test_standalone_directories_agree_with_the_browser(
    name: str, kind: str, url: str, subdir: str, directory: str
) -> None:
    assert standalone_directory(name, kind, url, subdir) == directory


@pytest.mark.parametrize(("base", "target", "resolved"), VECTORS["coursePaths"])
def test_course_paths_agree_with_the_browser(
    base: str, target: str, resolved: str | None
) -> None:
    assert course_path(base, target) == resolved


def test_a_course_index_is_read_for_what_is_inside_the_course() -> None:
    catalog = {
        "collections": [
            {"url": "collections/a/collection.json", "title": "Part A"},
            {"url": "https://example.org/collection.json", "title": "Elsewhere"},
            {"url": "collections/b/collection.json"},
            {"title": "No URL"},
        ]
    }

    assert catalog_collections(catalog, "catalog.json") == [
        {"path": "collections/a/collection.json", "title": "Part A"},
        {
            "path": "collections/b/collection.json",
            "title": "collections/b/collection.json",
        },
    ]
    assert catalog_collections("nonsense", "catalog.json") == []

    def source(subdir: str | None = None) -> dict[str, Any]:
        return {
            "versions": [
                {"source": {"git": "https://github.com/o/r", "subdir": subdir}}
            ]
        }

    collection = {
        "title": "Part A",
        "workshops": [
            source("workshops/one"),
            source("/workshops/two/"),
            source("workshops/one"),
            source(),
            source("../outside"),
            {"versions": [{"source": {"archive": "https://x/w.zip"}}]},
            {"versions": []},
        ],
    }

    assert collection_workshops(collection) == ["workshops/one", "workshops/two", ""]
    assert collection_title(collection, "fallback") == "Part A"
    assert collection_title({}, "fallback") == "fallback"


def test_only_a_download_of_the_same_workshop_may_be_replaced() -> None:
    record = {
        "source": {
            "kind": "git",
            "url": "https://GitHub.com/o/r.git",
            "ref": "v1",
            "subdir": "w",
        }
    }

    # The same source at another revision is the same workshop.
    assert may_replace_download(record, "git", "https://github.com/o/r", "w")
    assert not may_replace_download(record, "git", "https://github.com/o/r", "x")

    # A collection's update may come from another URL.
    installed = {**record, "collection": "https://example.org/collection.json"}
    update = ("archive", "https://example.org/w-2.zip")

    assert may_replace_download(
        installed, *update, collection="https://EXAMPLE.org/collection.json/"
    )
    assert not may_replace_download(installed, *update)

    # A local workshop, or no record at all, is never replaced.
    local = {"source": {"kind": "local", "url": "."}}

    assert not may_replace_download(local, "git", "https://github.com/o/r")
    assert not may_replace_download(None, "git", "https://github.com/o/r")


def test_assign_collection_directory_records_once_and_keeps_it() -> None:
    directory, library = assign_collection_directory(
        empty_library(), "https://Example.org/c.json", "example.org/c"
    )

    assert directory == f"example.org-c-{collection_hash('https://Example.org/c.json')}"
    assert library["directories"] == {"https://Example.org/c.json": directory}

    # A later install keeps the directory, even with a different id.
    again, unchanged = assign_collection_directory(
        library, "https://example.org/c.json/", "another/id"
    )

    assert again == directory
    assert unchanged == library
    assert recorded_directory(library, "elsewhere.json") is None


def test_parse_library_accepts_what_the_schema_does_and_refuses_the_rest() -> None:
    assert parse_library({"version": 2}) == {"version": 2}
    assert parse_library(
        {
            "version": 2,
            "collections": [],
            "directories": {"c.json": "c"},
            "courses": [{"name": "repo", "workshops": "examples"}],
        }
    ) == {
        "version": 2,
        "collections": [],
        "directories": {"c.json": "c"},
        "courses": [{"name": "repo", "workshops": "examples"}],
    }

    for bad, message in [
        ([], "must contain an object"),
        ({"version": 3}, "unsupported version"),
        ({"version": 2, "colour": "red"}, "unknown keys colour"),
        ({"version": 2, "projects": []}, "unknown keys projects"),
        ({"version": 1, "courses": []}, "unknown keys courses"),
        ({"version": 2, "collections": [""]}, "list of locations"),
        ({"version": 2, "directories": {"a": "../x"}}, "lower case name"),
        ({"version": 2, "courses": [{"name": ".hidden"}]}, 'valid "name"'),
        ({"version": 2, "courses": [{"name": "p", "path": "x"}]}, "unknown keys"),
        ({"version": 2, "courses": [{"name": "p", "target": ""}]}, '"target"'),
    ]:
        with pytest.raises(LibraryError, match=message):
            parse_library(bad)


def test_a_registry_of_the_previous_version_is_read_but_never_written(
    tmp_path: Path,
) -> None:
    legacy = parse_library(
        {
            "version": 1,
            "collections": ["c.json"],
            "projects": [{"name": "repo", "target": "/src/repo"}],
        }
    )

    # Its projects are read as courses, and its version kept, so the
    # library can be seen to need upgrading.
    assert legacy == {
        "version": 1,
        "collections": ["c.json"],
        "courses": [{"name": "repo", "target": "/src/repo"}],
    }
    assert needs_upgrade(legacy)
    assert not needs_upgrade(empty_library())

    with pytest.raises(LibraryError, match="needs upgrading|previous layout"):
        serialize_library(legacy)

    (tmp_path / "library.json").write_text('{"version": 1}\n')

    with pytest.raises(LibraryError, match="previous layout"):
        update_library(tmp_path, ".", lambda library: library)

    assert read_library(tmp_path, ".") == {"version": 1}


def test_upgrade_moves_the_trees_of_the_previous_layout(tmp_path: Path) -> None:
    library = tmp_path / "lib"
    outside = tmp_path / "outside" / "course-repo"

    def workshop(path: Path, name: str) -> None:
        path.mkdir(parents=True)
        (path / "workshop.yaml").write_text(
            f"apiVersion: jupyterlab-workshop/v1alpha1\nname: {name}\n"
            f"title: {name}\npages: [pages/01.md]\n"
        )

    # Every tree of the previous layout, with a course linked from
    # outside, a course kept in the library, a workshop whose name is
    # that of the tree it moves into, and one with an environment.
    workshop(library / "personal" / "mine", "mine")
    workshop(library / "personal" / "workshops", "workshops")
    workshop(library / "standalone" / "beta-89abcde", "beta")
    workshop(library / "collections" / "c-1234567" / "alpha", "alpha")
    workshop(library / "projects" / "kept" / "workshops" / "draft", "draft")
    workshop(outside / "workshops" / "linked-draft", "linked-draft")
    (library / "projects" / "linked").symlink_to(outside, target_is_directory=True)
    (library / "personal" / "mine" / "_workshop").mkdir()
    (library / "personal" / "mine" / "_workshop" / "state.json").write_text("{}")
    (library / "personal" / "mine" / "_workshop" / "environment.json").write_text(
        json.dumps({"kernel": "nothing-registered-00000000"})
    )
    (library / "library.json").write_text(
        json.dumps(
            {
                "version": 1,
                "collections": ["c.json"],
                "directories": {"c.json": "c-1234567"},
                "projects": [{"name": "linked", "target": outside.as_posix()}],
            }
        )
    )

    plan = plan_upgrade(tmp_path, "lib")

    assert plan is not None
    assert [(move.source, move.target, move.contents) for move in plan.moves] == [
        ("lib/personal", "lib/personal/workshops", "2 workshops"),
        ("lib/projects", "lib/personal/courses", "2 courses"),
        ("lib/standalone", "lib/installed/workshops", "1 workshop"),
        ("lib/collections", "lib/installed/collections", "1 collection"),
    ]
    assert plan.environments == ["lib/personal/mine"]

    # Nothing moves while something is in the way of a tree.
    (library / "installed" / "workshops").mkdir(parents=True)

    with pytest.raises(LibraryError, match="in the way"):
        upgrade_library(tmp_path, "lib")

    assert (library / "personal" / "mine" / "workshop.yaml").is_file()

    (library / "installed" / "workshops").rmdir()
    (library / "installed").rmdir()

    assert upgrade_library(tmp_path, "lib") == plan

    # Each tree is where this release keeps it, progress and links and
    # all, the environment is gone, and the registry is current.
    assert (library / "personal" / "workshops" / "mine" / "workshop.yaml").is_file()
    moved = library / "personal" / "workshops" / "mine"

    assert (moved / "_workshop" / "state.json").is_file()
    assert not (moved / "_workshop" / "environment.json").exists()
    assert (library / "personal" / "workshops" / "workshops").is_dir()
    assert (library / "installed" / "workshops" / "beta-89abcde").is_dir()
    assert (
        library / "installed" / "collections" / "c-1234567" / "alpha" / "workshop.yaml"
    ).is_file()
    assert (library / "personal" / "courses" / "kept" / "workshops" / "draft").is_dir()
    assert is_link(library / "personal" / "courses" / "linked")
    assert (
        library / "personal" / "courses" / "linked" / "workshops" / "linked-draft"
    ).is_dir()

    for old in ("personal/mine", "standalone", "collections", "projects"):
        assert not (library / old).exists()

    assert read_library(tmp_path, "lib") == {
        "version": 2,
        "collections": ["c.json"],
        "directories": {"c.json": "c-1234567"},
        "courses": [{"name": "linked", "target": outside.as_posix()}],
    }
    assert plan_upgrade(tmp_path, "lib") is None

    with pytest.raises(LibraryError, match="not a workshop library in the previous"):
        upgrade_library(tmp_path, "lib")


def test_serialize_library_matches_the_browser_layout() -> None:
    text = serialize_library(
        {"courses": [{"name": "p"}], "collections": ["ü.json"], "version": 2}
    )

    assert text == (
        '{\n  "version": 2,\n  "collections": [\n    "ü.json"\n  ],\n'
        '  "courses": [\n    {\n      "name": "p"\n    }\n  ]\n}\n'
    )


def test_a_directory_is_a_library_only_with_its_registry(tmp_path: Path) -> None:
    assert not is_library(tmp_path, "workshops")
    assert read_library(tmp_path, "workshops") is None

    write_library(tmp_path, "workshops", {"version": 2, "collections": ["c.json"]})

    assert is_library(tmp_path, "workshops")
    assert read_library(tmp_path, "workshops") == {
        "version": 2,
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
    write_library(tmp_path, "w", {"version": 2, "catalogs": ["k.json"]})

    with pytest.raises(LibraryError):
        write_library(tmp_path, "w", {"version": 2, "catalogs": [""]})

    assert read_library(tmp_path, "w") == {"version": 2, "catalogs": ["k.json"]}


def test_read_library_reports_a_broken_file(tmp_path: Path) -> None:
    (tmp_path / "library.json").write_text("{not json")

    with pytest.raises(LibraryError, match="Unable to read"):
        read_library(tmp_path, ".")


def test_update_library_rereads_before_writing(tmp_path: Path) -> None:
    with pytest.raises(LibraryError, match="not a workshop library"):
        update_library(tmp_path, ".", lambda library: library)

    write_library(tmp_path, ".", {"version": 2, "collections": ["a.json"]})

    # Something else adds a catalog after this caller last looked.
    write_library(
        tmp_path, ".", {"version": 2, "collections": ["a.json"], "catalogs": ["k"]}
    )

    updated = update_library(
        tmp_path,
        ".",
        lambda library: {**library, "collections": [*library["collections"], "b"]},
    )

    assert updated == {
        "version": 2,
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


def test_courses_default_their_workshops_directory() -> None:
    library = parse_library(
        {"version": 2, "courses": [{"name": "repo", "workshops": "examples"}]}
    )

    assert course_workshops(course_entry(library, "repo")) == "examples"
    assert course_entry(library, "other") == {"name": "other"}
    assert course_workshops({"name": "other"}) == "workshops"


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


def test_link_course_links_and_records_the_target(tmp_path: Path) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"

    entry = link_course(library, repo, workshops="workshops")

    assert entry == {
        "name": "my-repo",
        "target": repo.resolve().as_posix(),
        "workshops": "workshops",
    }
    assert is_link(library / "personal" / "courses" / "my-repo")
    linked = library / "personal" / "courses" / "my-repo"

    assert (linked / "notes.txt").read_text() == "keep me\n"
    assert read_library(library, "")["courses"] == [entry]

    # Linking again is harmless; linking another directory under the
    # same name is refused.
    link_course(library, repo, workshops="workshops")

    other = tmp_path / "other"
    other.mkdir()

    with pytest.raises(LibraryError, match="already links"):
        link_course(library, other, name="my-repo")

    with pytest.raises(LibraryError, match="not a directory"):
        link_course(library, tmp_path / "missing")

    with pytest.raises(LibraryError, match="not a usable course name"):
        link_course(library, other, name="../up")


def test_unlink_course_removes_only_the_link(tmp_path: Path) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"

    link_course(library, repo)
    unlink_course(library, "my-repo")

    assert not (library / "personal" / "courses" / "my-repo").exists()
    assert not is_link(library / "personal" / "courses" / "my-repo")
    assert (repo / "notes.txt").read_text() == "keep me\n"
    assert read_library(library, "")["courses"] == []

    # A course kept in the library is not a link and is never removed by unlinking.
    (library / "personal" / "courses" / "cloned").mkdir()

    with pytest.raises(LibraryError, match="not a linked course"):
        unlink_course(library, "cloned")


def test_unlink_and_repair_cope_with_a_target_that_has_gone(tmp_path: Path) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"
    link = library / "personal" / "courses" / "my-repo"

    link_course(library, repo)

    # The link went but its target is still there: it comes back.
    link.unlink()

    assert repair_links(library) == ["my-repo"]
    assert is_link(link)

    # The target went: the link dangles, nothing is relinked, and
    # unlinking still cleans up.
    shutil.rmtree(repo)

    assert repair_links(library) == []

    unlink_course(library, "my-repo")

    assert not is_link(link)
    assert read_library(library, "")["courses"] == []


def test_linked_course_path_lets_through_only_a_registered_link(
    tmp_path: Path,
) -> None:
    root, repo = _linked_library(tmp_path)
    library = root / "lib"
    parts = ["lib", "personal", "courses", "my-repo", "workshops", "draft"]

    link_course(library, repo)

    resolved_root = root.resolve()
    linked = linked_course_path(resolved_root, parts)

    assert linked == resolved_root.joinpath(*parts)
    through = "lib/personal/courses/my-repo/workshops/draft"

    assert _resolve_inside(root, through) == linked
    assert _relative(root, linked) == through

    # A link the registry does not list, or one pointing somewhere other
    # than its recorded target, is refused.
    stray = tmp_path / "stray"
    stray.mkdir()
    (library / "personal" / "courses" / "unlisted").symlink_to(
        stray, target_is_directory=True
    )

    assert (
        linked_course_path(resolved_root, ["lib", "personal", "courses", "unlisted"])
        is None
    )

    with pytest.raises(FetchError, match="outside"):
        _resolve_inside(root, "lib/personal/courses/unlisted")

    (library / "personal" / "courses" / "my-repo").unlink()
    (library / "personal" / "courses" / "my-repo").symlink_to(
        stray, target_is_directory=True
    )

    assert linked_course_path(resolved_root, parts[:4]) is None


def test_remove_workshop_refuses_a_workshop_in_a_linked_course(
    tmp_path: Path,
) -> None:
    root, repo = _linked_library(tmp_path)

    link_course(root / "lib", repo)

    with pytest.raises(FetchError, match="linked course"):
        remove_workshop(root, "lib/personal/courses/my-repo/workshops/draft")

    assert (repo / "workshops" / "draft" / "workshop.yaml").is_file()
