"""Publishing a workshop as a GitHub gist.

A gist is a git repository that holds no directories, so a workshop is
laid out flat before it goes in: every file is stored under its path
with the directory separators turned into ``--``, so
``pages/01-welcome.md`` is held as ``pages--01-welcome.md``, and a
``workshop-tree.json`` beside them maps each path to the gist file that
holds it. Nothing in the workshop is rewritten: a download of the gist
puts every file back at its path (see ``tree``). The files carried are
the ones ``jupyter workshop publish`` would archive, less hidden files
and the workshop's own README. The gists API carries text only, so a
file that is not text is held as base64, and an empty file, which a gist
cannot hold, is recorded in the tree alone. A generated ``README.md``,
which GitHub pins to the top of the gist page, gives the title,
description and details from the manifest, and how to open the
workshop, with a launch button for a JupyterLite site when the manifest
lists that frontend and one for the project's Binder launcher. The flat
copy is written to a directory and, when asked, sent to GitHub through
the gists API.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import textwrap
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .checks import satisfies_version
from .fetch import USER_AGENT
from .publish import PUBLISH_EXCLUDES, WORKSPACE_DIR, PublishError, read_manifest
from .tree import BASE64, TREE_FILE, TreeEntry, tree_document

MANIFEST_FILE = "workshop.yaml"

#: Stands in for the directory separator in a gist file name.
SEPARATOR = "--"

README_FILE = "README.md"

#: Python versions, newest first, that the project publishes a JupyterLite
#: launcher site for; each is built with the Pyodide kernel of that Python.
LAUNCHER_PYTHONS = ("3.14",)

#: Where the launcher site for a Python version is published.
LAUNCHER_SITE = (
    "https://grahamdumpleton.github.io/jupyterlab-workshop/lite/{python}/lab/index.html"
)

#: The launcher the README's button opens when the manifest asks for no
#: particular Python: the newest.
DEFAULT_SITE = LAUNCHER_SITE.format(python=LAUNCHER_PYTHONS[0])

#: Tool names a manifest requires Python under.
PYTHON_TOOLS = ("python", "python3")

#: Stands in for the gist's address in a README written before the gist exists.
GIST_URL_PLACEHOLDER = "https://gist.github.com/<owner>/<id>"

PROJECT_URL = "https://github.com/GrahamDumpleton/jupyterlab-workshop"

LAUNCH_BADGE = "https://img.shields.io/badge/launch-JupyterLite-F37626?logo=jupyter&logoColor=white"

#: The project's Binder repository, which installs JupyterLab with the
#: extension and nothing else, so a launch link names the workshop.
BINDER_LAUNCHER = (
    "https://mybinder.org/v2/gh/GrahamDumpleton/jupyterlab-workshop-binder/main"
)

BINDER_BADGE = (
    "https://img.shields.io/badge/launch-Binder-579ACA?logo=jupyter&logoColor=white"
)

#: GitHub names a file it was not given a name for `gistfile<n>`.
RESERVED_PREFIX = "gistfile"

API_URL = "https://api.github.com"

API_VERSION = "2022-11-28"

#: Environment variables a token is read from, in order, as `gh` reads them.
TOKEN_VARIABLES = ("GH_TOKEN", "GITHUB_TOKEN")

#: Added to the gist name of a file held as base64.
BASE64_SUFFIX = ".base64"

#: Line length the base64 of a file is wrapped at, so the gist shows it.
BASE64_WIDTH = 76

#: Editor and operating system droppings, which are never carried.
DROPPINGS = {"Thumbs.db", "desktop.ini"}

#: How long one API call may take.
API_TIMEOUT = 60

#: Sends one API request: method, URL, JSON body and token, to a JSON reply.
Requester = Callable[[str, str, Mapping[str, Any] | None, str], dict[str, Any]]

_GIST_URL = re.compile(
    r"^(?:https://gist\.github\.com/(?:[^/]+/)?)?(?P<id>[0-9a-fA-F]+)(?:/[0-9a-fA-F]+)?/?$"
)


class GistError(Exception):
    """The workshop could not be laid out flat or sent to GitHub."""


@dataclass(frozen=True)
class FlatWorkshop:
    """A workshop laid out as a gist holds it."""

    name: str
    title: str
    description: str

    #: Gist file name to content, the manifest, tree file and README included.
    files: dict[str, str]

    #: Workshop path to gist file name, for the files whose name changed.
    renames: dict[str, str]

    #: Files in the workshop directory that are not carried.
    left_out: list[str]

    #: Where each carried file goes back, as the tree file lists it.
    entries: list[TreeEntry] = field(default_factory=list)

    #: The manifest, as parsed, for the README.
    manifest: dict[str, Any] = field(default_factory=dict)

    #: The JupyterLite site the README's launch button opens.
    site: str = DEFAULT_SITE

    #: The Python version that site provides, when it is a launcher.
    python: str = ""

    #: The author's own README, appended to the generated one; empty for none.
    readme_extra: str = ""

    #: The Binder launcher the README's Binder button opens; empty for none.
    binder: str = BINDER_LAUNCHER

    def with_gist_url(self, url: str) -> FlatWorkshop:
        """The same copy with the README written for the gist at ``url``."""

        files = dict(self.files)
        files[README_FILE] = render_readme(
            self.manifest, url, self.site, self.readme_extra, self.binder
        )

        return replace(self, files=files)


@dataclass(frozen=True)
class GistResult:
    """What creating or updating a gist produced."""

    id: str
    url: str
    created: bool


def flat_name(path: str) -> str:
    """The gist file name for a workshop-relative path.

    Directory separators become ``--``, which keeps the origin of a file
    visible on the gist page and groups a directory's files together in
    its alphabetical listing. The name is only for reading: the tree
    file says where each file goes back, so nothing parses it.
    """

    return SEPARATOR.join(PurePosixPath(path).parts)


def flatten_workshop(
    directory: Path,
    site: str = "",
    append_readme: bool = False,
    python: str = "",
    binder: str = BINDER_LAUNCHER,
) -> FlatWorkshop:
    """Lay a workshop out flat, with a tree file to put it back.

    The files carried are those ``jupyter workshop publish`` would
    archive, less hidden files, editor droppings, links and the
    workshop's own ``README.md``; every page the manifest lists must be
    among them. Each is stored under its ``flat_name``, text as it is,
    anything else as base64 under a name ending ``.base64``, and an
    empty file in the tree alone, since a gist cannot hold one. A
    ``README.md`` is generated from the manifest, with a launch button
    when the manifest lists the JupyterLite frontend: for ``site`` when
    given, else the published launcher whose Python suits the manifest,
    or ``python``; see ``launcher_site``. It also carries a button that
    opens the workshop through the Binder launcher ``binder``, unless that
    is empty; see ``render_readme``. With ``append_readme`` the
    workshop's own README goes below it.
    """

    try:
        manifest = read_manifest(directory)
    except PublishError as error:
        raise GistError(str(error)) from error

    name = str(manifest.get("name") or "")
    pages = manifest.get("pages")

    if not name:
        raise GistError("The manifest has no name")

    if not isinstance(pages, list) or not all(isinstance(page, str) for page in pages):
        raise GistError("The manifest's pages must be a list of file names")

    if (directory / TREE_FILE).exists():
        raise GistError(f"{TREE_FILE} is the gist's own and cannot be a workshop file")

    if site:
        launcher_python = ""
    else:
        launcher_python, site = launcher_site(manifest, python)

    # The pages must be carried, so one that is missing, hidden or in an
    # excluded directory is an error rather than a broken gist.
    carried = _carried_files(directory)

    for page in pages:
        if PurePosixPath(page.strip()).as_posix() not in carried:
            raise GistError(
                f"Page {page} listed in workshop.yaml does not exist "
                "or would not be carried"
            )

    # Store each file under its flat name, as text when it is text.
    files: dict[str, str] = {}
    entries: list[TreeEntry] = []
    taken: dict[str, str] = {
        README_FILE.lower(): README_FILE,
        TREE_FILE.lower(): TREE_FILE,
    }

    for path in carried:
        data = (directory / path).read_bytes()

        if not data:
            entries.append(TreeEntry(path=path, empty=True))

            continue

        text = _as_text(data)
        flat = flat_name(path) if text is not None else flat_name(path) + BASE64_SUFFIX

        _claim(taken, flat, path)

        if text is not None:
            files[flat] = text
            entries.append(TreeEntry(path=path, name=flat))
        else:
            files[flat] = _wrapped_base64(data)
            entries.append(TreeEntry(path=path, name=flat, encoding=BASE64))

    files[TREE_FILE] = json.dumps(tree_document(entries), indent=2) + "\n"

    # The README is written for a gist that does not exist yet; creating
    # or updating one writes it again with the real address.
    extra = ""

    if append_readme and (directory / README_FILE).is_file():
        extra = (directory / README_FILE).read_text(encoding="utf-8")

    files[README_FILE] = render_readme(
        manifest, GIST_URL_PLACEHOLDER, site, extra, binder
    )

    carried_names = set(carried) | ({README_FILE} if extra else set())

    return FlatWorkshop(
        name=name,
        title=str(manifest.get("title") or name),
        description=str(manifest.get("description") or ""),
        files=files,
        renames={
            entry.path: entry.name
            for entry in entries
            if entry.name and entry.name != entry.path
        },
        left_out=_left_out(directory, carried_names),
        entries=entries,
        manifest=dict(manifest),
        site=site,
        python=launcher_python,
        readme_extra=extra,
        binder=binder,
    )


def launcher_site(manifest: Mapping[str, Any], python: str = "") -> tuple[str, str]:
    """The published launcher a workshop's launch button should open.

    ``python`` names the version outright and must be one that is
    published. Otherwise the manifest's Python tool requirement, when it
    carries a version, picks the newest published launcher that meets
    it, and a workshop that says nothing gets the newest. Returns the
    Python version and the site's URL.
    """

    if python:
        if python not in LAUNCHER_PYTHONS:
            raise GistError(
                f"No launcher is published for Python {python}; "
                f"the published ones are {', '.join(LAUNCHER_PYTHONS)}"
            )

        return python, LAUNCHER_SITE.format(python=python)

    requirement = _python_requirement(manifest)

    for candidate in LAUNCHER_PYTHONS:
        if not requirement or satisfies_version(candidate, requirement):
            return candidate, LAUNCHER_SITE.format(python=candidate)

    raise GistError(
        f"The workshop requires Python {requirement}, which no published "
        f"launcher provides; the published ones are {', '.join(LAUNCHER_PYTHONS)}"
    )


def _python_requirement(manifest: Mapping[str, Any]) -> str:
    requires = manifest.get("requires")
    tools = requires.get("tools") if isinstance(requires, dict) else None

    for tool in tools if isinstance(tools, list) else []:
        if isinstance(tool, dict) and tool.get("name") in PYTHON_TOOLS:
            frontends = tool.get("frontends")

            # A requirement scoped to JupyterLab alone says nothing about Lite.
            if isinstance(frontends, list) and "jupyterlite" not in frontends:
                continue

            return str(tool.get("version") or "")

    return ""


def render_readme(
    manifest: Mapping[str, Any],
    gist_url: str,
    site: str = DEFAULT_SITE,
    extra: str = "",
    binder: str = BINDER_LAUNCHER,
) -> str:
    """The gist's README: the workshop's details and how to open it.

    GitHub pins ``README.md`` to the top of a gist page, so this is what
    a visitor reads first. The JupyterLite launch button appears only
    when the manifest lists that frontend, since the button would not
    work otherwise. The Binder button opens the workshop in JupyterLab
    through the launcher repository ``binder``, and appears unless that
    is empty or the manifest rules the session out: frontends that leave
    out JupyterLab, or platforms that leave out Linux, which is what
    Binder runs. The JupyterLab route is always described. ``extra`` is
    the author's own README, appended under a rule.
    """

    name = str(manifest.get("name") or "")
    title = str(manifest.get("title") or name)
    description = str(manifest.get("description") or "").strip()
    lines = [f"# {title}", ""]

    if description:
        lines += [description, ""]

    details = [
        ("Version", _scalar(manifest.get("version"))),
        ("Authors", _listed(manifest.get("authors"))),
        ("Duration", _scalar(manifest.get("duration"))),
        ("Tags", _listed(manifest.get("tags"))),
        ("Platforms", _listed(manifest.get("platforms"))),
        ("Frontends", _listed(manifest.get("frontends"))),
    ]
    rows = [(label, value) for label, value in details if value]

    if rows:
        lines += ["| | |", "| --- | --- |"]
        lines += [f"| {label} | {value} |" for label, value in rows]
        lines.append("")

    lines += ["## Open this workshop", ""]

    if "jupyterlite" in _strings(manifest.get("frontends")):
        launch = f"{site}?reset&workshop={gist_url}&restart=force"

        lines += [
            f"[![Launch in JupyterLite]({LAUNCH_BADGE})]({launch})",
            "",
            "The button opens the workshop in JupyterLite, which runs in the "
            "browser with nothing to install.",
            "",
        ]

    if binder and _runs_on_binder(manifest):
        lines += [
            f"[![Launch on Binder]({BINDER_BADGE})]({binder_link(binder, gist_url)})",
            "",
            "The button opens the workshop in JupyterLab on "
            "[mybinder.org](https://mybinder.org), which starts a temporary "
            "session for you; it can take a minute or two to start.",
            "",
        ]

    lines += [
        "In a JupyterLab with the "
        f"[jupyterlab-workshop]({PROJECT_URL}) extension, choose "
        '"Workshop: Open Workshop from URL..." and give it this gist\'s address, '
        "or open a launch link with the address as the `workshop` parameter:",
        "",
        "```",
        f"https://<your-jupyterlab>/lab?workshop={gist_url}",
        "```",
        "",
        "On your own machine, with the extension installed:",
        "",
        "```",
        f"jupyter workshop launch {gist_url}",
        "```",
        "",
    ]

    links = [
        f"[{label}]({manifest[key]})"
        for key, label in (("homepage", "Homepage"), ("issues", "Issues"))
        if manifest.get(key)
    ]

    if links:
        lines += [" | ".join(links), ""]

    lines += [
        "A gist holds no directories, so the workshop's files are stored "
        f"under flat names, and `{TREE_FILE}` says where each one goes back "
        "when the workshop is downloaded. A file it does not list is left "
        "out, so republish with `jupyter workshop gist --update` rather "
        "than adding or renaming files here.",
        "",
    ]

    if extra.strip():
        lines += ["---", "", extra.strip(), ""]

    return "\n".join(lines)


def binder_link(binder: str, gist_url: str) -> str:
    """The link that opens a gist through a Binder launcher repository.

    mybinder's ``urlpath`` names the page JupyterLab opens once the
    session starts, so it carries the extension's launch link, encoded.
    """

    return f"{binder}?urlpath={quote(f'lab?workshop={gist_url}', safe='')}"


def _runs_on_binder(manifest: Mapping[str, Any]) -> bool:
    # No frontends listed means JupyterLab, and no platforms means any.
    frontends = _strings(manifest.get("frontends"))
    platforms = _strings(manifest.get("platforms"))

    return (not frontends or "jupyterlab" in frontends) and (
        not platforms or "linux" in platforms
    )


def write_flat(flat: FlatWorkshop, out: Path) -> Path:
    """Write the flat copy under ``out`` in a directory named after the workshop.

    An earlier flat copy there is replaced; anything else in the way is
    left alone and refused.
    """

    target = out / flat.name

    if target.exists():
        if not (target / MANIFEST_FILE).is_file():
            raise GistError(f"{target} exists and is not an earlier flat copy")

        shutil.rmtree(target)

    target.mkdir(parents=True)

    for name, text in flat.files.items():
        # Written as held, since the text keeps the workshop's own line
        # endings and translating them again would double a CRLF.
        (target / name).write_text(text, encoding="utf-8", newline="")

    return target


def gist_id(value: str) -> str:
    """The id in a gist URL, a revision permalink, or a bare id."""

    match = _GIST_URL.match(value.strip())

    if not match:
        raise GistError(f"{value} is not a gist URL or id")

    return match.group("id").lower()


def resolve_token(
    explicit: str = "",
    environ: Mapping[str, str] | None = None,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """A GitHub token: the one given, else from the environment, else from ``gh``.

    The environment variables are the ones the ``gh`` command reads, and
    ``gh auth token`` is the fallback for someone already signed in
    there. The token needs the ``gist`` scope.
    """

    if explicit:
        return explicit

    variables = os.environ if environ is None else environ

    for variable in TOKEN_VARIABLES:
        if variables.get(variable):
            return variables[variable]

    gh = shutil.which("gh")

    if gh:
        completed = run(
            [gh, "auth", "token"], capture_output=True, text=True, check=False
        )

        if completed.returncode == 0 and completed.stdout.strip():
            return completed.stdout.strip()

    raise GistError(
        "No GitHub token: pass --token, set GH_TOKEN or GITHUB_TOKEN, "
        "or sign in with gh auth login"
    )


def github_request(
    method: str, url: str, body: Mapping[str, Any] | None, token: str
) -> dict[str, Any]:
    """Send one request to the GitHub API and return its JSON reply."""

    data = json.dumps(body).encode() if body is not None else None
    request = Request(url, data=data, method=method)

    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("X-GitHub-Api-Version", API_VERSION)
    request.add_header("User-Agent", USER_AGENT)

    if data is not None:
        request.add_header("Content-Type", "application/json")

    try:
        with urlopen(request, timeout=API_TIMEOUT) as response:
            reply = json.loads(response.read().decode())
    except HTTPError as error:
        detail = _error_message(error)

        raise GistError(
            f"GitHub replied {error.code} to {method} {url}: {detail}"
        ) from error
    except URLError as error:
        raise GistError(f"Could not reach {url}: {error.reason}") from error

    if not isinstance(reply, dict):
        raise GistError(f"Unexpected reply from {method} {url}")

    return reply


def create_gist(
    flat: FlatWorkshop,
    token: str,
    public: bool = False,
    request: Requester = github_request,
) -> GistResult:
    """Create a gist holding the flat copy; secret unless ``public``.

    The README names the gist's own address, which is only known once
    the gist exists, so it is written a second time after creation.
    """

    reply = request(
        "POST",
        f"{API_URL}/gists",
        {
            "description": _description(flat),
            "public": public,
            "files": {name: {"content": text} for name, text in flat.files.items()},
        },
        token,
    )
    identifier = str(reply.get("id", ""))
    url = str(reply.get("html_url", ""))

    if url:
        readme = flat.with_gist_url(url).files[README_FILE]

        request(
            "PATCH",
            f"{API_URL}/gists/{identifier}",
            {"files": {README_FILE: {"content": readme}}},
            token,
        )

    return GistResult(id=identifier, url=url, created=True)


def update_gist(
    gist: str, flat: FlatWorkshop, token: str, request: Requester = github_request
) -> GistResult:
    """Replace the files of an existing gist with the flat copy.

    Files the gist holds that the flat copy does not are removed, so the
    gist ends up as a fresh creation would.
    """

    identifier = gist_id(gist)
    existing = request("GET", f"{API_URL}/gists/{identifier}", None, token)
    url = str(existing.get("html_url", "")) or f"https://gist.github.com/{identifier}"
    files: dict[str, Any] = {
        name: {"content": text} for name, text in flat.with_gist_url(url).files.items()
    }

    for name in existing.get("files") or {}:
        if name not in files:
            files[name] = None

    reply = request(
        "PATCH",
        f"{API_URL}/gists/{identifier}",
        {"description": _description(flat), "files": files},
        token,
    )

    return GistResult(
        id=identifier, url=str(reply.get("html_url", "")) or url, created=False
    )


def _description(flat: FlatWorkshop) -> str:
    return f"{flat.title}: {flat.description}" if flat.description else flat.title


def _scalar(value: object) -> str:
    return str(value).strip() if isinstance(value, (str, int, float)) else ""


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []

    return [str(item) for item in value if isinstance(item, (str, int, float))]


def _listed(value: object) -> str:
    return ", ".join(_strings(value))


def _carried_files(directory: Path) -> list[str]:
    # What the publish archive would hold, less what a gist should not.
    carried: list[str] = []

    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        posix = relative.as_posix()

        if _skipped(relative) or path.is_symlink() or not path.is_file():
            continue

        if posix == README_FILE:
            continue

        carried.append(posix)

    return carried


def _skipped(relative: PurePosixPath | Path) -> bool:
    parts = relative.parts

    if parts[0] in PUBLISH_EXCLUDES or parts[0] == WORKSPACE_DIR:
        return True

    if any(part.startswith(".") for part in parts):
        return True

    return relative.name in DROPPINGS or relative.name.endswith("~")


def _left_out(directory: Path, carried: set[str]) -> list[str]:
    # Reported so the author sees what the gist will not have; the
    # excluded directories and hidden files are left out silently.
    left: list[str] = []

    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        posix = relative.as_posix()

        if not path.is_file() or _skipped(relative):
            continue

        if posix not in carried:
            left.append(posix)

    return left


def _as_text(data: bytes) -> str | None:
    # Text the gists API can carry: UTF-8 without NULs, and not blank,
    # since the API refuses a file holding only white space.
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None

    if "\x00" in text or not text.strip():
        return None

    return text


def _wrapped_base64(data: bytes) -> str:
    encoded = base64.b64encode(data).decode("ascii")

    return "\n".join(textwrap.wrap(encoded, BASE64_WIDTH)) + "\n"


def _claim(taken: dict[str, str], flat: str, path: str) -> None:
    # Gist file names are compared without case, as GitHub and a
    # checkout on macOS or Windows would.
    folded = flat.lower()

    if folded in taken:
        other = taken[folded]

        if other in (README_FILE, TREE_FILE):
            raise GistError(
                f"{path} would be named {flat}, which the gist has its own of"
            )

        raise GistError(f"{path} and {other} would both be named {flat} in the gist")

    if folded.startswith(RESERVED_PREFIX):
        raise GistError(
            f"{path} would be named {flat}, and GitHub reserves names "
            f'starting with "{RESERVED_PREFIX}"'
        )

    taken[folded] = path


def _error_message(error: HTTPError) -> str:
    try:
        payload = json.loads(error.read().decode())
    except (OSError, ValueError):
        return error.reason if isinstance(error.reason, str) else str(error.reason)

    if isinstance(payload, dict) and payload.get("message"):
        return str(payload["message"])

    return str(error.reason)
