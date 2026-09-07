"""Catalogs: published lists of collections.

A catalog is a JSON file, ``catalog.json`` by convention, naming
collections by the location of their index and restating each one's
title, description, publisher and icon, so a browser can show what is on
offer without reading every index. A collection's location may be
relative to the catalog file, which lets one repository hold a catalog
and its collections. The ``jupyter workshop catalog`` command builds and
refreshes catalogs from the collections themselves, so the restated
metadata does not drift.
"""

from __future__ import annotations

import json
import posixpath
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from .collection import (
    MAX_INDEX_BYTES,
    CollectionError,
    collection_metadata,
    load_collection,
)
from .fetch import Downloader, FetchError, _resolve_inside, download

CATALOG_VERSION = 1

#: The file name a catalog is published under by convention.
CATALOG_FILE = "catalog.json"


class CatalogError(Exception):
    """A catalog could not be read or built."""


@dataclass(frozen=True)
class CatalogMetadata:
    """The descriptive fields of a catalog an author can set.

    An empty value leaves what the existing catalog says.
    """

    title: str = ""
    description: str = ""
    publisher: str = ""
    publisher_url: str = ""
    homepage: str = ""
    icon: str = ""

    def apply(self, catalog: dict[str, Any], existing: dict[str, Any] | None) -> None:
        """Write the metadata into ``catalog``, keeping ``existing`` values."""

        previous = existing or {}

        for key in ("title", "description", "homepage", "icon"):
            value = getattr(self, key) or previous.get(key)

            if value:
                catalog[key] = value

        publisher: Any = previous.get("publisher")

        if self.publisher:
            publisher = {"name": self.publisher}

            if self.publisher_url:
                publisher["url"] = self.publisher_url
        elif self.publisher_url and isinstance(publisher, dict):
            publisher = {**publisher, "url": self.publisher_url}

        if publisher:
            catalog["publisher"] = publisher


def is_http_url(location: str) -> bool:
    """Whether a location is an absolute http(s) URL rather than a path."""

    return urlsplit(location).scheme.lower() in {"http", "https"}


def resolve_location(base: str, target: str) -> str:
    """Resolve a location found inside a catalog against the catalog's own.

    An absolute URL or a ``data:`` URI is returned as is. Anything else is
    relative to the directory holding the catalog, whether that is a URL
    or a path under the server root.
    """

    if is_http_url(target) or target.lower().startswith("data:"):
        return target

    if is_http_url(base):
        return urljoin(base, target)

    directory = posixpath.dirname(base)
    joined = posixpath.normpath(
        posixpath.join(directory, target) if directory else target
    )

    return "" if joined == "." else joined


def load_catalog(
    location: str, root_dir: Path, downloader: Downloader | None = None
) -> dict[str, Any]:
    """Read a catalog from a URL or a path under the server root.

    The collection locations and icons in the result are resolved against
    the catalog's location, so a reader need not know where it came from.
    """

    scheme = urlsplit(location).scheme.lower()

    if scheme in {"http", "https"}:
        try:
            data = (downloader or download)(location)
        except FetchError as error:
            raise CatalogError(str(error)) from error

        if len(data) > MAX_INDEX_BYTES:
            raise CatalogError(f"The catalog at {location} is larger than the limit")

        text = data.decode("utf-8", errors="replace")
    elif scheme:
        raise CatalogError(f"Unsupported catalog location {location}")
    else:
        try:
            path = _resolve_inside(root_dir, location)
        except FetchError as error:
            raise CatalogError(str(error)) from error

        if not path.is_file():
            raise CatalogError(f"There is no catalog file at {location}")

        text = path.read_text(encoding="utf-8")

    return resolve_catalog(parse_catalog(text, location), location)


def parse_catalog(text: str, location: str = "catalog") -> dict[str, Any]:
    """Parse the JSON text of a catalog and check its version and shape."""

    try:
        data = json.loads(text)
    except ValueError as error:
        raise CatalogError(f"{location} is not valid JSON: {error}") from error

    if not isinstance(data, dict):
        raise CatalogError(f"{location} must contain a JSON object")

    if data.get("version") != CATALOG_VERSION:
        raise CatalogError(
            f"{location} has catalog version {data.get('version')!r}; "
            f"expected {CATALOG_VERSION}"
        )

    collections = data.get("collections")

    if not isinstance(collections, list) or not all(
        isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"]
        for item in collections
    ):
        raise CatalogError(f"{location} needs a list of collections, each with a url")

    return data


def resolve_catalog(catalog: dict[str, Any], location: str) -> dict[str, Any]:
    """A copy of a catalog with its relative locations resolved."""

    resolved = dict(catalog)

    if isinstance(catalog.get("icon"), str) and catalog["icon"]:
        resolved["icon"] = resolve_location(location, catalog["icon"])

    entries = []

    for item in catalog.get("collections", []):
        entry = dict(item)

        entry["url"] = resolve_location(location, str(item["url"]))

        if isinstance(item.get("icon"), str) and item["icon"]:
            entry["icon"] = resolve_location(location, item["icon"])

        entries.append(entry)

    resolved["collections"] = entries

    return resolved


def catalog_entry(url: str, index: dict[str, Any]) -> dict[str, Any]:
    """The catalog entry for a collection, restating the index's metadata."""

    return {"url": url, **collection_metadata(index)}


def build_catalog(
    existing: dict[str, Any] | None,
    entries: Iterable[dict[str, Any]],
    metadata: CatalogMetadata | None = None,
) -> dict[str, Any]:
    """Merge collection entries into a catalog, replacing entries by URL.

    The order of the catalog is kept: an entry already listed is updated
    in place and a new one is appended.
    """

    collections: list[dict[str, Any]] = [
        dict(item)
        for item in (existing or {}).get("collections", [])
        if isinstance(item, dict) and isinstance(item.get("url"), str)
    ]
    positions = {item["url"]: index for index, item in enumerate(collections)}

    for entry in entries:
        url = str(entry.get("url") or "")

        if not url:
            raise CatalogError("Each catalog entry needs a url")

        position = positions.get(url)

        if position is None:
            positions[url] = len(collections)
            collections.append(dict(entry))
        else:
            collections[position] = {**collections[position], **entry}

    catalog: dict[str, Any] = {"version": CATALOG_VERSION}

    (metadata or CatalogMetadata()).apply(catalog, existing)
    catalog["collections"] = collections

    return catalog


def refresh_entries(
    catalog_path: Path,
    locations: Iterable[str],
    relative: bool = False,
    loader: Callable[[str], dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Read each collection and make its catalog entry.

    A location is a URL, or a path on disk; a path is recorded relative
    to the catalog file when ``relative`` is set and otherwise as given.
    The ``loader`` reads an index from a location, defaulting to reading
    URLs over the network and paths from disk.
    """

    entries = []

    for location in locations:
        try:
            index = (loader or _load_index)(location)
        except CollectionError as error:
            raise CatalogError(str(error)) from error

        recorded = location

        if not is_http_url(location):
            path = Path(location)

            if relative:
                try:
                    recorded = (
                        path.resolve()
                        .relative_to(catalog_path.resolve().parent)
                        .as_posix()
                    )
                except ValueError as error:
                    raise CatalogError(
                        f"{location} is not under the catalog's directory "
                        f"{catalog_path.parent}"
                    ) from error
            elif not path.is_absolute():
                recorded = path.as_posix()

        entries.append(catalog_entry(recorded, index))

    return entries


def _load_index(location: str) -> dict[str, Any]:
    if is_http_url(location):
        return load_collection(location, Path.cwd())

    path = Path(location)

    if not path.is_file():
        raise CollectionError(f"There is no collection file at {location}")

    return load_collection(path.name, path.resolve().parent)
