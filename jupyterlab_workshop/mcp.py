"""An MCP server exposing the workshop tooling to AI agents.

``jupyter workshop mcp`` serves the tools over stdio. Lint, render, test,
init, publish and draft work on directories and need nothing running.
The live tools (opening a workshop, running actions and checks against
the session) reach a running JupyterLab through the server extension's
bridge, and need the workshop open there in author mode.
"""

from __future__ import annotations

import json
import os
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer

from .catalog import (
    CatalogError,
    CatalogMetadata,
    build_catalog,
    load_catalog,
    parse_catalog,
    refresh_entries,
)
from .cli import (
    CATALOG_SCHEMA_FILE,
    COLLECTION_SCHEMA_FILE,
    NODE_BUNDLE,
    SCHEMA_FILE,
    CliError,
    run_node,
)
from .collection import (
    CollectionError,
    CollectionMetadata,
    checkout_root,
    guess_repository,
    index_repository,
    load_collection,
    parse_collection,
)
from .publish import PublishError, publish_workshop
from .scaffold import slug, write_scaffold

PACKAGE_DIR = Path(__file__).resolve().parent

SERVER_NAME = "jupyterlab-workshop"

INSTRUCTIONS = """Tools for writing guided JupyterLab workshops in the
jupyterlab-workshop format: a directory with a workshop.yaml
manifest and MyST Markdown pages whose fenced directives are clickable
actions. Read the workshop://skill resource first: it explains the
format, the workflow (outline, pages, actions, checks, lint, test) and
the common mistakes. Use lint after every edit and test before finishing.
The live tools need the workshop open in JupyterLab with author mode on."""


class SessionError(Exception):
    """A running JupyterLab could not be reached."""


@dataclass(frozen=True)
class JupyterSession:
    """How to reach a running Jupyter Server."""

    url: str
    token: str
    root_dir: str = ""

    def request(
        self,
        endpoint: str,
        body: dict[str, Any] | None = None,
        timeout: float = 60.0,
    ) -> Any:
        """Call an endpoint of the workshop server extension."""

        target = f"{self.url.rstrip('/')}/jupyterlab-workshop/{endpoint}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}

        if self.token:
            headers["Authorization"] = f"token {self.token}"

        request = urllib.request.Request(
            target, data=data, headers=headers, method="POST" if data else "GET"
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout + 5) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")

            try:
                detail = str(json.loads(detail).get("message", detail))
            except ValueError:
                pass

            raise SessionError(detail or str(error)) from error
        except (urllib.error.URLError, OSError) as error:
            raise SessionError(f"Unable to reach {self.url}: {error}") from error


def discover_session(url: str = "", token: str = "") -> JupyterSession | None:
    """Find a running server: the one given, or the first this user runs."""

    if url:
        return JupyterSession(url=url, token=token)

    env_url = os.environ.get("JUPYTER_SERVER_URL", "")

    if env_url:
        return JupyterSession(
            url=env_url, token=token or os.environ.get("JUPYTER_TOKEN", "")
        )

    from jupyter_server.serverapp import list_running_servers

    for record in list_running_servers():
        return JupyterSession(
            url=str(record.get("url", "")),
            token=str(record.get("token", "")),
            root_dir=str(record.get("root_dir", "")),
        )

    return None


def skill_directory() -> Path | None:
    """Where the authoring skill files are, packaged or in a checkout."""

    for candidate in (
        PACKAGE_DIR / "skills" / "jupyterlab-workshop-authoring",
        PACKAGE_DIR.parent / "skills" / "jupyterlab-workshop-authoring",
    ):
        if (candidate / "SKILL.md").is_file():
            return candidate

    return None


def create_server(
    session_factory: Callable[[], JupyterSession | None] = discover_session,
) -> MCPServer:
    """Build the MCP server with every tool and resource registered."""

    server = MCPServer(SERVER_NAME, instructions=INSTRUCTIONS)

    def node_json(arguments: list[str]) -> Any:
        completed = run_node([*arguments, "--json"])
        text = completed.stdout.strip() or completed.stderr.strip()

        try:
            return json.loads(text)
        except ValueError:
            return {"error": text or f"exit status {completed.returncode}"}

    def live(endpoint: str, body: dict[str, Any], timeout: float) -> Any:
        # Problems reaching the session are answers, not tool failures, so
        # the agent can read them and act.
        session = session_factory()

        if session is None:
            return {
                "error": "No running JupyterLab was found; start one, open the "
                "workshop and turn on author mode, or pass --url and --token"
            }

        try:
            return session.request(endpoint, body, timeout)
        except SessionError as error:
            return {"error": str(error)}

    @server.tool()
    def lint(directory: str, platform: str = "linux") -> Any:
        """Lint a workshop directory and return the findings with fix hints.

        Rendering for a platform (linux, macos, windows or lite) selects
        that platform's command variants.
        """

        return node_json(["lint", directory, "--platform", platform])

    @server.tool()
    def render(directory: str, page: str = "", platform: str = "linux") -> str:
        """Render the pages, or one page by id, to standalone HTML."""

        arguments = ["render", directory]

        if page:
            arguments.append(page)

        completed = run_node([*arguments, "--platform", platform])

        return completed.stdout if completed.returncode == 0 else completed.stderr

    @server.tool()
    def pages(directory: str) -> Any:
        """List the pages of a workshop with ids, titles and requirements."""

        completed = run_node(["pages", directory])

        if completed.returncode != 0:
            return {"error": completed.stderr.strip()}

        return json.loads(completed.stdout)

    @server.tool()
    def test(
        directory: str, trust: str = "trusted", timeout: float = 1200.0
    ) -> dict[str, Any]:
        """Self-test a workshop in a real JupyterLab.

        Runs every action, check, quiz and form in order in a headless
        browser and reports each one. Slow: allow a few minutes.
        """

        from .harness import SelfTestOptions, run_self_test

        with tempfile.TemporaryDirectory(prefix="workshop-mcp-") as tmp:
            report = Path(tmp) / "report.json"
            options = SelfTestOptions(
                directory=Path(directory).resolve(),
                timeout=timeout,
                trust=trust,
                json_out=report,
            )

            try:
                code = run_self_test(options)
            except SystemExit as error:
                return {"error": str(error.code)}

            data: dict[str, Any] = (
                json.loads(report.read_text()) if report.is_file() else {}
            )
            data["exit_code"] = code

            return data

    @server.tool()
    def get_schema(kind: str = "workshop") -> Any:
        """The JSON schema of workshop.yaml, a collection index or a catalog.

        The kind is workshop, collection or catalog.
        """

        path = {
            "collection": COLLECTION_SCHEMA_FILE,
            "catalog": CATALOG_SCHEMA_FILE,
        }.get(kind, SCHEMA_FILE)

        if not path.is_file():
            return {"error": f"{path.name} is not part of this installation"}

        return json.loads(path.read_text(encoding="utf-8"))

    @server.tool()
    def list_collection(location: str) -> Any:
        """Read a collection index from a URL or a local file."""

        try:
            return load_collection(location, Path.cwd())
        except CollectionError as error:
            return {"error": str(error)}

    @server.tool()
    def list_catalog(location: str) -> Any:
        """Read a catalog from a URL or a local file, with its locations resolved."""

        try:
            return load_catalog(location, Path.cwd())
        except CatalogError as error:
            return {"error": str(error)}

    @server.tool()
    def init(
        directory: str,
        name: str = "",
        title: str = "",
        template: str = "starter",
        platforms: list[str] | None = None,
        capabilities: list[str] | None = None,
        gating: str = "soft",
        ci: bool = False,
    ) -> Any:
        """Scaffold a new workshop directory.

        Templates: starter (terminal, file write, check and quiz), blank,
        or notebook (notebook-create, cell-run-all and a kernel check).
        Capabilities are names such as terminal or write-files:workspace.
        """

        target = Path(directory)
        chosen = name or slug(target.resolve().name)

        try:
            written = write_scaffold(
                target,
                chosen,
                title or chosen.replace("-", " ").capitalize(),
                ci=ci,
                template=template,
                platforms=platforms,
                capabilities=capabilities,
                gating=gating,
            )
        except (FileExistsError, ValueError) as error:
            return {"error": str(error)}

        return {"directory": str(target), "files": [str(path) for path in written]}

    @server.tool()
    def publish(directory: str, out: str = "dist", url: str = "") -> Any:
        """Build the archive, its sha256 and a collection entry for a workshop."""

        try:
            result = publish_workshop(Path(directory), Path(out), url)
        except PublishError as error:
            return {"error": str(error)}

        return result.to_dict()

    @server.tool()
    def index(
        directories: list[str] | None = None,
        root: str = "",
        out: str = "",
        repo: str = "",
        ref: str = "",
        title: str = "",
        description: str = "",
        publisher: str = "",
        publisher_url: str = "",
        homepage: str = "",
        icon: str = "",
        tags: list[str] | None = None,
        ordered: bool | None = None,
    ) -> Any:
        """Build or update a collection index of the workshops in a repository.

        Every workshop found under the directories (the current directory
        by default) becomes an entry fetched from its path within the
        checkout at the repository URL and ref, which default to the git
        origin and branch of the checkout holding the first directory. The
        index is written to collection.json under the checkout unless out
        names another file; entries already listed keep their position.
        The title, description, publisher, homepage, icon and tags describe
        the collection itself and are kept from an existing index when
        not given; ordered says whether the workshops form a sequence to
        take in the order listed.
        """

        searched = [Path(item) for item in directories or ["."]]
        root_path = (
            Path(root) if root else checkout_root(searched[0]) or searched[0]
        ).resolve()
        guessed_repo, guessed_ref = guess_repository(root_path)
        chosen_repo = repo or guessed_repo
        chosen_ref = ref or guessed_ref or "main"

        if not chosen_repo:
            return {"error": f"{root} has no git origin; give repo"}

        index_path = Path(out) if out else root_path / "collection.json"
        existing = None
        metadata = CollectionMetadata(
            title=title,
            description=description,
            publisher=publisher,
            publisher_url=publisher_url,
            homepage=homepage,
            icon=icon,
            tags=tuple(tags) if tags else None,
            ordered=ordered,
        )

        try:
            if index_path.is_file():
                existing = parse_collection(
                    index_path.read_text(encoding="utf-8"), str(index_path)
                )

            data = index_repository(
                root_path, searched, chosen_repo, chosen_ref, existing, metadata
            )
        except CollectionError as error:
            return {"error": str(error)}

        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

        return {
            "path": str(index_path),
            "repo": chosen_repo,
            "ref": chosen_ref,
            "index": data,
        }

    @server.tool()
    def catalog(
        path: str,
        collections: list[str] | None = None,
        relative: bool = False,
        title: str = "",
        description: str = "",
        publisher: str = "",
        publisher_url: str = "",
        homepage: str = "",
        icon: str = "",
    ) -> Any:
        """Build or refresh a catalog.json from collection indexes.

        Each collection, given by URL or file path, is read and its entry
        written or refreshed from the index's own title, description,
        publisher, icon and tags, keeping an existing entry's position.
        With relative set, a file path is recorded relative to the catalog
        file, for a repository holding a catalog and its collections. The
        title and the other fields describe the catalog itself.
        """

        catalog_path = Path(path)
        existing = None
        metadata = CatalogMetadata(
            title=title,
            description=description,
            publisher=publisher,
            publisher_url=publisher_url,
            homepage=homepage,
            icon=icon,
        )

        try:
            if catalog_path.is_file():
                existing = parse_catalog(
                    catalog_path.read_text(encoding="utf-8"), str(catalog_path)
                )

            entries = refresh_entries(
                catalog_path, collections or [], relative=relative
            )
            data = build_catalog(existing, entries, metadata)
        except CatalogError as error:
            return {"error": str(error)}

        catalog_path.parent.mkdir(parents=True, exist_ok=True)
        catalog_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

        return {"path": str(catalog_path), "catalog": data}

    @server.tool()
    def draft(recording: str, directory: str, name: str = "", title: str = "") -> Any:
        """Write draft pages from a recording saved by JupyterLab's Record toggle.

        The directory receives new pages when it is a workshop already and
        becomes a new workshop otherwise.
        """

        arguments = ["draft", recording, directory]

        if name:
            arguments += ["--name", name]

        if title:
            arguments += ["--title", title]

        return node_json(arguments)

    @server.tool()
    def open_workshop(path: str, timeout: float = 120.0) -> Any:
        """Open a workshop directory (relative to the JupyterLab root) in the
        running JupyterLab, in author mode."""

        return live(
            "bridge",
            {
                "command": "workshop:bridge-open",
                "args": {"path": path},
                "timeout": timeout,
            },
            timeout,
        )

    @server.tool()
    def session_status(timeout: float = 15.0) -> Any:
        """What the running JupyterLab has open: workshop, page, trust, mode."""

        return live(
            "bridge",
            {"command": "workshop:bridge-status", "args": {}, "timeout": timeout},
            timeout,
        )

    @server.tool()
    def run_action(
        type: str,
        body: str = "",
        options: dict[str, str] | None = None,
        timeout: float = 120.0,
    ) -> Any:
        """Run one action against the live session, as a page would.

        For example type "execute" with body "git status", or type "verify"
        with options {"substrate": "contents"} and body "exists demo".
        """

        return live(
            "bridge",
            {
                "command": "workshop:bridge-run",
                "args": {"type": type, "body": body, "options": options or {}},
                "timeout": timeout,
            },
            timeout,
        )

    @server.tool()
    def run_page(page: str = "", only: str = "all", timeout: float = 600.0) -> Any:
        """Run the actions of a page of the open workshop in the live session.

        `page` is a page id (the current page when empty); `only` is
        "actions", "checks" or "all". Returns each action's outcome.
        """

        return live(
            "bridge",
            {
                "command": "workshop:run-page",
                "args": {"page": page, "only": only},
                "timeout": timeout,
            },
            timeout,
        )

    @server.tool()
    def run_workshop(timeout: float = 1200.0) -> Any:
        """Run every action of the open workshop in the live session and
        report the results, as the self-test does."""

        return live(
            "bridge",
            {"command": "workshop:run-all", "args": {}, "timeout": timeout},
            timeout,
        )

    register_resources(server)

    return server


def register_resources(server: MCPServer) -> None:
    """Expose the schemas and the authoring skill as resources."""

    @server.resource(
        "workshop://schema/workshop",
        name="Workshop manifest schema",
        mime_type="application/json",
    )
    def workshop_schema() -> str:
        return (
            SCHEMA_FILE.read_text(encoding="utf-8") if SCHEMA_FILE.is_file() else "{}"
        )

    @server.resource(
        "workshop://schema/collection",
        name="Collection index schema",
        mime_type="application/json",
    )
    def collection_schema() -> str:
        return (
            COLLECTION_SCHEMA_FILE.read_text(encoding="utf-8")
            if COLLECTION_SCHEMA_FILE.is_file()
            else "{}"
        )

    @server.resource(
        "workshop://schema/catalog",
        name="Catalog schema",
        mime_type="application/json",
    )
    def catalog_schema() -> str:
        return (
            CATALOG_SCHEMA_FILE.read_text(encoding="utf-8")
            if CATALOG_SCHEMA_FILE.is_file()
            else "{}"
        )

    directory = skill_directory()

    if directory is None:
        return

    # The skill and each of its reference files become resources so a
    # client without file access can still read them.
    for path in sorted(directory.rglob("*.md")):
        relative = path.relative_to(directory).as_posix()
        uri = (
            "workshop://skill"
            if relative == "SKILL.md"
            else f"workshop://skill/{relative.removesuffix('.md')}"
        )

        server.add_resource(_file_resource(uri, path, relative))


def _file_resource(uri: str, path: Path, name: str) -> Any:
    from mcp.server.mcpserver.resources import FunctionResource

    return FunctionResource(
        uri=uri,
        name=name,
        description=f"Workshop authoring skill file {name}",
        mime_type="text/markdown",
        fn=lambda: path.read_text(encoding="utf-8"),
    )


def serve(url: str = "", token: str = "") -> int:
    """Run the server over stdio until the client disconnects."""

    if not NODE_BUNDLE.is_file():
        raise CliError(
            f"The Node bundle {NODE_BUNDLE} is missing; reinstall the package"
        )

    server = create_server(lambda: discover_session(url, token))

    server.run("stdio")

    return 0
