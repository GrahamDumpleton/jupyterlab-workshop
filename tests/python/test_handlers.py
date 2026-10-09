import io
import json
import tarfile
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest


async def test_platform_endpoint_reports_the_server_environment(jp_fetch, jp_root_dir):
    response = await jp_fetch("jupyterlab-workshop", "platform")

    assert response.code == 200

    payload = json.loads(response.body)

    assert set(payload) == {
        "os",
        "shell",
        "home",
        "user",
        "path_sep",
        "root_dir",
        "hub_user",
        "host",
        "container",
        "web_proxy",
        "agent",
        "frontend",
        "frontend_version",
        "instance_id",
    }
    assert payload["os"] in {"linux", "macos", "windows"}
    assert payload["root_dir"] == str(jp_root_dir)
    assert payload["frontend"] == "jupyterlab"
    assert payload["instance_id"]

    # The test server loads no web proxy.
    assert payload["web_proxy"] is False

    # The instance id is the same for every request to this server.
    again = json.loads((await jp_fetch("jupyterlab-workshop", "platform")).body)

    assert again["instance_id"] == payload["instance_id"]


MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: demo\ntitle: Demo\npages: [pages/01.md]\n"
)


def _make_tar() -> bytes:
    stream = io.BytesIO()

    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, content in {
            "repo-main/workshop.yaml": MANIFEST,
            "repo-main/pages/01.md": "# Page\n",
        }.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    return stream.getvalue()


@pytest.fixture
def archive_url() -> Iterator[str]:
    """Serve a workshop archive from a local HTTP server."""

    archive = _make_tar()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(len(archive)))
            self.end_headers()
            self.wfile.write(archive)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)

    thread.start()

    try:
        yield f"http://127.0.0.1:{server.server_port}/repo.tar.gz"
    finally:
        server.shutdown()
        server.server_close()


async def test_fetch_and_remove_a_workshop(jp_fetch, jp_root_dir, archive_url):
    from tornado.httpclient import HTTPClientError

    response = await jp_fetch(
        "jupyterlab-workshop",
        "fetch",
        method="POST",
        body=json.dumps({"source": {"archive": archive_url}}),
    )
    payload = json.loads(response.body)

    assert payload["path"] == "workshops/demo"
    assert payload["source"] == {
        "kind": "archive",
        "url": archive_url,
        "sha256": payload["sha256"],
    }
    assert (jp_root_dir / "workshops" / "demo" / "workshop.yaml").exists()
    assert (jp_root_dir / "workshops" / "demo" / "_workshop" / "source.json").exists()

    # A second fetch without overwrite conflicts.
    with pytest.raises(HTTPClientError) as conflict:
        await jp_fetch(
            "jupyterlab-workshop",
            "fetch",
            method="POST",
            body=json.dumps({"source": {"archive": archive_url}}),
        )

    assert conflict.value.code == 409

    response = await jp_fetch(
        "jupyterlab-workshop",
        "workshops",
        method="DELETE",
        params={"path": "workshops/demo"},
    )

    assert json.loads(response.body) == {"removed": "workshops/demo"}
    assert not (jp_root_dir / "workshops" / "demo").exists()


async def test_fetch_rejects_bad_sources(jp_fetch):
    from tornado.httpclient import HTTPClientError

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "fetch",
            method="POST",
            body=json.dumps({"source": {"url": "file:///etc"}}),
        )

    assert error.value.code == 400


async def test_verify_and_checkpoint_endpoints(jp_fetch, jp_root_dir):
    from tornado.httpclient import HTTPClientError

    workshop = jp_root_dir / "ws"

    (workshop / "verify").mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (workshop / "verify" / "ok.py").write_text("print('fine')\n")
    (workshop / "data.txt").write_text("one\n")

    response = await jp_fetch(
        "jupyterlab-workshop",
        "verify",
        method="POST",
        body=json.dumps({"workshop": "ws", "script": "verify/ok.py"}),
    )

    assert json.loads(response.body) == {"code": 0, "stdout": "fine\n", "stderr": ""}

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "verify",
            method="POST",
            body=json.dumps({"workshop": "ws", "script": "../outside.py"}),
        )

    assert error.value.code == 400

    response = await jp_fetch(
        "jupyterlab-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": "ws", "name": "start", "variables": {"x": "1"}}),
    )

    assert json.loads(response.body)["name"] == "start"

    (workshop / "data.txt").write_text("two\n")

    response = await jp_fetch(
        "jupyterlab-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": "ws", "name": "start", "action": "restore"}),
    )

    assert json.loads(response.body)["variables"] == {"x": "1"}
    assert (workshop / "data.txt").read_text() == "one\n"

    response = await jp_fetch(
        "jupyterlab-workshop", "checkpoints", params={"workshop": "ws"}
    )

    assert [item["name"] for item in json.loads(response.body)["checkpoints"]] == [
        "start"
    ]


async def test_preflight_endpoint(jp_fetch):
    response = await jp_fetch(
        "jupyterlab-workshop",
        "preflight",
        method="POST",
        body=json.dumps({"tools": [{"name": "python3"}], "versions": False}),
    )
    payload = json.loads(response.body)

    assert payload["tools"][0]["name"] == "python3"
    assert payload["tools"][0]["found"] is True
    assert payload["tools"][0]["version"] == ""


async def test_workshops_listing_collection_and_events_endpoints(jp_fetch, jp_root_dir):
    from tornado.httpclient import HTTPClientError

    workshop = jp_root_dir / "workshops" / "demo"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (jp_root_dir / "collection.json").write_text(
        json.dumps(
            {
                "version": 1,
                "title": "Demo collection",
                "icon": "icon.svg",
                "workshops": [
                    {
                        "name": "demo",
                        "title": "Demo",
                        "versions": [
                            {"version": "1", "source": {"archive": "https://h/d.tgz"}}
                        ],
                    }
                ],
            }
        )
    )
    (jp_root_dir / "catalog.json").write_text(
        json.dumps(
            {
                "version": 1,
                "title": "Demo catalog",
                "collections": [{"url": "collection.json", "title": "Demo collection"}],
            }
        )
    )

    response = await jp_fetch("jupyterlab-workshop", "workshops")
    listed = json.loads(response.body)["workshops"]

    assert [item["path"] for item in listed] == ["workshops/demo"]
    assert listed[0]["pages"] == 1
    assert listed[0]["started"] is False

    response = await jp_fetch(
        "jupyterlab-workshop", "collection", params={"url": "collection.json"}
    )
    payload = json.loads(response.body)

    assert payload["url"] == "collection.json"
    assert payload["index"]["workshops"][0]["name"] == "demo"

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("jupyterlab-workshop", "collection", params={"url": "nope.json"})

    assert error.value.code == 400

    # A catalog comes back with its relative locations resolved against it.
    response = await jp_fetch(
        "jupyterlab-workshop", "catalog", params={"url": "catalog.json"}
    )
    payload = json.loads(response.body)

    assert payload["catalog"]["title"] == "Demo catalog"
    assert payload["catalog"]["collections"][0]["url"] == "collection.json"

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("jupyterlab-workshop", "catalog", params={"url": "nope.json"})

    assert error.value.code == 400

    response = await jp_fetch(
        "jupyterlab-workshop",
        "events",
        method="POST",
        body=json.dumps(
            {
                "workshop": "workshops/demo",
                "events": [{"kind": "workshop-start"}, {"kind": "page-enter"}],
            }
        ),
    )

    assert json.loads(response.body) == {
        "written": 2,
        "forwarded": False,
        "problem": "",
    }
    assert (workshop / "_workshop" / "events.jsonl").read_text().count("\n") == 2

    response = await jp_fetch(
        "jupyterlab-workshop",
        "environment",
        params={"workshop": "workshops/demo", "kernel": "workshop-demo"},
    )

    assert json.loads(response.body)["ready"] is False


async def test_events_of_a_library_workshop_are_kept_in_its_journal(
    jp_fetch, jp_root_dir
):
    workshop = jp_root_dir / "installed" / "collections" / "demo-1234567" / "demo"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (jp_root_dir / "library.json").write_text('{"version": 2}\n')

    response = await jp_fetch(
        "jupyterlab-workshop",
        "events",
        method="POST",
        body=json.dumps(
            {
                "workshop": "installed/collections/demo-1234567/demo",
                "events": [
                    {
                        "kind": "workshop-start",
                        "ts": "2026-10-10T09:00:00Z",
                        "name": "demo",
                        "page": "a",
                        "pages": [{"id": "a", "path": "a.md", "title": "A"}],
                    },
                    {"kind": "page-enter", "ts": "2026-10-10T09:00:01Z", "page": "a"},
                    {"kind": "heartbeat", "ts": "2026-10-10T09:01:00Z", "page": "a"},
                ],
            }
        ),
    )

    assert json.loads(response.body)["written"] == 3

    # The workshop's own file has every event; the journal keeps what it
    # wants, under the path in the library, with a history file beside.
    assert (workshop / "_workshop" / "events.jsonl").read_text().count("\n") == 3

    journal = jp_root_dir / "journal"
    lines = (journal / "events.jsonl").read_text().splitlines()

    assert [json.loads(line)["kind"] for line in lines] == [
        "workshop-start",
        "page-enter",
    ]
    assert json.loads(lines[0])["path"] == "installed/collections/demo-1234567/demo"

    history = (journal / "history" / "demo.md").read_text()

    assert "status: in progress" in history
    assert "pages_reached: 1" in history
    assert "- [x] A" in history


async def test_init_and_publish_endpoints(jp_fetch, jp_root_dir):
    response = await jp_fetch(
        "jupyterlab-workshop",
        "init",
        method="POST",
        body=json.dumps(
            {
                "directory": "authored/my-workshop",
                "title": "My Workshop",
                "template": "notebook",
                "platforms": ["linux", "windows"],
                "gating": "strict",
            }
        ),
    )
    payload = json.loads(response.body)

    assert payload["path"] == "authored/my-workshop"
    assert "authored/my-workshop/pages/01-welcome.md" in payload["files"]
    assert payload["git"] is True
    assert (jp_root_dir / "authored" / "my-workshop" / ".git").is_dir()

    manifest = (jp_root_dir / "authored" / "my-workshop" / "workshop.yaml").read_text()

    assert "name: my-workshop\ntitle: My Workshop\n" in manifest
    assert "platforms: [linux, windows]" in manifest
    assert "gating: strict" in manifest
    assert (
        "notebook-create"
        in (
            jp_root_dir / "authored" / "my-workshop" / "pages" / "01-welcome.md"
        ).read_text()
    )

    # A second init of the same directory is a conflict, and a directory
    # outside the root is refused.
    with pytest.raises(Exception) as conflict:
        await jp_fetch(
            "jupyterlab-workshop",
            "init",
            method="POST",
            body=json.dumps({"directory": "authored/my-workshop"}),
        )

    assert conflict.value.code == 409

    with pytest.raises(Exception) as outside:
        await jp_fetch(
            "jupyterlab-workshop",
            "init",
            method="POST",
            body=json.dumps({"directory": "../elsewhere"}),
        )

    assert outside.value.code == 400

    response = await jp_fetch(
        "jupyterlab-workshop",
        "publish",
        method="POST",
        body=json.dumps(
            {"workshop": "authored/my-workshop", "url": "https://h/mw.tar.gz"}
        ),
    )
    published = json.loads(response.body)

    assert published["archive"] == "authored/my-workshop/dist/my-workshop-0.1.0.tar.gz"
    assert (jp_root_dir / published["archive"]).is_file()
    assert published["entry"]["versions"][0]["source"] == {
        "archive": "https://h/mw.tar.gz"
    }
    assert len(published["sha256"]) == 64


async def test_bridge_round_trip_and_timeout(jp_fetch):
    import asyncio

    # Nothing is listening, so the request appears as pending until a
    # result is posted for it, as the frontend would do.
    request = asyncio.ensure_future(
        jp_fetch(
            "jupyterlab-workshop",
            "bridge",
            method="POST",
            body=json.dumps(
                {"command": "workshop:bridge-status", "args": {}, "timeout": 5}
            ),
        )
    )

    pending: list[dict] = []

    for _ in range(50):
        listing = await jp_fetch("jupyterlab-workshop", "bridge")
        pending = json.loads(listing.body)["pending"]

        if pending:
            break

        await asyncio.sleep(0.05)

    assert pending and pending[0]["command"] == "workshop:bridge-status"

    answer = await jp_fetch(
        "jupyterlab-workshop",
        "bridge",
        "result",
        method="POST",
        body=json.dumps({"request_id": pending[0]["request_id"], "result": {"ok": 1}}),
    )

    assert json.loads(answer.body) == {"resolved": True}
    assert json.loads((await request).body) == {"result": {"ok": 1}}

    # Answering again finds nothing to resolve.
    again = await jp_fetch(
        "jupyterlab-workshop",
        "bridge",
        "result",
        method="POST",
        body=json.dumps({"request_id": pending[0]["request_id"], "result": 2}),
    )

    assert json.loads(again.body) == {"resolved": False}

    with pytest.raises(Exception) as timeout:
        await jp_fetch(
            "jupyterlab-workshop",
            "bridge",
            method="POST",
            body=json.dumps({"command": "workshop:x", "args": {}, "timeout": 0.2}),
        )

    assert timeout.value.code == 504

    with pytest.raises(Exception) as refused:
        await jp_fetch(
            "jupyterlab-workshop",
            "bridge",
            method="POST",
            body=json.dumps({"command": "filebrowser:delete", "args": {}}),
        )

    assert refused.value.code == 400


async def test_fetch_into_the_root_when_the_directory_is_given_as_dot(
    jp_fetch, jp_root_dir, archive_url
):
    # Only a missing directory takes the default; "." is the root, where
    # a workshop library opened by `jupyter workshop library` lives.
    response = await jp_fetch(
        "jupyterlab-workshop",
        "fetch",
        method="POST",
        body=json.dumps({"source": {"archive": archive_url}, "directory": "."}),
    )

    assert json.loads(response.body)["path"] == "demo"
    assert (jp_root_dir / "demo" / "workshop.yaml").is_file()

    response = await jp_fetch(
        "jupyterlab-workshop", "workshops", params={"directory": "."}
    )

    assert [item["path"] for item in json.loads(response.body)["workshops"]] == ["demo"]


async def test_endpoints_reach_a_workshop_in_a_linked_course(
    jp_fetch, jp_root_dir, tmp_path
):
    from tornado.httpclient import HTTPClientError

    from jupyterlab_workshop.library import empty_library, link_course, write_library

    repo = tmp_path / "outside-the-root" / "repo"
    workshop = repo / "workshops" / "draft"
    library = jp_root_dir / "workshops"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (workshop / "data.txt").write_text("one\n")
    write_library(library, "", empty_library())
    link_course(library, repo)

    path = "workshops/personal/courses/repo/workshops/draft"

    response = await jp_fetch(
        "jupyterlab-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": path, "name": "start"}),
    )

    assert json.loads(response.body)["name"] == "start"
    assert (workshop / "_workshop" / "snapshots").is_dir()

    # The listing the browser asks for is the plain one: a library is
    # scanned by the browser itself.
    response = await jp_fetch(
        "jupyterlab-workshop", "workshops", params={"directory": "workshops"}
    )

    assert json.loads(response.body)["workshops"] == []

    # A link the registry does not vouch for stays outside.
    stray = tmp_path / "stray"

    (stray / "ws").mkdir(parents=True)
    (stray / "ws" / "workshop.yaml").write_text(MANIFEST)
    (library / "personal" / "courses" / "stray").symlink_to(
        stray, target_is_directory=True
    )

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "checkpoints",
            params={"workshop": "workshops/personal/courses/stray/ws"},
        )

    assert error.value.code == 400

    # And a download cannot be removed from inside the course.
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "workshops",
            method="DELETE",
            params={"path": path},
        )

    assert error.value.code == 400
    assert (workshop / "workshop.yaml").is_file()


async def test_library_endpoint_reports_and_upgrades_the_previous_layout(
    jp_fetch, jp_root_dir
):
    from tornado.httpclient import HTTPClientError

    library = jp_root_dir / "workshops"
    workshop = library / "personal" / "mine"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (library / "library.json").write_text('{"version": 1}\n')

    response = await jp_fetch(
        "jupyterlab-workshop", "library", params={"directory": "workshops"}
    )
    report = json.loads(response.body)

    assert report["version"] == 1
    assert report["upgrade"] == {
        "moves": [
            {
                "from": "workshops/personal",
                "to": "workshops/personal/workshops",
                "contents": "1 workshop",
            }
        ],
        "environments": [],
    }

    response = await jp_fetch(
        "jupyterlab-workshop",
        "library",
        method="POST",
        body=json.dumps({"directory": "workshops"}),
    )

    assert json.loads(response.body)["upgraded"] == report["upgrade"]
    assert (library / "personal" / "workshops" / "mine" / "workshop.yaml").is_file()
    assert json.loads((library / "library.json").read_text()) == {"version": 2}

    # Upgraded, there is nothing to do, and asking again is an error.
    response = await jp_fetch(
        "jupyterlab-workshop", "library", params={"directory": "workshops"}
    )

    assert json.loads(response.body) == {"version": 2, "upgrade": None}

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "library",
            method="POST",
            body=json.dumps({"directory": "workshops"}),
        )

    assert error.value.code == 400

    # A plain directory is not a library at all.
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("jupyterlab-workshop", "library", params={"directory": "."})

    assert error.value.code == 404


async def test_gist_and_github_endpoints_publish_through_the_shared_code(
    jp_fetch, jp_root_dir, monkeypatch
):
    from tornado.httpclient import HTTPClientError

    from jupyterlab_workshop import handlers
    from jupyterlab_workshop.gist import GistResult
    from jupyterlab_workshop.github import GitHubError, GitHubResult

    workshop = jp_root_dir / "personal" / "workshops" / "demo"

    (workshop / "pages").mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: demo\ntitle: Demo\n"
        "pages: [pages/01.md]\n"
    )
    (workshop / "pages" / "01.md").write_text("# One\n")

    # The endpoints hand the work to the functions the command line and
    # the agent's tools use; here those are stood in for, so nothing is sent.
    calls: list[tuple[object, ...]] = []

    def fake_gist(directory, lint, create=False, public=False, **_):  # type: ignore[no-untyped-def]
        calls.append(("gist", directory.name, create, public))

        return GistResult(
            id="abc", url="https://gist.github.com/ada/abc", created=True, public=public
        )

    def fake_repository(directory, name="", public=False, description="", **_):  # type: ignore[no-untyped-def]
        calls.append(("github", directory.name, name, public))

        if name == "taken/name":
            raise GitHubError("gh repo create failed: name already exists")

        return GitHubResult(
            url="https://github.com/ada/demo",
            created=True,
            public=public,
            notes=("A note.",),
        )

    monkeypatch.setattr(handlers, "publish_to_gist", fake_gist)
    monkeypatch.setattr(handlers, "publish_repository", fake_repository)

    response = await jp_fetch(
        "jupyterlab-workshop",
        "gist",
        method="POST",
        body=json.dumps({"workshop": "personal/workshops/demo", "public": True}),
    )

    assert json.loads(response.body) == {
        "url": "https://gist.github.com/ada/abc",
        "created": True,
        "public": True,
    }

    response = await jp_fetch(
        "jupyterlab-workshop",
        "github",
        method="POST",
        body=json.dumps({"path": "personal/workshops/demo", "name": "ada/demo"}),
    )
    published = json.loads(response.body)

    assert published["url"] == "https://github.com/ada/demo"
    assert published["public"] is False
    assert published["notes"] == ["A note."]
    assert calls == [
        ("gist", "demo", False, True),
        ("github", "demo", "ada/demo", False),
    ]

    # A directory that is not a workshop cannot be a gist, and a failure
    # from gh is the endpoint's error.
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "gist",
            method="POST",
            body=json.dumps({"workshop": "personal/workshops"}),
        )

    assert error.value.code == 400
    assert "has no workshop.yaml" in str(error.value.response.body)

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "github",
            method="POST",
            body=json.dumps({"path": "personal/workshops/demo", "name": "taken/name"}),
        )

    assert error.value.code == 400
    assert "already exists" in str(error.value.response.body)


async def test_courses_endpoint_promotes_a_workshop_into_a_course(
    jp_fetch, jp_root_dir
):
    from tornado.httpclient import HTTPClientError

    from jupyterlab_workshop.course import CollectionSpec, CourseOptions, write_course
    from jupyterlab_workshop.library import empty_library, write_library

    library = jp_root_dir / "workshops"
    workshop = library / "personal" / "workshops" / "mover"
    course = library / "personal" / "courses" / "parts"

    write_library(library, "", empty_library())
    (workshop / "pages").mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: mover\ntitle: Mover\n"
        "pages: [pages/01.md]\n"
    )
    (workshop / "pages" / "01.md").write_text("# One\n")
    write_course(
        course,
        CourseOptions(
            name="parts",
            title="Parts",
            description="",
            collections=(CollectionSpec("a", "A"), CollectionSpec("b", "B")),
            id_prefix="example.org",
        ),
    )

    # The listing names each course's collections, for the dialog.
    response = await jp_fetch(
        "jupyterlab-workshop", "courses", params={"directory": "workshops"}
    )
    (listed,) = json.loads(response.body)["courses"]

    assert listed["collections"] == [
        {"name": "a", "title": "A"},
        {"name": "b", "title": "B"},
    ]

    # The move needs the owner's workshop and one of their courses.
    for body, detail in (
        ({"workshop": "workshops/personal/workshops/mover"}, "course are required"),
        (
            {
                "workshop": "workshops/installed/workshops/x",
                "course": "workshops/personal/courses/parts",
            },
            "not one of your own",
        ),
        (
            {
                "workshop": "workshops/personal/workshops/mover",
                "course": "workshops/personal/courses/parts/workshops",
            },
            "not a course",
        ),
        (
            {
                "workshop": "workshops/personal/workshops/mover",
                "course": "workshops/personal/courses/parts",
            },
            "name the one the workshop joins",
        ),
    ):
        with pytest.raises(HTTPClientError) as error:
            await jp_fetch(
                "jupyterlab-workshop",
                "courses",
                method="POST",
                body=json.dumps({"directory": "workshops", **body}),
            )

        assert error.value.code == 400
        assert detail in str(error.value.response.body)

    response = await jp_fetch(
        "jupyterlab-workshop",
        "courses",
        method="POST",
        body=json.dumps(
            {
                "directory": "workshops",
                "workshop": "workshops/personal/workshops/mover",
                "course": "workshops/personal/courses/parts",
                "collection": "b",
            }
        ),
    )
    report = json.loads(response.body)

    assert report["path"] == "workshops/personal/courses/parts/workshops/mover"
    assert report["collection"] == "b"
    assert (report["indexed"], report["outlined"], report["ordered"]) == (
        True,
        True,
        True,
    )
    assert (course / "workshops" / "mover" / "workshop.yaml").is_file()
    assert not workshop.exists()

    # Not a git repository, so not committed, and the report says why.
    assert report["committed"] is False
    assert "not a git repository" in report["commit_note"]


async def test_courses_endpoint_lists_and_unlinks_a_missing_course(
    jp_fetch, jp_root_dir, tmp_path
):
    import shutil

    from tornado.httpclient import HTTPClientError

    from jupyterlab_workshop.library import (
        empty_library,
        is_link,
        link_course,
        write_library,
    )

    repo = tmp_path / "gone" / "repo"
    library = jp_root_dir / "workshops"

    repo.mkdir(parents=True)
    write_library(library, "", empty_library())
    link_course(library, repo)
    shutil.rmtree(repo)

    response = await jp_fetch(
        "jupyterlab-workshop", "courses", params={"directory": "workshops"}
    )
    (course,) = json.loads(response.body)["courses"]

    assert course["name"] == "repo"
    assert course["missing"] is True

    response = await jp_fetch(
        "jupyterlab-workshop",
        "courses",
        method="DELETE",
        params={"directory": "workshops", "name": "repo"},
    )

    assert json.loads(response.body)["unlinked"]["name"] == "repo"
    assert not is_link(library / "personal" / "courses" / "repo")

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "courses",
            method="DELETE",
            params={"directory": "workshops", "name": "repo"},
        )

    assert error.value.code == 400
