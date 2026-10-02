"""Publishing a workshop as a GitHub gist.

A gist is a git repository that holds no directories, so a workshop is
laid out flat before it goes in: every file keeps its name with the
directory separators turned into ``--``, so ``pages/01-welcome.md``
becomes ``pages--01-welcome.md``, and the manifest and the directive
options that name those files are rewritten to match. Only what the
workshop needs at run time rides along: the manifest, the pages, the
files the pages refer to and the requirements file. The flat copy is
written to a directory and, when asked, sent to GitHub through the gists
API, which carries text files only.
"""

from __future__ import annotations

import copy
import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import yaml

from .fetch import USER_AGENT
from .publish import PUBLISH_EXCLUDES, WORKSPACE_DIR, PublishError, read_manifest

MANIFEST_FILE = "workshop.yaml"

#: Starter files copied into the workspace when the workshop opens.
FILES_DIR = "files"

#: Stands in for the directory separator in a gist file name.
SEPARATOR = "--"

#: GitHub names a file it was not given a name for `gistfile<n>`.
RESERVED_PREFIX = "gistfile"

API_URL = "https://api.github.com"

API_VERSION = "2022-11-28"

#: Environment variables a token is read from, in order, as `gh` reads them.
TOKEN_VARIABLES = ("GH_TOKEN", "GITHUB_TOKEN")

#: Directive options whose value may name a file shipped with the workshop.
FILE_OPTIONS = ("from", "script", "path")

#: How long one API call may take.
API_TIMEOUT = 60

#: Sends one API request: method, URL, JSON body and token, to a JSON reply.
Requester = Callable[[str, str, Mapping[str, Any] | None, str], dict[str, Any]]

_OPTION_LINE = re.compile(
    r"^(?P<lead>\s*:(?P<name>[a-z-]+):[ \t]*)(?P<value>\S.*?)(?P<tail>\s*)$"
)

# The manifest lines a file name is replaced on: list items, for the
# pages, and the requirements setting; prose elsewhere is left alone.
_MANIFEST_FILE_LINE = re.compile(r"^\s*(?:-\s|pages:|requirements:)")

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

    #: Gist file name to content, the manifest included.
    files: dict[str, str]

    #: Workshop path to gist file name, for the files whose name changed.
    renames: dict[str, str]

    #: Files in the workshop directory that are not carried.
    left_out: list[str]


@dataclass(frozen=True)
class GistResult:
    """What creating or updating a gist produced."""

    id: str
    url: str
    created: bool


def flat_name(path: str) -> str:
    """The gist file name for a workshop-relative path.

    Directory separators become ``--``, which keeps the origin of a file
    visible and the mapping reversible, so a path that already contains
    ``--`` is refused, as is a name GitHub reserves.
    """

    parts = PurePosixPath(path).parts

    if any(SEPARATOR in part for part in parts):
        raise GistError(
            f'{path} contains "{SEPARATOR}", which stands for a directory '
            "separator in a gist file name"
        )

    name = SEPARATOR.join(parts)

    if name.lower().startswith(RESERVED_PREFIX):
        raise GistError(
            f"{path} would be named {name}, and GitHub reserves names "
            f'starting with "{RESERVED_PREFIX}"'
        )

    return name


def flatten_workshop(directory: Path, referenced: Sequence[str] = ()) -> FlatWorkshop:
    """Lay a workshop out flat.

    ``referenced`` lists the workshop-relative paths the pages name in
    their directive options, as the core package's ``referencedFiles``
    reports them; those that exist are carried and their options
    rewritten. The manifest, the pages and the requirements file are
    always carried. Starter files under ``files/`` cannot be, since they
    are copied into the workspace as a directory, so a workshop that has
    any is refused, as is a binary file, which the gists API cannot hold.
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

    _refuse_starter_files(directory)

    # Which files ride along: the pages, which must exist, then whatever
    # the pages and the manifest refer to that does, in a stable order.
    carried: list[str] = []
    requirements = _requirements_file(manifest)

    for path in [*pages, *referenced, *requirements]:
        clean = _clean_path(path)

        if not clean:
            continue

        file = directory / clean

        if path in pages and not file.is_file():
            raise GistError(f"Page {path} listed in workshop.yaml does not exist")

        if file.is_file() and clean not in carried:
            carried.append(clean)

    # Flat names must be distinct from each other and from the manifest.
    names: dict[str, str] = {}

    for path in carried:
        flat = flat_name(path)
        clash = next((other for other, taken in names.items() if taken == flat), None)

        if clash is not None:
            raise GistError(
                f"{path} and {clash} would both be named {flat} in the gist"
            )

        if flat == MANIFEST_FILE:
            raise GistError(
                f"{path} would be named {MANIFEST_FILE}, which is the manifest"
            )

        names[path] = flat

    renames = {path: flat for path, flat in names.items() if path != flat}

    # Read every file as text, rewriting the options that name a renamed
    # file as they go, and the manifest last.
    files: dict[str, str] = {}

    for path, flat in names.items():
        text = _read_text(directory, path)

        if path in pages:
            text = rewrite_options(text, renames)

        files[flat] = text

    files[MANIFEST_FILE] = rewrite_manifest(
        _read_text(directory, MANIFEST_FILE), manifest, renames
    )

    return FlatWorkshop(
        name=name,
        title=str(manifest.get("title") or name),
        description=str(manifest.get("description") or ""),
        files=files,
        renames=renames,
        left_out=_left_out(directory, set(names)),
    )


def rewrite_options(text: str, renames: Mapping[str, str]) -> str:
    """Rename the files that a page's directive options point at.

    Only an option line whose whole value is one of the renamed paths
    changes, so prose and other options are left as they are.
    """

    if not renames:
        return text

    lines = text.split("\n")

    for index, line in enumerate(lines):
        match = _OPTION_LINE.match(line)

        if not match or match.group("name") not in FILE_OPTIONS:
            continue

        value = _clean_path(match.group("value"))

        if value in renames:
            lines[index] = match.group("lead") + renames[value] + match.group("tail")

    return "\n".join(lines)


def rewrite_manifest(
    source: str, manifest: Mapping[str, Any], renames: Mapping[str, str]
) -> str:
    """Rename the files the manifest lists, keeping its comments and layout.

    The paths are replaced in the text rather than by writing the YAML
    back out, which would lose comments and ordering, and only on the
    lines that list files, so prose that mentions a page is left alone.
    The result is parsed and compared with what the rewrite should have
    produced, so a replacement that touched anything else is refused
    rather than published.
    """

    if not renames:
        return source

    patterns = {
        re.compile(r"(?<![\w./-])" + re.escape(old) + r"(?![\w./-])"): new
        for old, new in renames.items()
    }
    lines = source.split("\n")

    for index, line in enumerate(lines):
        if not _MANIFEST_FILE_LINE.match(line):
            continue

        for pattern, new in patterns.items():
            line = pattern.sub(new.replace("\\", r"\\"), line)

        lines[index] = line

    text = "\n".join(lines)

    expected: dict[str, Any] = copy.deepcopy(dict(manifest))
    expected["pages"] = [renames.get(page, page) for page in manifest["pages"]]

    for path in _requirements_file(manifest):
        expected["environment"]["requirements"] = renames.get(path, path)

    try:
        parsed = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise GistError(f"workshop.yaml could not be rewritten: {error}") from error

    if parsed != expected:
        raise GistError(
            "workshop.yaml could not be rewritten for the flat layout without "
            "changing something other than the file names; rename them by hand"
        )

    return text


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
        (target / name).write_text(text, encoding="utf-8")

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
    """Create a gist holding the flat copy; secret unless ``public``."""

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

    return GistResult(
        id=str(reply.get("id", "")),
        url=str(reply.get("html_url", "")),
        created=True,
    )


def update_gist(
    gist: str, flat: FlatWorkshop, token: str, request: Requester = github_request
) -> GistResult:
    """Replace the files of an existing gist with the flat copy.

    Files the gist holds that the flat copy does not are removed, so the
    gist ends up as a fresh creation would.
    """

    identifier = gist_id(gist)
    existing = request("GET", f"{API_URL}/gists/{identifier}", None, token)
    files: dict[str, Any] = {
        name: {"content": text} for name, text in flat.files.items()
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

    return GistResult(id=identifier, url=str(reply.get("html_url", "")), created=False)


def _description(flat: FlatWorkshop) -> str:
    return f"{flat.title}: {flat.description}" if flat.description else flat.title


def _refuse_starter_files(directory: Path) -> None:
    files_dir = directory / FILES_DIR

    if not files_dir.is_dir():
        return

    starters = [
        path
        for path in files_dir.rglob("*")
        if path.is_file() and path.name != ".gitkeep"
    ]

    if starters:
        raise GistError(
            f"{FILES_DIR}/ holds starter files, which are copied into the workspace "
            "as a directory when the workshop opens; a gist has no directories"
        )


def _requirements_file(manifest: Mapping[str, Any]) -> list[str]:
    environment = manifest.get("environment")

    if not isinstance(environment, dict):
        return []

    requirements = environment.get("requirements")

    return [requirements] if isinstance(requirements, str) else []

    return []


def _clean_path(value: str) -> str:
    cleaned = value.strip().replace("\\", "/").strip("/")

    if not cleaned or cleaned.startswith("..") or "/.." in cleaned:
        return ""

    return str(PurePosixPath(cleaned))


def _read_text(directory: Path, path: str) -> str:
    try:
        text = (directory / path).read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise GistError(
            f"{path} is not a text file; the gists API holds text only"
        ) from error

    if "\x00" in text:
        raise GistError(f"{path} is not a text file; the gists API holds text only")

    return text


def _left_out(directory: Path, carried: set[str]) -> list[str]:
    skipped = PUBLISH_EXCLUDES | {WORKSPACE_DIR, FILES_DIR}
    left: list[str] = []

    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)

        if not path.is_file() or relative.parts[0] in skipped:
            continue

        if relative.name.startswith(".") or relative.parts[0].startswith("."):
            continue

        posix = relative.as_posix()

        if posix != MANIFEST_FILE and posix not in carried:
            left.append(posix)

    return left


def _error_message(error: HTTPError) -> str:
    try:
        payload = json.loads(error.read().decode())
    except (OSError, ValueError):
        return error.reason if isinstance(error.reason, str) else str(error.reason)

    if isinstance(payload, dict) and payload.get("message"):
        return str(payload["message"])

    return str(error.reason)
