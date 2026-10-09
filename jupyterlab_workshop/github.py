"""Publishing a workshop or a course to a repository on GitHub.

Everything goes through the ``gh`` command, which holds the person's
GitHub login and never shows a token to the caller: it creates the
repository, private unless asked for a public one, with the directory as
its source, adds it as ``origin`` and pushes. A directory that has an
``origin`` already is pushed to it instead, and an existing private
repository is made public when asked. Nothing is committed here: a tree
with uncommitted changes, or with no commits yet, is refused, so what is
published is what the person, or the agent when told, committed.

``jupyter workshop github`` and Workshop Author's ``publish_github`` tool
share this; the tool always asks the person first.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

#: Runs a command as ``subprocess.run`` does; tests pass a fake.
Runner = Callable[..., "subprocess.CompletedProcess[str]"]

#: The workflow a course written for JupyterLite publishes its site with.
PAGES_WORKFLOW = Path(".github") / "workflows" / "pages.yml"

#: The scope a push and ``gh repo create`` need on a classic token.
REQUIRED_SCOPE = "repo"


class GitHubError(Exception):
    """The repository could not be published as asked."""


@dataclass(frozen=True)
class GitHubResult:
    """What publishing did."""

    #: The repository's page, ``https://github.com/<owner>/<name>``.
    url: str

    #: Whether the repository was created, as against pushed to.
    created: bool

    #: Whether it is public now.
    public: bool

    #: Whether it was private and has just been made public.
    made_public: bool = False

    #: Generated course files rewritten to name the repository, for the
    #: person to commit and push.
    refreshed: tuple[str, ...] = ()

    #: What the person should know next, such as GitHub Pages.
    notes: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, object]:
        """The result as the tool reports it."""

        return {
            "url": self.url,
            "created": self.created,
            "public": self.public,
            "made_public": self.made_public,
            "refreshed": list(self.refreshed),
            "notes": list(self.notes),
        }


def publish_repository(
    directory: Path,
    name: str = "",
    public: bool = False,
    description: str = "",
    run: Runner | None = None,
) -> GitHubResult:
    """Publish a repository to GitHub, or push to the one it already has.

    ``directory`` must be the top of a git repository with everything
    committed. Without an ``origin`` a repository called ``name``, the
    directory's own name by default, is created on GitHub, private unless
    ``public``, and pushed. With one, the current branch is pushed to it,
    and with ``public`` a private repository is made public. A course's
    generated files are then rewritten to name the repository where they
    still match the scaffold, and reported for committing.
    """

    runner: Runner = run if run is not None else subprocess.run
    git = shutil.which("git")
    gh = shutil.which("gh")

    if git is None:
        raise GitHubError("git is not installed")

    if gh is None:
        raise GitHubError(
            "The gh command is not installed: install the GitHub CLI and sign "
            "in with gh auth login"
        )

    _check_repository(git, directory, runner)
    _check_login(gh, runner)

    existing = remote_url(git, directory, runner)
    notes: list[str] = []

    if existing is not None:
        pushed = runner(
            [git, "-C", str(directory), "push", "--set-upstream", "origin", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )

        if pushed.returncode != 0:
            raise GitHubError(f"git push failed: {_output(pushed)}")

        was_public = _is_public(gh, existing, runner)
        made_public = False

        if public and not was_public:
            edited = runner(
                [
                    gh,
                    "repo",
                    "edit",
                    _owner_repo(existing),
                    "--visibility",
                    "public",
                    "--accept-visibility-change-consequences",
                ],
                capture_output=True,
                text=True,
                check=False,
            )

            if edited.returncode != 0:
                raise GitHubError(
                    f"Unable to make {existing} public: {_output(edited)}"
                )

            made_public = True

        notes.extend(_pages_notes(directory, was_public or made_public))

        return GitHubResult(
            url=existing,
            created=False,
            public=was_public or made_public,
            made_public=made_public,
            notes=tuple(notes),
        )

    chosen = name or directory.resolve().name
    command = [
        gh,
        "repo",
        "create",
        chosen,
        "--public" if public else "--private",
        "--source",
        str(directory),
        "--remote",
        "origin",
        "--push",
    ]

    if description:
        command += ["--description", description]

    created = runner(command, capture_output=True, text=True, check=False)

    if created.returncode != 0:
        raise GitHubError(f"gh repo create failed: {_output(created)}")

    # gh prints the repository's address; the remote it added says the same.
    found = re.search(r"https://github\.com/\S+", created.stdout or "")
    url = (
        _normalize(found.group(0))
        if found
        else remote_url(git, directory, runner) or ""
    )

    if not url:
        raise GitHubError("gh repo create reported no repository address")

    refreshed = _name_repository(directory, url)

    if refreshed:
        notes.append(
            "The course's generated files now name the repository: "
            + ", ".join(refreshed)
            + ". Commit them and publish again to push them."
        )

    notes.extend(_pages_notes(directory, public))

    return GitHubResult(
        url=url,
        created=True,
        public=public,
        refreshed=tuple(refreshed),
        notes=tuple(notes),
    )


def remote_url(git: str, directory: Path, run: Runner) -> str | None:
    """The ``origin`` remote's address as a GitHub page URL, or None."""

    completed = run(
        [git, "-C", str(directory), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=False,
    )

    if completed.returncode != 0 or not completed.stdout.strip():
        return None

    return _normalize(completed.stdout.strip())


def recorded_remote(directory: Path) -> str | None:
    """The ``origin`` remote's address read from ``.git/config``, as a
    GitHub page URL, or None; for a policy that runs nothing."""

    config = directory / ".git" / "config"

    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return None

    section = re.search(
        r'^\[remote "origin"\]\s*\n((?:[ \t]+.*\n?)*)', text, re.MULTILINE
    )

    if section is None:
        return None

    url = re.search(r"^[ \t]+url\s*=\s*(\S+)", section.group(1), re.MULTILINE)

    return _normalize(url.group(1)) if url else None


def _normalize(url: str) -> str:
    # The forms git accepts for the same repository, as one page address.
    url = url.strip()

    if url.startswith("git@"):
        host, _, path = url[len("git@") :].partition(":")
        url = f"https://{host}/{path}"
    elif url.startswith("ssh://"):
        rest = url[len("ssh://") :]
        rest = rest.split("@", 1)[1] if "@" in rest else rest
        url = f"https://{rest}"

    return url.removesuffix(".git").rstrip("/")


def _owner_repo(url: str) -> str:
    return "/".join(url.rstrip("/").split("/")[-2:])


def _check_repository(git: str, directory: Path, run: Runner) -> None:
    # The directory must be the top of a repository, with everything
    # committed, so what is published is what was reviewed.
    top = run(
        [git, "-C", str(directory), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=False,
    )

    if top.returncode != 0:
        raise GitHubError(f"{directory} is not a git repository")

    if Path(top.stdout.strip()).resolve() != directory.resolve():
        raise GitHubError(
            f"{directory} is inside the repository {top.stdout.strip()}, which "
            "is what gets published; a workshop in a course is published "
            "with the course"
        )

    head = run(
        [git, "-C", str(directory), "rev-parse", "--verify", "--quiet", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )

    if head.returncode != 0:
        raise GitHubError("Nothing is committed yet: commit first")

    status = run(
        [git, "-C", str(directory), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=False,
    )

    if status.stdout.strip():
        raise GitHubError(
            "There are uncommitted changes: commit them first, so what is "
            "published is what was committed"
        )


def _check_login(gh: str, run: Runner) -> None:
    # gh must be signed in, and a classic token must carry the repo scope;
    # a fine-grained token reports no scopes and is taken as it is.
    status = run([gh, "auth", "status"], capture_output=True, text=True, check=False)

    if status.returncode != 0:
        raise GitHubError(
            "gh is not signed in to GitHub: run gh auth login in a terminal"
        )

    scopes = re.search(r"Token scopes:(.*)", _output(status))

    if scopes is None:
        return

    granted = {item.strip().strip("'\"") for item in scopes.group(1).split(",")}

    if REQUIRED_SCOPE not in granted:
        raise GitHubError(
            f"The GitHub token lacks the {REQUIRED_SCOPE} scope a repository "
            f"needs: run gh auth refresh -s {REQUIRED_SCOPE}"
        )


def _is_public(gh: str, url: str, run: Runner) -> bool:
    viewed = run(
        [gh, "repo", "view", _owner_repo(url), "--json", "visibility"],
        capture_output=True,
        text=True,
        check=False,
    )

    return viewed.returncode == 0 and '"PUBLIC"' in viewed.stdout.upper()


def _name_repository(directory: Path, url: str) -> list[str]:
    # A course scaffolded before it had a repository carries a placeholder
    # address; the generated files still as written are rewritten with the
    # real one, and the record keeps it for later updates.
    from .course import read_record, update_course

    try:
        record = read_record(directory)

        if record is None:
            return []

        # The pin stays where it is: this names the repository, nothing more.
        report = update_course(
            directory,
            version=str(record.get("jupyterlab-workshop") or ""),
            repository=url,
        )
    except Exception:
        return []

    return sorted(report.refreshed + report.added)


def _pages_notes(directory: Path, public: bool) -> list[str]:
    if not (directory / PAGES_WORKFLOW).is_file():
        return []

    note = (
        "The Pages workflow publishes the JupyterLite site once GitHub Pages "
        "is set to build from GitHub Actions in the repository's settings "
        "(Settings, Pages, Source: GitHub Actions)"
    )

    if not public:
        note += (
            "; on a private repository Pages needs a paid plan, so the "
            "workflow fails until the repository is public or the plan allows it"
        )

    return [note + "."]


def _output(completed: subprocess.CompletedProcess[str]) -> str:
    return ((completed.stdout or "") + "\n" + (completed.stderr or "")).strip()
