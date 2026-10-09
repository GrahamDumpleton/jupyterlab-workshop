import json
from pathlib import Path

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.catalog import parse_catalog
from jupyterlab_workshop.collection import parse_collection
from jupyterlab_workshop.course import (
    CollectionSpec,
    CourseError,
    CourseOptions,
    id_prefix_for,
    read_record,
    update_course,
    write_course,
)
from jupyterlab_workshop.library import (
    LIBRARY_VARIABLE,
    empty_library,
    read_library,
    write_library,
)


def options(**changes: object) -> CourseOptions:
    values: dict[str, object] = {
        "name": "wrapt-workshops",
        "title": "wrapt workshops",
        "description": "Guided workshops for wrapt.",
        "collections": (
            CollectionSpec("decorators", "Decorators with wrapt", "Writing them."),
            CollectionSpec("proxies", "Object proxies with wrapt"),
        ),
        "id_prefix": "example.org",
        "repository": "https://github.com/example/wrapt-workshops",
        "version": "1.2.3",
    }
    values.update(changes)

    return CourseOptions(**values)  # type: ignore[arg-type]


def test_write_course_writes_a_repository_that_lints(tmp_path: Path) -> None:
    course = tmp_path / "wrapt-workshops"
    written = write_course(course, options())
    relative = sorted(path.relative_to(course).as_posix() for path in written)

    assert relative == [
        ".devcontainer/devcontainer.json",
        ".devcontainer/setup.sh",
        ".devcontainer/start.sh",
        ".devcontainer/welcome.md",
        ".github/workflows/test.yml",
        ".gitignore",
        ".mcp.json",
        "AGENTS.md",
        "CLAUDE.md",
        "Justfile",
        "OUTLINE.md",
        "README.md",
        "binder/postBuild",
        "binder/requirements.txt",
        "binder/runtime.txt",
        "binder/welcome.md",
        "catalog.json",
        "collections/decorators/collection.json",
        "collections/proxies/collection.json",
        "course.json",
        "jupyter_lab_config.py",
        "pyproject.toml",
        "workshops/.gitkeep",
    ]

    # The indexes are valid and empty, the ids follow the prefix, and the
    # catalog names each collection by relative path.
    index = parse_collection(
        (course / "collections" / "decorators" / "collection.json").read_text()
    )

    assert index["id"] == "example.org/wrapt-workshops/decorators"
    assert index["ordered"] is True
    assert index["workshops"] == []

    catalog = parse_catalog((course / "catalog.json").read_text())

    assert [item["url"] for item in catalog["collections"]] == [
        "collections/decorators/collection.json",
        "collections/proxies/collection.json",
    ]

    # Claude Code's local state is ignored, its committed files are not.
    ignored = (course / ".gitignore").read_text().splitlines()

    assert ".claude/settings.local.json" in ignored
    assert ".claude/.cc-writes/" in ignored
    assert ".ipynb_checkpoints/" in ignored
    assert ".mcp.json" not in ignored

    # The pin is this release's, the scripts are executable, and the
    # hosted overrides switch the library and authoring parts off.
    assert 'jupyterlab-workshop==1.2.3"' in (course / "pyproject.toml").read_text()
    requirements = (course / "binder" / "requirements.txt").read_text()

    assert "jupyterlab-workshop==1.2.3\n" in requirements
    assert (course / "binder" / "postBuild").stat().st_mode & 0o111
    assert (course / ".devcontainer" / "setup.sh").stat().st_mode & 0o111

    post_build = (course / "binder" / "postBuild").read_text()

    assert '"library",' in post_build and '"ai-authoring"' in post_build
    assert '"forcedLevel": "trusted"' in post_build
    assert "forcedLevel" not in (course / ".devcontainer" / "setup.sh").read_text()

    # Nothing for JupyterLite without --lite.
    assert not (course / "lite").exists()
    assert not (course / ".github" / "workflows" / "pages.yml").exists()
    assert "test-lite" not in (course / "Justfile").read_text()

    # The outline has a part for each collection, numbered, and the README
    # launches from the repository.
    outline = (course / "OUTLINE.md").read_text()

    assert "## Part I: Decorators with wrapt" in outline
    assert "## Part II: Object proxies with wrapt" in outline
    assert (
        "mybinder.org/v2/gh/example/wrapt-workshops/main"
        in (course / "README.md").read_text()
    )

    # The record holds the options and a hash per file.
    record = read_record(course)

    assert record is not None
    assert record["jupyterlab-workshop"] == "1.2.3"
    assert record["idPrefix"] == "example.org"
    assert set(record["generated"]) == set(relative) - {"course.json"}

    # Writing again refuses to overwrite.
    with pytest.raises(CourseError, match="Refusing to overwrite"):
        write_course(course, options())


def test_write_course_for_jupyterlite_adds_the_site_files(tmp_path: Path) -> None:
    course = tmp_path / "python-workshops"

    write_course(
        course, options(lite=True, collections=(CollectionSpec("basics", "Basics"),))
    )

    assert (course / "lite" / "settings.json").is_file()
    assert (course / "lite" / "welcome.md").is_file()
    assert (course / ".github" / "workflows" / "pages.yml").is_file()
    assert "mcp,test,lite" in (course / "pyproject.toml").read_text()
    assert "test-lite" in (course / "Justfile").read_text()
    workflow = (course / ".github" / "workflows" / "test.yml").read_text()

    assert "--frontend jupyterlite" in workflow

    # One collection is the whole course, so there is no Part I.
    outline = (course / "OUTLINE.md").read_text()

    assert "## Basics" in outline
    assert "Part I" not in outline


def test_check_options_refuses_bad_names() -> None:
    for bad, message in (
        (options(name="Bad Name"), "cannot be a course name"),
        (options(collections=()), "at least one collection"),
        (
            options(collections=(CollectionSpec("Up", "Up"),)),
            "cannot be a collection name",
        ),
        (
            options(collections=(CollectionSpec("a", "A"), CollectionSpec("a", "A"))),
            "named twice",
        ),
        (options(id_prefix="has space"), "no spaces"),
        (options(python="three"), "not a Python version"),
    ):
        with pytest.raises(CourseError, match=message):
            write_course(Path("unused"), bad)


def test_id_prefix_defaults_to_the_forge_and_owner() -> None:
    assert (
        id_prefix_for("https://github.com/Example/repo", "repo") == "github.com/Example"
    )
    assert id_prefix_for("", "repo") == "repo"
    assert id_prefix_for("nonsense", "repo") == "repo"


def test_update_course_moves_the_pin_and_keeps_edited_files(tmp_path: Path) -> None:
    course = tmp_path / "course"

    write_course(course, options())

    # The author edits the outline and adds a dependency to pyproject, and
    # a generated file goes missing.
    outline = course / "OUTLINE.md"
    outline.write_text(outline.read_text() + "\nSettled: one workshop a week.\n")

    pyproject = course / "pyproject.toml"
    pyproject.write_text(
        pyproject.read_text().replace(
            '"jupyterlab>=4.6,<5",', '"jupyterlab>=4.6,<5",\n    "rich",'
        )
    )
    (course / ".mcp.json").unlink()

    report = update_course(course, "2.0.0")

    assert (report.previous, report.version) == ("1.2.3", "2.0.0")
    assert report.kept == ["OUTLINE.md"]
    assert report.added == [".mcp.json"]
    assert "pyproject.toml" in report.refreshed
    assert "binder/requirements.txt" in report.refreshed
    assert "Justfile" not in report.refreshed

    # The pin moved whatever else was in the file, the edit survived, and
    # the record follows.
    text = pyproject.read_text()

    assert 'jupyterlab-workshop==2.0.0"' in text and '"rich",' in text
    assert "jupyterlab-workshop[mcp,test]" in text
    assert (
        "jupyterlab-workshop==2.0.0"
        in (course / "binder" / "requirements.txt").read_text()
    )
    assert outline.read_text().endswith("Settled: one workshop a week.\n")

    record = read_record(course)

    assert record is not None
    assert record["jupyterlab-workshop"] == "2.0.0"

    # Running again with nothing changed does nothing.
    again = update_course(course, "2.0.0")

    assert (again.refreshed, again.added) == ([], [])
    assert again.kept == ["OUTLINE.md"]

    with pytest.raises(CourseError, match="not a course"):
        update_course(tmp_path / "elsewhere")


def test_course_init_update_and_skill_commands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    library = tmp_path / "lib"
    course = tmp_path / "src" / "my-course"

    write_library(library, ".", empty_library())
    monkeypatch.setenv(LIBRARY_VARIABLE, str(library))

    assert (
        cli.main(
            [
                "course",
                "init",
                str(course),
                "--title",
                "My course",
                "--description",
                "Learning things.",
                "--collection",
                "first=The first part",
                "--collection",
                "second",
                "--link",
            ]
        )
        == 0
    )

    out = capsys.readouterr().out

    assert "wrote" in out
    assert "initialized a git repository" in out
    assert "linked" in out
    assert (course / ".git").is_dir()
    assert (course / "collections" / "first" / "collection.json").is_file()
    assert (course / "collections" / "second" / "collection.json").is_file()

    record = read_record(course)

    assert record is not None
    assert [c["title"] for c in record["collections"]] == ["The first part", "Second"]
    assert record["idPrefix"] == "my-course"

    # The course is linked into the library by its name.
    assert read_library(library, ".")["courses"] == [
        {"name": "my-course", "target": course.resolve().as_posix()}
    ]
    assert (library / "personal" / "courses" / "my-course").is_symlink()

    assert cli.main(["course", "update", str(course), "--version", "9.9.9"]) == 0

    out = capsys.readouterr().out

    assert "pinned jupyterlab-workshop 9.9.9 (was " in out
    record = json.loads((course / "course.json").read_text())

    assert record["jupyterlab-workshop"] == "9.9.9"

    # The skill links into the repository, and linking again is harmless.
    assert cli.main(["skill"]) == 0
    assert capsys.readouterr().out.strip().endswith("jupyterlab-workshop-authoring")

    assert cli.main(["skill", "--link", str(course)]) == 0

    link = course / ".claude" / "skills" / "jupyterlab-workshop-authoring"

    assert link.is_symlink()
    assert (link / "SKILL.md").is_file()
    assert cli.main(["skill", "--link", str(course)]) == 0
    assert "already links" in capsys.readouterr().out

    # Nothing is written over an existing directory's files.
    assert cli.main(["course", "init", str(course)]) == 2
    assert "Refusing to overwrite" in capsys.readouterr().err
