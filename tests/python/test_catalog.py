import json
from pathlib import Path

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.catalog import (
    CatalogError,
    CatalogMetadata,
    build_catalog,
    catalog_entry,
    load_catalog,
    parse_catalog,
    refresh_entries,
    resolve_location,
)

CATALOG = {
    "version": 1,
    "title": "Mine",
    "icon": "logo.svg",
    "collections": [
        {"url": "python/collection.json", "title": "Python", "icon": "python/icon.svg"},
        {"url": "https://other.example/k8s/collection.json"},
    ],
}

COLLECTION = {
    "version": 1,
    "title": "Python",
    "description": "The language.",
    "publisher": {"name": "Me"},
    "icon": "icon.svg",
    "tags": ["python"],
    "workshops": [],
}


def test_resolve_location_handles_urls_paths_and_data_uris() -> None:
    assert (
        resolve_location("https://h/site/catalog.json", "python/collection.json")
        == "https://h/site/python/collection.json"
    )
    assert resolve_location("https://h/site/catalog.json", "../icon.svg") == (
        "https://h/icon.svg"
    )
    assert resolve_location("collections/catalog.json", "x/icon.svg") == (
        "collections/x/icon.svg"
    )
    assert resolve_location("collections/catalog.json", "../icon.svg") == "icon.svg"
    assert resolve_location("catalog.json", "icon.svg") == "icon.svg"
    assert resolve_location("catalog.json", "https://x/i.svg") == "https://x/i.svg"
    assert resolve_location("catalog.json", "data:image/svg+xml,<svg/>") == (
        "data:image/svg+xml,<svg/>"
    )


def test_parse_catalog_checks_the_shape() -> None:
    assert parse_catalog(json.dumps(CATALOG))["title"] == "Mine"

    with pytest.raises(CatalogError, match="not valid JSON"):
        parse_catalog("{")

    with pytest.raises(CatalogError, match="catalog version"):
        parse_catalog(json.dumps({"version": 2, "collections": []}))

    with pytest.raises(CatalogError, match="each with a url"):
        parse_catalog(json.dumps({"version": 1, "collections": [{"title": "x"}]}))


def test_load_catalog_resolves_relative_locations(tmp_path: Path) -> None:
    (tmp_path / "site").mkdir()
    (tmp_path / "site" / "catalog.json").write_text(json.dumps(CATALOG))

    catalog = load_catalog("site/catalog.json", tmp_path)

    assert catalog["icon"] == "site/logo.svg"
    assert [item["url"] for item in catalog["collections"]] == [
        "site/python/collection.json",
        "https://other.example/k8s/collection.json",
    ]
    assert catalog["collections"][0]["icon"] == "site/python/icon.svg"

    with pytest.raises(CatalogError, match="no catalog file"):
        load_catalog("site/missing.json", tmp_path)

    with pytest.raises(CatalogError, match="Unsupported"):
        load_catalog("ftp://x/catalog.json", tmp_path)


def test_build_catalog_keeps_order_and_metadata() -> None:
    first = catalog_entry("a/collection.json", COLLECTION)
    second = {"url": "b/collection.json", "title": "B"}

    assert first == {
        "url": "a/collection.json",
        "title": "Python",
        "description": "The language.",
        "publisher": {"name": "Me"},
        "icon": "icon.svg",
        "tags": ["python"],
    }

    catalog = build_catalog(None, [second, first], CatalogMetadata(title="Mine"))
    catalog = build_catalog(
        catalog,
        [{"url": "a/collection.json", "title": "Python again"}],
        CatalogMetadata(publisher="Me", publisher_url="https://me.example"),
    )

    assert catalog["title"] == "Mine"
    assert catalog["publisher"] == {"name": "Me", "url": "https://me.example"}
    assert [item["url"] for item in catalog["collections"]] == [
        "b/collection.json",
        "a/collection.json",
    ]
    assert catalog["collections"][1]["title"] == "Python again"
    assert catalog["collections"][1]["description"] == "The language."

    with pytest.raises(CatalogError, match="needs a url"):
        build_catalog(None, [{"title": "no url"}])


def test_refresh_entries_reads_files_relative_to_the_catalog(tmp_path: Path) -> None:
    collection = tmp_path / "python" / "collection.json"

    collection.parent.mkdir()
    collection.write_text(json.dumps(COLLECTION))

    entries = refresh_entries(tmp_path / "catalog.json", [str(collection)], True)

    assert entries[0]["url"] == "python/collection.json"
    assert entries[0]["title"] == "Python"

    with pytest.raises(CatalogError, match="not under"):
        refresh_entries(
            tmp_path / "elsewhere" / "catalog.json", [str(collection)], True
        )

    with pytest.raises(CatalogError, match="no collection file"):
        refresh_entries(tmp_path / "catalog.json", [str(tmp_path / "x.json")])


def test_catalog_command_builds_and_refreshes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    collection = tmp_path / "python" / "collection.json"
    catalog = tmp_path / "catalog.json"

    collection.parent.mkdir()
    collection.write_text(json.dumps(COLLECTION))

    assert (
        cli.main(
            [
                "catalog",
                str(catalog),
                str(collection),
                "--relative",
                "--title",
                "Mine",
                "--publisher",
                "Me",
            ]
        )
        == 0
    )
    assert "1 collection(s)" in capsys.readouterr().out

    data = json.loads(catalog.read_text())

    assert data["title"] == "Mine"
    assert data["publisher"] == {"name": "Me"}
    assert data["collections"][0]["url"] == "python/collection.json"
    assert data["collections"][0]["description"] == "The language."

    # Without collections named, the entries already listed are re-read.
    collection.write_text(json.dumps({**COLLECTION, "description": "Changed."}))

    assert cli.main(["catalog", str(catalog)]) == 0

    data = json.loads(catalog.read_text())

    assert data["title"] == "Mine"
    assert data["collections"][0]["description"] == "Changed."

    collection.unlink()

    assert cli.main(["catalog", str(catalog)]) == 2
