"""Fetch workshops from git forges and archive URLs into the server's root.

A workshop source is either a git repository on a forge that offers archive
downloads (GitHub, GitLab, Codeberg and Gitea) or a direct URL to a ``.zip``
or ``.tar.gz`` archive. The archive is downloaded, hashed, unpacked with
path traversal guarded, and recorded in ``_workshop/source.json`` so the
frontend can identify the workshop later.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import yaml

MANIFEST_FILE = "workshop.yaml"

STATE_DIR = "_workshop"

SOURCE_FILE = "source.json"

DEFAULT_REF = "HEAD"

USER_AGENT = "jupyterlab-workshop"

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

Downloader = Callable[[str], bytes]


class FetchError(Exception):
    """A workshop could not be fetched or unpacked."""


@dataclass(frozen=True)
class Source:
    """Where a workshop comes from."""

    kind: str
    url: str
    ref: str = ""
    subdir: str = ""
    sha256: str = ""

    def key(self) -> str:
        """A stable identifier for trust decisions."""

        if self.kind == "git":
            suffix = f"@{self.ref}" if self.ref else ""
            path = f"/{self.subdir}" if self.subdir else ""

            return f"git:{self.url}{suffix}{path}"

        return f"{self.kind}:{self.url}"

    def to_dict(self) -> dict[str, str]:
        """A JSON friendly form."""

        return {key: value for key, value in asdict(self).items() if value}


@dataclass(frozen=True)
class FetchResult:
    """What a fetch produced."""

    path: str
    name: str
    sha256: str
    source: Source

    def to_dict(self) -> dict[str, Any]:
        """A JSON friendly form."""

        return {
            "path": self.path,
            "name": self.name,
            "sha256": self.sha256,
            "source": self.source.to_dict(),
        }


_FORGE_TREE = re.compile(
    r"^(?P<base>https://(?P<host>[^/]+)/(?P<owner>[^/]+)/(?P<repo>[^/]+?))"
    r"(?:\.git)?"
    r"(?:/(?:tree|src/branch|-/tree)/(?P<ref>[^/]+)(?:/(?P<subdir>.+?))?)?/?$"
)

_ARCHIVE_SUFFIXES = (".zip", ".tar.gz", ".tgz", ".tar")


def parse_source(spec: dict[str, Any]) -> Source:
    """Turn a request body into a source.

    The body carries either ``git`` (a repository URL, optionally with
    ``ref`` and ``subdir``) or ``archive`` (a direct archive URL, optionally
    with ``sha256``). A bare ``url`` is classified by its suffix: archive
    extensions are archives and everything else is a git repository, with a
    forge ``/tree/<ref>/<subdir>`` path providing the ref and directory.
    """

    if not isinstance(spec, dict):
        raise FetchError("The source must be a mapping")

    sha256 = str(spec.get("sha256") or "").lower()

    if spec.get("archive"):
        return Source(
            kind="archive", url=_clean_url(str(spec["archive"])), sha256=sha256
        )

    url = str(spec.get("git") or spec.get("url") or "")

    if not url:
        raise FetchError("The source needs a git or archive URL")

    url = _clean_url(url)

    if not spec.get("git") and url.lower().endswith(_ARCHIVE_SUFFIXES):
        return Source(kind="archive", url=url, sha256=sha256)

    ref = str(spec.get("ref") or "")
    subdir = _clean_subdir(str(spec.get("subdir") or ""))

    match = _FORGE_TREE.match(url)

    if match:
        url = match.group("base")
        ref = ref or (match.group("ref") or "")
        subdir = subdir or _clean_subdir(match.group("subdir") or "")

    return Source(kind="git", url=url, ref=ref, subdir=subdir, sha256=sha256)


def archive_url(source: Source) -> str:
    """The URL of the archive to download for a source."""

    if source.kind == "archive":
        return source.url

    parts = urlsplit(source.url)
    host = parts.netloc.lower()
    path = parts.path.strip("/")

    if path.endswith(".git"):
        path = path[:-4]

    segments = path.split("/")

    if len(segments) < 2 or not all(segments[:2]):
        raise FetchError(f"Cannot work out the repository from {source.url}")

    owner, repo = segments[0], segments[1]
    ref = source.ref or DEFAULT_REF

    if host == "github.com" or host.endswith(".github.com"):
        return f"https://{host}/{owner}/{repo}/archive/{ref}.tar.gz"

    # GitLab projects can sit in nested groups, so the whole path is the
    # project and the archive is named after its last segment.
    if host == "gitlab.com" or host.startswith("gitlab."):
        project = "/".join(segments)
        last = segments[-1]

        return f"https://{host}/{project}/-/archive/{ref}/{last}-{ref}.tar.gz"

    # Codeberg, Gitea and Forgejo share the Gitea archive layout, as does
    # anything else we do not recognise; it is the most common convention.
    return f"https://{host}/{owner}/{repo}/archive/{ref}.tar.gz"


def download(url: str, limit: int = MAX_ARCHIVE_BYTES) -> bytes:
    """Download a URL, refusing anything other than http and https."""

    scheme = urlsplit(url).scheme.lower()

    if scheme not in {"http", "https"}:
        raise FetchError(f"Refusing to download from a {scheme or 'relative'} URL")

    request = Request(url, headers={"User-Agent": USER_AGENT})

    try:
        with urlopen(request, timeout=60) as response:
            data: bytes = response.read(limit + 1)
    except OSError as error:
        raise FetchError(f"Unable to download {url}: {error}") from error

    if len(data) > limit:
        raise FetchError(f"The download from {url} is larger than the limit")

    return data


def fetch_workshop(
    source: Source,
    root_dir: Path,
    directory: str,
    name: str = "",
    overwrite: bool = False,
    downloader: Downloader | None = None,
    collection: str = "",
) -> FetchResult:
    """Download and unpack a workshop under ``root_dir/directory``.

    The workshop lands in a directory named after the manifest's ``name``
    (or ``name`` when given). An existing directory is refused unless
    ``overwrite`` is set. The ``collection`` the workshop was chosen from,
    when given, is recorded with the source so the browser can match the
    install to its entry later. The returned path is relative to
    ``root_dir`` with forward slashes, as the contents API expects.
    """

    parent = _resolve_inside(root_dir, directory)
    url = archive_url(source)

    # Looked up at call time so tests can substitute the downloader.
    data = (downloader or download)(url)
    digest = hashlib.sha256(data).hexdigest()

    if source.sha256 and source.sha256 != digest:
        raise FetchError(
            f"The archive's sha256 {digest} does not match the expected {source.sha256}"
        )

    with tempfile.TemporaryDirectory(
        prefix="workshop-", dir=_temp_parent(parent)
    ) as tmp:
        staging = Path(tmp) / "unpacked"

        unpack_archive(data, url, staging, source.subdir)

        manifest_name = read_manifest_name(staging / MANIFEST_FILE)
        target_name = _check_name(name or manifest_name)
        target = parent / target_name

        if target.exists():
            if not overwrite:
                raise FetchError(f"{_relative(root_dir, target)} already exists")

            remove_tree(target)

        parent.mkdir(parents=True, exist_ok=True)

        fetched = Source(
            kind=source.kind,
            url=source.url,
            ref=source.ref,
            subdir=source.subdir,
            sha256=digest,
        )

        _write_source_file(staging, fetched, url, collection)
        shutil.move(str(staging), str(target))

    return FetchResult(
        path=_relative(root_dir, target),
        name=target_name,
        sha256=digest,
        source=fetched,
    )


def unpack_archive(data: bytes, url: str, destination: Path, subdir: str = "") -> None:
    """Unpack a zip or tar archive into ``destination``.

    A single top-level directory, as produced by forge archives, is
    stripped. Members that would land outside the destination, and links,
    are refused. When ``subdir`` is given only that directory is kept.
    """

    entries = _read_members(data, url)

    if not entries:
        raise FetchError("The archive is empty")

    prefix = _common_prefix(entries)
    wanted = PurePosixPath(subdir) if subdir else None
    written = 0

    for member, content in entries:
        path = PurePosixPath(member)

        if prefix:
            path = path.relative_to(prefix)

        if wanted is not None:
            if not _is_within(path, wanted):
                continue

            path = path.relative_to(wanted)

        if not path.parts:
            continue

        target = destination / Path(*path.parts)

        if content is None:
            target.mkdir(parents=True, exist_ok=True)

            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        written += 1

    if subdir and written == 0:
        raise FetchError(f"The archive has no directory named {subdir}")

    if not (destination / MANIFEST_FILE).is_file():
        raise FetchError(
            f"The archive does not contain a {MANIFEST_FILE}"
            + (f" in {subdir}" if subdir else "")
        )


def read_manifest_name(path: Path) -> str:
    """The ``name`` field of a manifest file."""

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise FetchError(f"Unable to read {MANIFEST_FILE}: {error}") from error

    name = data.get("name") if isinstance(data, dict) else None

    if not isinstance(name, str) or not name:
        raise FetchError(f"The {MANIFEST_FILE} has no name")

    return name


def remove_tree(path: Path) -> None:
    """Remove a directory tree, coping with what Windows refuses.

    Git marks its object files read-only, and Windows will not delete a
    read-only file, so a failed removal clears the attribute and tries
    again. Windows also refuses to remove a directory that is the working
    directory of a running process, such as a terminal that has changed
    into it; when that is the tree's own top directory it is left behind
    empty, which a caller that refills or ignores it can live with.
    """

    def retry(
        function: Callable[[str], Any], failing: str, error: BaseException
    ) -> None:
        target = Path(failing)

        if isinstance(error, PermissionError) and target.exists():
            target.chmod(stat.S_IRWXU)

            try:
                function(failing)

                return
            except PermissionError:
                pass

        if target == path and target.is_dir() and not any(target.iterdir()):
            return

        raise error

    shutil.rmtree(path, onexc=retry)


def remove_workshop(root_dir: Path, path: str) -> str:
    """Delete a workshop directory under the server root.

    Only directories holding a manifest are removed, so a wrong path cannot
    take out something else. Returns the removed path relative to the root.
    """

    target = _resolve_inside(root_dir, path)

    if target == root_dir.resolve():
        raise FetchError("Refusing to remove the server root directory")

    if not target.is_dir():
        raise FetchError(f"{path} is not a directory")

    if not (target / MANIFEST_FILE).is_file():
        raise FetchError(f"{path} is not a workshop directory")

    remove_tree(target)

    return _relative(root_dir, target)


def _read_members(data: bytes, url: str) -> list[tuple[str, bytes | None]]:
    # Each member is (posix path, content or None for a directory).
    stream = io.BytesIO(data)

    if zipfile.is_zipfile(stream):
        return _read_zip(stream)

    stream.seek(0)

    try:
        with tarfile.open(fileobj=stream, mode="r:*") as archive:
            return _read_tar(archive)
    except tarfile.TarError as error:
        raise FetchError(f"{url} is not a zip or tar archive: {error}") from error


def _read_zip(stream: io.BytesIO) -> list[tuple[str, bytes | None]]:
    entries: list[tuple[str, bytes | None]] = []

    with zipfile.ZipFile(stream) as archive:
        for info in archive.infolist():
            name = _safe_member_name(info.filename)

            if name is None:
                continue

            # Symbolic links carry the link type in the external attributes.
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                continue

            if info.is_dir():
                entries.append((name, None))
            else:
                entries.append((name, archive.read(info)))

    return entries


def _read_tar(archive: tarfile.TarFile) -> list[tuple[str, bytes | None]]:
    entries: list[tuple[str, bytes | None]] = []

    for member in archive.getmembers():
        name = _safe_member_name(member.name)

        if name is None:
            continue

        if member.isdir():
            entries.append((name, None))
        elif member.isfile():
            extracted = archive.extractfile(member)

            entries.append((name, extracted.read() if extracted else b""))

    return entries


def _safe_member_name(name: str) -> str | None:
    # Normalise separators and refuse anything that escapes the archive,
    # including absolute paths, which no honest archive contains.
    if name.startswith(("/", "\\")):
        return None

    posix = name.replace("\\", "/").strip("/")

    if not posix:
        return None

    parts = posix.split("/")

    if any(part in {"", ".", ".."} for part in parts):
        return None

    if re.match(r"^[A-Za-z]:", posix):
        return None

    return posix


def _common_prefix(entries: list[tuple[str, bytes | None]]) -> PurePosixPath | None:
    # Forge archives wrap everything in `<repo>-<ref>/`; strip that layer
    # when every member sits inside it.
    first_parts = {PurePosixPath(name).parts[0] for name, _ in entries}

    if len(first_parts) != 1:
        return None

    top = first_parts.pop()

    if any(
        len(PurePosixPath(name).parts) == 1 and content is not None
        for name, content in entries
    ):
        return None

    return PurePosixPath(top)


def _is_within(path: PurePosixPath, parent: PurePosixPath) -> bool:
    return path.parts[: len(parent.parts)] == parent.parts


def _clean_url(url: str) -> str:
    cleaned = url.strip()

    if not cleaned:
        raise FetchError("The source URL is empty")

    scheme = urlsplit(cleaned).scheme.lower()

    if scheme not in {"http", "https"}:
        raise FetchError("Only http and https sources are supported")

    return cleaned


def _clean_subdir(subdir: str) -> str:
    parts = [part for part in subdir.replace("\\", "/").split("/") if part]

    if any(part in {".", ".."} for part in parts):
        raise FetchError("The subdirectory must not contain . or .. components")

    return "/".join(parts)


def _check_name(name: str) -> str:
    if not re.match(r"^[a-z0-9][a-z0-9-]*$", name):
        raise FetchError(
            f'Invalid workshop name "{name}": '
            "use lower case letters, digits and hyphens"
        )

    return name


def _resolve_inside(root_dir: Path, relative: str) -> Path:
    root = root_dir.resolve()
    parts = [part for part in relative.replace("\\", "/").split("/") if part]

    if any(part == ".." for part in parts):
        raise FetchError(f"{relative} is outside the server root directory")

    target = root.joinpath(*parts).resolve() if parts else root

    if target != root and root not in target.parents:
        raise FetchError(f"{relative} is outside the server root directory")

    return target


def _relative(root_dir: Path, target: Path) -> str:
    return target.resolve().relative_to(root_dir.resolve()).as_posix()


def _temp_parent(parent: Path) -> str | None:
    # Staging next to the destination keeps the final move on one file
    # system; fall back to the system temporary directory before it exists.
    return str(parent) if parent.is_dir() else None


def _write_source_file(
    staging: Path, source: Source, url: str, collection: str = ""
) -> None:
    state_dir = staging / STATE_DIR

    state_dir.mkdir(parents=True, exist_ok=True)

    record: dict[str, Any] = {
        "version": 1,
        "source": source.to_dict(),
        "archive": url,
        "sha256": source.sha256,
        "fetchedAt": datetime.now(UTC).isoformat(timespec="seconds"),
    }

    if collection:
        record["collection"] = collection

    (state_dir / SOURCE_FILE).write_text(
        json.dumps(record, indent=2) + os.linesep, encoding="utf-8"
    )
