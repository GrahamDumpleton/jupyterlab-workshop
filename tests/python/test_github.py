import subprocess
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.course import CollectionSpec, CourseOptions, write_course
from jupyterlab_workshop.github import (
    GitHubError,
    publish_repository,
    recorded_remote,
)
from jupyterlab_workshop.scaffold import initialize_repository


def _commit_all(repository: Path, message: str = "Start") -> None:
    for command in (
        ["git", "-C", str(repository), "config", "user.email", "t@example.org"],
        ["git", "-C", str(repository), "config", "user.name", "Test"],
        ["git", "-C", str(repository), "add", "."],
        ["git", "-C", str(repository), "commit", "-q", "-m", message],
    ):
        subprocess.run(command, check=True, capture_output=True)


class FakeGh:
    """Answers gh by rule and runs git for real."""

    def __init__(
        self,
        scopes: str = "'gist', 'repo'",
        visibility: str = "PRIVATE",
        logged_in: bool = True,
    ) -> None:
        self.calls: list[list[str]] = []
        self.scopes = scopes
        self.visibility = visibility
        self.logged_in = logged_in

        # The real runner, kept for when the fake stands in for subprocess.run.
        self._run = subprocess.run

    def __call__(
        self, command: list[str], **kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        if not command[0].endswith("gh"):
            return self._run(command, **kwargs)

        self.calls.append(command[1:])

        if command[1:3] == ["auth", "status"]:
            if not self.logged_in:
                return subprocess.CompletedProcess(command, 1, "", "not logged in")

            return subprocess.CompletedProcess(
                command, 0, f"github.com\n  - Token scopes: {self.scopes}\n", ""
            )

        if command[1:3] == ["repo", "view"]:
            return subprocess.CompletedProcess(
                command, 0, f'{{"visibility": "{self.visibility}"}}\n', ""
            )

        if command[1:3] == ["repo", "create"]:
            name = command[3]
            owner_repo = name if "/" in name else f"ada/{name}"

            # gh adds the remote and pushes; the fake adds the remote.
            source = command[command.index("--source") + 1]

            self._run(
                [
                    "git",
                    "-C",
                    source,
                    "remote",
                    "add",
                    "origin",
                    f"https://github.com/{owner_repo}.git",
                ],
                check=True,
                capture_output=True,
            )

            return subprocess.CompletedProcess(
                command, 0, f"https://github.com/{owner_repo}\n", ""
            )

        return subprocess.CompletedProcess(command, 0, "", "")


@pytest.fixture
def gh_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("jupyterlab_workshop.github.shutil.which", lambda name: name)


def test_publish_creates_a_private_repository_and_pushes(
    tmp_path: Path, gh_present: None
) -> None:
    repository = tmp_path / "git-basics"

    repository.mkdir()
    (repository / "workshop.yaml").write_text("name: git-basics\n")
    initialize_repository(repository)
    _commit_all(repository)

    gh = FakeGh()
    result = publish_repository(repository, description="First steps", run=gh)

    assert result.url == "https://github.com/ada/git-basics"
    assert result.created is True
    assert result.public is False
    assert result.notes == ()
    assert gh.calls[0] == ["auth", "status"]
    assert gh.calls[1] == [
        "repo",
        "create",
        "git-basics",
        "--private",
        "--source",
        str(repository),
        "--remote",
        "origin",
        "--push",
        "--description",
        "First steps",
    ]

    # A name under another owner, public, is passed as given.
    other = tmp_path / "other"

    other.mkdir()
    (other / "README.md").write_text("x\n")
    initialize_repository(other)
    _commit_all(other)

    result = publish_repository(other, name="org/other-name", public=True, run=gh)

    assert result.url == "https://github.com/org/other-name"
    assert result.public is True
    assert gh.calls[-1][2:4] == ["org/other-name", "--public"]


def test_publish_refuses_what_is_not_ready(tmp_path: Path, gh_present: None) -> None:
    repository = tmp_path / "demo"

    repository.mkdir()
    (repository / "a.md").write_text("a\n")

    with pytest.raises(GitHubError, match="not a git repository"):
        publish_repository(repository, run=FakeGh())

    initialize_repository(repository)

    with pytest.raises(GitHubError, match="Nothing is committed"):
        publish_repository(repository, run=FakeGh())

    _commit_all(repository)
    (repository / "b.md").write_text("b\n")

    with pytest.raises(GitHubError, match="uncommitted changes"):
        publish_repository(repository, run=FakeGh())

    (repository / "b.md").unlink()

    # A workshop inside a repository is published with the repository.
    inside = repository / "workshops" / "one"

    inside.mkdir(parents=True)

    with pytest.raises(GitHubError, match="published with the course"):
        publish_repository(inside, run=FakeGh())

    inside.rmdir()
    (repository / "workshops").rmdir()

    # gh must be signed in, with the repo scope on a classic token.
    with pytest.raises(GitHubError, match="not signed in"):
        publish_repository(repository, run=FakeGh(logged_in=False))

    with pytest.raises(GitHubError, match="lacks the repo scope"):
        publish_repository(repository, run=FakeGh(scopes="'gist'"))

    # A token that reports no scopes is taken as it is.
    gh = FakeGh()

    def no_scopes(
        command: list[str], **kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        if command[0].endswith("gh") and command[1:3] == ["auth", "status"]:
            return subprocess.CompletedProcess(command, 0, "github.com\n", "")

        return gh(command, **kwargs)

    assert publish_repository(repository, run=no_scopes).created is True


def test_publish_pushes_to_the_remote_it_has_and_can_make_it_public(
    tmp_path: Path, gh_present: None
) -> None:
    repository = tmp_path / "demo"

    repository.mkdir()
    (repository / "a.md").write_text("a\n")
    initialize_repository(repository)
    _commit_all(repository)

    # A bare repository stands in for GitHub, so the push is real.
    remote = tmp_path / "remote.git"

    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    subprocess.run(
        ["git", "-C", str(repository), "remote", "add", "origin", str(remote)],
        check=True,
    )

    gh = FakeGh()

    # The remote is not on GitHub, so its address passes through as given.
    result = publish_repository(repository, run=gh)

    assert result.created is False
    assert result.url == str(remote).removesuffix(".git")
    assert result.public is False
    assert result.made_public is False
    assert [call[:2] for call in gh.calls] == [["auth", "status"], ["repo", "view"]]
    assert (
        subprocess.run(
            ["git", "-C", str(remote), "log", "--oneline"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.count("\n")
        == 1
    )

    # Asking for public edits the visibility, once.
    opened = publish_repository(repository, public=True, run=gh)

    assert opened.made_public is True
    assert opened.public is True
    assert gh.calls[-1][:2] == ["repo", "edit"]
    assert gh.calls[-1][2].endswith("/remote")
    assert "--visibility" in gh.calls[-1]

    gh.visibility = "PUBLIC"
    again = publish_repository(repository, public=True, run=gh)

    assert again.made_public is False
    assert again.public is True
    assert gh.calls[-1][:2] == ["repo", "view"]


def test_publish_names_the_repository_in_a_course(
    tmp_path: Path, gh_present: None
) -> None:
    course = tmp_path / "python-course"

    write_course(
        course,
        CourseOptions(
            name="python-course",
            title="Python course",
            description="Python.",
            collections=(CollectionSpec("basics", "Basics"),),
            id_prefix="example.org",
            lite=True,
            version="1.2.3",
        ),
    )

    # The person edited the README before publishing; the Justfile is as
    # generated.
    readme = course / "README.md"

    readme.write_text(readme.read_text() + "\nLocal note.\n")
    initialize_repository(course)
    _commit_all(course)

    assert "https://github.com/OWNER/python-course" in (course / "Justfile").read_text()

    gh = FakeGh()
    result = publish_repository(course, run=gh)

    assert result.url == "https://github.com/ada/python-course"
    assert "Justfile" in result.refreshed
    assert "README.md" not in result.refreshed
    assert "https://github.com/ada/python-course" in (course / "Justfile").read_text()
    assert readme.read_text().endswith("Local note.\n")
    assert any("Commit them and publish again" in note for note in result.notes)
    assert any("GitHub Pages" in note and "paid plan" in note for note in result.notes)

    # The record names the repository and keeps its pin.
    import json

    record = json.loads((course / "course.json").read_text())

    assert record["repository"] == "https://github.com/ada/python-course"
    assert record["jupyterlab-workshop"] == "1.2.3"


def test_recorded_remote_reads_the_git_config(tmp_path: Path) -> None:
    config = tmp_path / ".git" / "config"

    config.parent.mkdir()

    assert recorded_remote(tmp_path) is None

    config.write_text(
        "[core]\n\trepositoryformatversion = 0\n"
        '[remote "upstream"]\n\turl = https://github.com/x/y.git\n'
        '[remote "origin"]\n\turl = ssh://git@github.com/ada/demo.git\n'
        "\tfetch = +refs/heads/*:refs/remotes/origin/*\n"
    )

    assert recorded_remote(tmp_path) == "https://github.com/ada/demo"


def test_github_command_reports_what_it_did(
    tmp_path: Path,
    gh_present: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    repository = tmp_path / "demo"

    repository.mkdir()
    (repository / "a.md").write_text("a\n")
    initialize_repository(repository)
    _commit_all(repository)

    monkeypatch.setattr("jupyterlab_workshop.github.subprocess.run", FakeGh())

    assert cli.main(["github", str(repository), "--description", "Demo"]) == 0
    assert "created https://github.com/ada/demo (private) and pushed" in (
        capsys.readouterr().out
    )

    (repository / "b.md").write_text("b\n")

    assert cli.main(["github", str(repository)]) == 2
    assert "uncommitted changes" in capsys.readouterr().err
