import json
import shutil
import tarfile
from pathlib import Path

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.harness import SelfTestReport, _junit
from jupyterlab_workshop.scaffold import slug

needs_node = pytest.mark.skipif(
    shutil.which("node") is None or not cli.NODE_BUNDLE.is_file(),
    reason="needs node and the built Node bundle (run `just build`)",
)


def test_slug() -> None:
    assert slug("My Workshop!") == "my-workshop"
    assert slug("---") == "workshop"


def test_init_writes_a_workshop_and_refuses_to_overwrite(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "intro-to-git"

    assert cli.main(["init", str(target), "--ci"]) == 0
    assert (
        (target / "workshop.yaml")
        .read_text()
        .startswith("apiVersion: jupyterlab-workshop/v1alpha1\nname: intro-to-git\n")
    )
    assert (target / "pages" / "01-welcome.md").exists()
    assert (target / ".github" / "workflows" / "workshop.yml").exists()
    assert "wrote" in capsys.readouterr().out

    assert cli.main(["init", str(target)]) == 2
    assert "Refusing to overwrite" in capsys.readouterr().err


@needs_node
def test_lint_pages_and_render_use_the_node_bundle(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "demo"

    cli.main(["init", str(target), "--title", "Demo time"])
    capsys.readouterr()

    assert cli.main(["lint", str(target)]) == 0
    assert "0 error(s)" in capsys.readouterr().out

    assert cli.main(["lint", str(target), "--json"]) == 0
    report = json.loads(capsys.readouterr().out)

    assert report["errors"] == 0

    # Break the workshop and lint again.
    page = target / "pages" / "01-welcome.md"

    page.write_text(page.read_text() + "\n```{teleport}\nnowhere\n```\n")

    assert cli.main(["lint", str(target)]) == 1
    assert 'Unknown directive "teleport"' in capsys.readouterr().out

    assert cli.main(["pages", str(target)]) == 0
    assert "01-welcome\tWelcome" in capsys.readouterr().out

    out = tmp_path / "site.html"

    assert cli.main(["render", str(target), "--out", str(out)]) == 0
    assert "<h1>Demo time</h1>" in out.read_text()
    assert 'class="workshop-action workshop-action-execute"' in out.read_text()


def test_lint_needs_a_workshop(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["lint", str(tmp_path)]) == 2
    assert "has no workshop.yaml" in capsys.readouterr().err


def test_schema_prints_the_manifest_schema(
    capsys: pytest.CaptureFixture[str],
) -> None:
    if not cli.SCHEMA_FILE.is_file():
        pytest.skip("needs the built schema copy (run `just build`)")

    assert cli.main(["schema"]) == 0

    schema = json.loads(capsys.readouterr().out)

    assert schema["title"] == "Workshop manifest"
    assert "capabilities" in schema["properties"]


def test_publish_builds_a_stable_archive(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "pub"

    cli.main(["init", str(target)])
    (target / "_workshop").mkdir()
    (target / "_workshop" / "state.json").write_text("{}")

    out = tmp_path / "dist"

    assert (
        cli.main(
            [
                "publish",
                str(target),
                "--out",
                str(out),
                "--url",
                "https://example.org/pub-0.1.0.tar.gz",
            ]
        )
        == 0
    )

    archive = out / "pub-0.1.0.tar.gz"

    with tarfile.open(archive) as tar:
        names = tar.getnames()

    assert "pub-0.1.0/workshop.yaml" in names
    assert "pub-0.1.0/pages/01-welcome.md" in names
    assert not any("_workshop" in name for name in names)

    digest = (out / "pub-0.1.0.tar.gz.sha256").read_text().split()[0]
    entry = json.loads((out / "pub-0.1.0.collection.json").read_text())

    assert entry["name"] == "pub"
    assert entry["versions"][0]["sha256"] == digest
    assert entry["versions"][0]["source"] == {
        "archive": "https://example.org/pub-0.1.0.tar.gz"
    }
    assert f"sha256 {digest}" in capsys.readouterr().out


def test_junit_report_marks_failures_and_skips() -> None:
    report = SelfTestReport(
        workshop="demo",
        results=[
            {"page": "p1", "id": "a", "type": "execute", "status": "ok", "seconds": 1},
            {
                "page": "p1",
                "id": "check",
                "type": "verify",
                "status": "error",
                "message": 'No commits <yet> "run" git',
                "seconds": 0.5,
            },
            {
                "page": "p2",
                "id": "q",
                "type": "quiz",
                "status": "skipped",
                "seconds": 0,
            },
        ],
        passed=1,
        failed=1,
        skipped=1,
    )

    xml = _junit(report)

    assert '<testsuite name="demo" tests="3" failures="1" skipped="1"' in xml
    assert '<testcase classname="p1" name="check (verify)"' in xml
    assert '<failure message="No commits &lt;yet&gt; &quot;run&quot; git">' in xml
    assert '<skipped message=""/>' in xml


def test_collection_command_builds_an_index_from_entries(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    entry = tmp_path / "demo-1.0.collection.json"
    index = tmp_path / "collections" / "collection.json"

    entry.write_text(
        json.dumps(
            {
                "name": "demo",
                "title": "Demo",
                "versions": [
                    {"version": "1.0", "source": {"archive": "https://h/demo.tgz"}}
                ],
            }
        )
    )

    assert (
        cli.main(
            [
                "collection",
                str(index),
                str(entry),
                "--title",
                "Mine",
                "--description",
                "About mine.",
                "--publisher",
                "Me",
                "--icon",
                "icon.svg",
                "--tag",
                "a",
            ]
        )
        == 0
    )
    assert "1 workshop(s)" in capsys.readouterr().out

    data = json.loads(index.read_text())

    assert data["title"] == "Mine"
    assert data["description"] == "About mine."
    assert data["publisher"] == {"name": "Me"}
    assert data["icon"] == "icon.svg"
    assert data["tags"] == ["a"]
    assert data["workshops"][0]["name"] == "demo"

    # Publishing again adds a version rather than replacing the entry.
    entry.write_text(
        json.dumps(
            {
                "name": "demo",
                "title": "Demo",
                "versions": [
                    {"version": "1.1", "source": {"archive": "https://h/demo11.tgz"}}
                ],
            }
        )
    )

    assert cli.main(["collection", str(index), str(entry)]) == 0

    data = json.loads(index.read_text())

    assert data["title"] == "Mine"
    assert [v["version"] for v in data["workshops"][0]["versions"]] == ["1.1", "1.0"]

    entry.write_text("[]")

    assert cli.main(["collection", str(index), str(entry)]) == 2


def test_index_command_indexes_a_repository(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(["init", str(tmp_path / "workshops" / "one"), "--title", "One"])
    cli.main(["init", str(tmp_path / "workshops" / "two"), "--title", "Two"])

    # Without a git origin the repository must be given, and the sources
    # are relative to the root, which is the directory itself when it is
    # not a checkout.
    assert cli.main(["index", str(tmp_path / "workshops")]) == 2
    assert (
        cli.main(
            [
                "index",
                str(tmp_path / "workshops"),
                "--root",
                str(tmp_path),
                "--repo",
                "https://github.com/org/workshops",
                "--ref",
                "v1",
                "--title",
                "Class",
                "--ordered",
            ]
        )
        == 0
    )
    assert "2 workshop(s)" in capsys.readouterr().out

    data = json.loads((tmp_path / "collection.json").read_text())

    assert data["title"] == "Class"
    assert data["ordered"] is True
    assert [entry["name"] for entry in data["workshops"]] == ["one", "two"]
    assert data["workshops"][0]["versions"][0]["source"] == {
        "git": "https://github.com/org/workshops",
        "ref": "v1",
        "subdir": "workshops/one",
    }

    # An explicit output path is honoured and a bad existing index refused.
    out = tmp_path / "site" / "index.json"
    command = ["index", str(tmp_path), "--repo", "https://x/y", "--out", str(out)]

    assert cli.main(command) == 0
    assert out.is_file()

    out.write_text("{}")

    assert cli.main(command) == 2


def test_init_templates_and_options(tmp_path: Path) -> None:
    target = tmp_path / "nb"

    assert (
        cli.main(
            [
                "init",
                str(target),
                "--template",
                "notebook",
                "--platform",
                "linux",
                "--platform",
                "windows",
                "--capability",
                "kernel-exec",
                "--gating",
                "strict",
            ]
        )
        == 0
    )

    manifest = (target / "workshop.yaml").read_text()

    assert "platforms: [linux, windows]" in manifest
    assert "capabilities:\n  - kernel-exec\n" in manifest
    assert "gating: strict" in manifest
    assert "name: notebook" in manifest
    assert (target / "pages" / "02-explore.md").exists()

    blank = tmp_path / "blank"

    assert cli.main(["init", str(blank), "--template", "blank"]) == 0
    assert "capabilities: []" in (blank / "workshop.yaml").read_text()


@needs_node
def test_record_drafts_pages_from_a_recording(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    recording = tmp_path / "session.json"

    recording.write_text(
        json.dumps(
            {
                "version": 1,
                "started": "2026-09-05T10:00:00Z",
                "events": [
                    {
                        "kind": "terminal",
                        "ts": "",
                        "session": "workshop",
                        "command": "mkdir demo",
                    },
                    {"kind": "page-break", "ts": "", "title": "Write a file"},
                    {
                        "kind": "file-saved",
                        "ts": "",
                        "path": "demo/a.txt",
                        "content": "hello\n",
                        "previous": None,
                    },
                ],
            }
        )
    )

    target = tmp_path / "recorded"

    assert cli.main(["record", str(recording), str(target), "--title", "Rec"]) == 0
    assert "wrote" in capsys.readouterr().out

    manifest = (target / "workshop.yaml").read_text()

    assert "title: Rec" in manifest
    assert "pages/01-getting-started.md" in manifest
    assert "pages/02-write-a-file.md" in manifest
    assert cli.main(["lint", str(target)]) == 0

    # Recording into an existing workshop appends pages.
    assert cli.main(["record", str(recording), str(target)]) == 0
    assert "pages/04-write-a-file.md" in (target / "workshop.yaml").read_text()
    assert cli.main(["record", str(tmp_path / "missing.json"), str(target)]) == 2
