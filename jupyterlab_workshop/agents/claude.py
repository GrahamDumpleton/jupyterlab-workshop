"""Claude, through the Claude Agent SDK, on the credentials Claude Code has.

The SDK runs Claude Code as a subprocess. Nothing here offers a login of
its own: the conversation uses whatever Claude Code is logged in with,
the person's Claude subscription, or `ANTHROPIC_API_KEY` when that is set,
and logging in happens in Claude Code itself, in a terminal.

The conversation is isolated from the person's own Claude Code setup, so
it behaves the same on every machine: no settings, plugins, hooks or MCP
servers of theirs are loaded, only the workshop tools and the authoring
skill. The skill comes from the installed package, through a plugin
generated for it. Bare mode, which would ignore the subscription login,
is never used.

`claude_agent_sdk` is imported only inside functions, so this module
imports without the `ai` extra.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import sys
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .base import (
    AgentEvent,
    AgentInfo,
    AgentStatus,
    Compacted,
    Compacting,
    Done,
    Error,
    ModelChoice,
    PermissionRequest,
    StartOptions,
    Text,
    TextDelta,
    ToolCall,
    ToolResult,
)

if TYPE_CHECKING:
    from mcp.server.mcpserver import MCPServer

PROVIDER_NAME = "claude"

INSTALL_HINT = 'uv tool install "jupyterlab-workshop[lab,ai]"'

# The name the workshop tools are served under, which the agent sees as
# the mcp__workshop__ prefix.
TOOLS_SERVER = "workshop"

# The plugin the authoring skill is served in.
PLUGIN_NAME = "jupyterlab-workshop"

# How long `claude auth status` may take.
STATUS_TIMEOUT = 30.0

# How much of a tool's result is kept for display.
SUMMARY_LENGTH = 2000


class ClaudeUnavailableError(RuntimeError):
    """The SDK, or the Claude Code it runs, is missing."""


def sdk_available() -> bool:
    """Whether the Claude Agent SDK is installed."""

    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError:
        return False

    return True


def bundled_cli() -> Path | None:
    """The Claude Code binary the SDK ships, where its wheel has one."""

    try:
        import claude_agent_sdk
    except ImportError:
        return None

    bundled = Path(claude_agent_sdk.__file__).parent / "_bundled"

    for name in ("claude", "claude.exe"):
        if (bundled / name).is_file():
            return bundled / name

    return None


def session_cli() -> Path | None:
    """The Claude Code a conversation runs: the SDK's own, else the one on PATH.

    The SDK's own matches the version it was tested with. Its wheels
    bundle one for macOS and Linux; on Windows Claude Code is installed
    separately.
    """

    found = shutil.which("claude")

    return bundled_cli() or (Path(found) if found else None)


def terminal_cli() -> Path | None:
    """The Claude Code a terminal runs: the one on PATH, else the SDK's own.

    The one on PATH is what the person updates and uses themselves, so
    logging in or carrying on a conversation in a terminal uses it.
    """

    found = shutil.which("claude")

    return Path(found) if found else bundled_cli()


def sandbox_supported() -> bool:
    """Whether Claude Code can confine Bash to a sandbox on this system."""

    return sys.platform == "darwin" or sys.platform.startswith("linux")


def skill_plugin(skill: Path, cache: Path, version: str) -> Path:
    """A plugin directory serving the authoring skill, made if needed.

    The skill is linked, not copied, so the plugin always serves the
    installed package's files; where a link cannot be made, as on Windows
    without the right, it is copied. The directory is named for the
    package version, so an upgrade gets a fresh one.
    """

    plugin = cache / f"{PLUGIN_NAME}-plugin-{version}"
    manifest = plugin / ".claude-plugin" / "plugin.json"
    target = plugin / "skills" / skill.name

    # A plugin made for this version, still pointing at the skill, is kept.
    if manifest.is_file() and (target / "SKILL.md").is_file():
        if not target.is_symlink() or target.resolve() == skill.resolve():
            return plugin

    shutil.rmtree(plugin, ignore_errors=True)

    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(
            {
                "name": PLUGIN_NAME,
                "version": version,
                "description": "Writing jupyterlab-workshop workshops",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        os.symlink(skill, target, target_is_directory=True)
    except OSError:
        shutil.copytree(skill, target)

    return plugin


def parse_auth_status(
    returncode: int, output: str, environ: Mapping[str, str] = os.environ
) -> AgentStatus:
    """The status from what `claude auth status` printed.

    The environment is the one JupyterLab was started in, where an
    `ANTHROPIC_API_KEY` takes the place of a subscription.
    """

    try:
        data = json.loads(output) if output.strip() else {}
    except ValueError:
        data = {}

    if not isinstance(data, dict):
        data = {}

    logged_in = returncode == 0 and data.get("loggedIn") is not False
    method = str(data.get("authMethod") or "")
    warnings: list[str] = []

    if method == "none":
        logged_in = False

    if method == "api_key" and environ.get("ANTHROPIC_API_KEY"):
        warnings.append(
            "ANTHROPIC_API_KEY is set where JupyterLab was started, so usage "
            "is billed to that API account and not to a Claude subscription."
        )

    return AgentStatus(
        provider=PROVIDER_NAME,
        available=True,
        logged_in=logged_in,
        auth_method=method,
        plan=str(data.get("subscriptionType") or ""),
        warnings=tuple(warnings),
    )


class ClaudeSession:
    """A conversation with Claude, held open between messages."""

    def __init__(self, options: StartOptions, client: Any) -> None:
        self._options = options
        self._client = client
        self._session_id: str | None = options.resume
        self._events: asyncio.Queue[AgentEvent | None] = asyncio.Queue()
        self._answers: dict[str, asyncio.Future[bool]] = {}
        self._remembered: set[str] = set()
        self._remember: set[str] = set()
        self._interrupting = False
        self._model = options.model
        self._resolved = ""

        # Claude Code reports what its process has cost so far, not each
        # turn, so a turn's cost is the change since the last.
        self._spent = 0.0

    @property
    def session_id(self) -> str | None:
        """The id the conversation resumes by."""

        return self._session_id

    async def send(self, text: str) -> AsyncIterator[AgentEvent]:
        """Send a message and stream what Claude does, up to `Done`."""

        self._interrupting = False

        # Messages and permission requests arrive from two places, the
        # response stream and the permission callback, so both go through
        # one queue and are yielded in the order they happened. Each turn
        # has its own, so nothing left over from the last reaches this one.
        events: asyncio.Queue[AgentEvent | None] = asyncio.Queue()

        self._events = events

        await self._client.query(text)

        pump = asyncio.ensure_future(self._pump(events))

        try:
            while True:
                event = await events.get()

                if event is None:
                    break

                yield event

                if isinstance(event, Done):
                    break
        finally:
            if not pump.done():
                pump.cancel()

    def compact(self) -> AsyncIterator[AgentEvent]:
        """Have Claude Code summarize the conversation, as /compact does."""

        return self.send("/compact")

    def answer(self, permission_id: str, allow: bool, remember: bool = False) -> bool:
        """Answer the permission request Claude is waiting on."""

        future = self._answers.get(permission_id)

        if future is None or future.done():
            return False

        if allow and remember:
            self._remember.add(permission_id)

        future.set_result(allow)

        return True

    async def interrupt(self) -> None:
        """Stop the turn in progress, declining any request it waits on."""

        self._interrupting = True

        for future in self._answers.values():
            if not future.done():
                future.set_result(False)

        await self._client.interrupt()

    async def info(self) -> AgentInfo:
        """The model in use, the models Claude Code offers, and the context."""

        models: tuple[ModelChoice, ...] = ()

        try:
            server = await self._client.get_server_info() or {}
            models = tuple(
                ModelChoice(
                    value=str(item.get("value") or ""),
                    name=str(item.get("displayName") or item.get("value") or ""),
                    description=str(item.get("description") or ""),
                    efforts=tuple(
                        str(level) for level in item.get("supportedEffortLevels") or ()
                    ),
                )
                for item in server.get("models") or ()
                if isinstance(item, dict) and item.get("value")
            )
        except Exception:
            models = ()

        used: int | None = None
        limit: int | None = None

        # Context usage is only known once the conversation has started.
        try:
            usage = await self._client.get_context_usage()
            used = int(usage.get("totalTokens") or 0)
            limit = int(usage.get("maxTokens") or 0) or None
            self._resolved = str(usage.get("model") or self._resolved)
        except Exception:
            pass

        return AgentInfo(
            model=self._model,
            resolved=self._resolved,
            effort=self._options.effort,
            models=models,
            context_used=used,
            context_limit=limit,
        )

    async def set_model(self, model: str) -> None:
        """Answer with another model from the next message on."""

        await self._client.set_model(model or None)

        self._model = model
        self._resolved = ""

    async def close(self) -> None:
        """End the conversation and the Claude Code process behind it."""

        await self._client.disconnect()

    async def can_use_tool(self, name: str, data: dict[str, Any], context: Any) -> Any:
        """The SDK's permission callback: the policy, then the person."""

        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        decision = self._options.policy.decide(name, data)

        if decision.verdict == "allow":
            return PermissionResultAllow()

        if decision.verdict == "deny":
            return PermissionResultDeny(message=decision.reason)

        key = _remember_key(name, data)

        if decision.rememberable and key in self._remembered:
            return PermissionResultAllow()

        request = PermissionRequest(
            id=str(getattr(context, "tool_use_id", "") or secrets.token_hex(8)),
            tool=name,
            input=data,
            reason=decision.reason,
            rememberable=decision.rememberable,
        )
        future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

        self._answers[request.id] = future
        await self._events.put(request)

        try:
            allowed = await future
        finally:
            self._answers.pop(request.id, None)

        if not allowed:
            return PermissionResultDeny(message="The person declined this.")

        if request.id in self._remember:
            self._remember.discard(request.id)

            if request.rememberable:
                self._remembered.add(key)

        return PermissionResultAllow()

    def _system(self, subtype: str, data: dict[str, Any]) -> list[AgentEvent]:
        # Claude Code reports compaction, asked for or automatic, through
        # system messages: a status while it runs, then a boundary where
        # the summary takes the place of what came before.
        if subtype == "init":
            self._resolved = str(data.get("model") or self._resolved)
            self._session_id = str(data.get("session_id") or self._session_id or "")

        elif subtype == "status":
            if data.get("status") == "compacting":
                return [Compacting()]

            if data.get("compact_result") == "failed":
                reason = str(data.get("compact_error") or "no reason was given")

                return [Error(f"Compacting the conversation failed: {reason}")]

        elif subtype == "compact_boundary":
            metadata = data.get("compact_metadata") or {}

            return [
                Compacted(
                    trigger=str(metadata.get("trigger") or "manual"),
                    tokens_before=_optional_int(metadata.get("pre_tokens")),
                    tokens_after=_optional_int(metadata.get("post_tokens")),
                )
            ]

        return []

    async def _pump(self, events: asyncio.Queue[AgentEvent | None]) -> None:
        try:
            async for message in self._client.receive_response():
                for event in self.translate(message):
                    await events.put(event)
        except Exception as error:
            await events.put(Error(f"The conversation failed: {error}"))
            await events.put(Done(self._session_id))
        finally:
            await events.put(None)

    def translate(self, message: Any) -> list[AgentEvent]:
        """The panel's events for one SDK message."""

        from claude_agent_sdk import (
            AssistantMessage,
            ResultMessage,
            SystemMessage,
            TextBlock,
            ToolResultBlock,
            ToolUseBlock,
            UserMessage,
        )
        from claude_agent_sdk.types import StreamEvent

        if isinstance(message, StreamEvent):
            event = message.event
            delta = event.get("delta") or {}

            if (
                event.get("type") == "content_block_delta"
                and delta.get("type") == "text_delta"
            ):
                return [TextDelta(str(delta.get("text") or ""))]

            return []

        if isinstance(message, SystemMessage):
            return self._system(message.subtype, message.data)

        if isinstance(message, AssistantMessage):
            events: list[AgentEvent] = []

            for block in message.content:
                if isinstance(block, TextBlock):
                    events.append(Text(block.text))
                elif isinstance(block, ToolUseBlock):
                    events.append(ToolCall(block.id, block.name, dict(block.input)))

            return events

        if isinstance(message, UserMessage) and isinstance(message.content, list):
            return [
                ToolResult(
                    block.tool_use_id,
                    not block.is_error,
                    _summary(block.content),
                )
                for block in message.content
                if isinstance(block, ToolResultBlock)
            ]

        if isinstance(message, ResultMessage):
            self._session_id = message.session_id or self._session_id
            interrupted = self._interrupting
            result: list[AgentEvent] = []

            if message.is_error and not interrupted:
                result.append(Error(str(message.result or message.subtype)))

            cost: float | None = None

            if message.total_cost_usd is not None:
                cost = max(0.0, message.total_cost_usd - self._spent)
                self._spent = message.total_cost_usd

            result.append(
                Done(
                    self._session_id,
                    interrupted=interrupted,
                    turns=message.num_turns,
                    cost=cost,
                )
            )

            return result

        return []


class ClaudeProvider:
    """Conversations with Claude through the Claude Agent SDK."""

    name = PROVIDER_NAME

    def available(self) -> bool:
        """Whether the `ai` extra is installed."""

        return sdk_available()

    async def status(self) -> AgentStatus:
        """Whether Claude Code is logged in, asked of Claude Code itself."""

        if not self.available():
            return AgentStatus(
                provider=self.name, available=False, install_hint=INSTALL_HINT
            )

        cli = session_cli()

        if cli is None:
            return AgentStatus(
                provider=self.name,
                available=True,
                warnings=(
                    "Claude Code was not found. Install it from "
                    "https://claude.com/claude-code and log in.",
                ),
            )

        try:
            process = await asyncio.create_subprocess_exec(
                str(cli),
                "auth",
                "status",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            output, _ = await asyncio.wait_for(process.communicate(), STATUS_TIMEOUT)
        except (OSError, TimeoutError) as error:
            return AgentStatus(
                provider=self.name,
                available=True,
                warnings=(
                    f"Unable to ask Claude Code whether it is logged in: {error}",
                ),
            )

        return parse_auth_status(
            process.returncode or 0, output.decode(errors="replace")
        )

    async def start(self, options: StartOptions) -> ClaudeSession:
        """Start a conversation in the workshop directory, or resume one."""

        if not self.available():
            raise ClaudeUnavailableError(
                f"The Claude Agent SDK is not installed: {INSTALL_HINT}"
            )

        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        cli = session_cli()

        if cli is None:
            raise ClaudeUnavailableError(
                "Claude Code was not found. Install it from "
                "https://claude.com/claude-code and log in."
            )

        session: ClaudeSession | None = None

        async def can_use_tool(name: str, data: dict[str, Any], context: Any) -> Any:
            assert session is not None

            return await session.can_use_tool(name, data, context)

        plugins: list[Any] = []
        add_dirs: list[str | Path] = []

        if options.skill is not None:
            plugins.append({"type": "local", "path": str(_plugin(options.skill))})
            add_dirs.append(str(options.skill))

        mcp_servers: dict[str, Any] = {}

        if options.tools is not None:
            mcp_servers[TOOLS_SERVER] = await sdk_tools_server(options.tools)

        sdk_options = ClaudeAgentOptions(
            cwd=str(options.directory),
            cli_path=str(cli),
            model=options.model or None,
            effort=options.effort or None,  # type: ignore[arg-type]
            resume=options.resume,
            setting_sources=[],
            strict_mcp_config=True,
            plugins=plugins,
            add_dirs=add_dirs,
            mcp_servers=mcp_servers,
            can_use_tool=can_use_tool,
            include_partial_messages=True,
            # The workshop tools are listed to the agent up front rather
            # than found through a tool search, so it reaches for them and
            # not for the same commands in a shell.
            env={"ENABLE_TOOL_SEARCH": "false"},
            system_prompt={
                "type": "preset",
                "preset": "claude_code",
                "append": options.instructions,
            },
            sandbox=(
                {"enabled": True, "autoAllowBashIfSandboxed": True}
                if options.policy.sandboxed
                else None
            ),
        )

        client = ClaudeSDKClient(sdk_options)
        session = ClaudeSession(options, client)

        await client.connect()

        return session

    def login_command(self) -> list[str] | None:
        """Claude Code's own login, in the terminal's Claude Code."""

        cli = terminal_cli()

        return [str(cli), "auth", "login"] if cli else None

    def terminal_command(
        self, session_id: str, options: StartOptions
    ) -> list[str] | None:
        """Claude Code resuming the conversation, with the skill and tools.

        The terminal's Claude Code is the person's own, with their own
        settings; the conversation, the authoring skill and the workshop
        tools come with it.
        """

        cli = terminal_cli()

        if cli is None or not session_id:
            return None

        return resume_command(
            cli,
            session_id,
            _plugin(options.skill) if options.skill is not None else None,
            _workshop_cli(),
        )


def resume_command(
    cli: Path, session_id: str, plugin: Path | None, workshop_cli: Path | None
) -> list[str]:
    """The Claude Code command line that carries a conversation on.

    The plugin serves the authoring skill, and the workshop tools are
    `jupyter workshop mcp`, which finds the running server by itself.
    """

    command = [str(cli), "--resume", session_id]

    if plugin is not None:
        command += ["--plugin-dir", str(plugin)]

    if workshop_cli is not None:
        config = {
            "mcpServers": {
                TOOLS_SERVER: {"command": str(workshop_cli), "args": ["mcp"]}
            }
        }

        command += ["--mcp-config", json.dumps(config)]

    return command


def _plugin(skill: Path) -> Path:
    from jupyter_core.paths import jupyter_data_dir

    from .. import __version__

    return skill_plugin(
        skill, Path(jupyter_data_dir()) / "jupyterlab_workshop", __version__
    )


def _workshop_cli() -> Path | None:
    # The jupyter-workshop script installed beside this Python, else the
    # one on PATH.
    for name in ("jupyter-workshop", "jupyter-workshop.exe"):
        beside = Path(sys.executable).parent / name

        if beside.is_file():
            return beside

    found = shutil.which("jupyter-workshop")

    return Path(found) if found else None


async def sdk_tools_server(server: MCPServer) -> Any:
    """The workshop MCP server's tools, served to Claude in-process.

    The tools are listed and called through the MCP server's public
    interface, so the agent gets exactly the tools, descriptions and
    schemas `jupyter workshop mcp` serves.
    """

    from claude_agent_sdk import SdkMcpTool, create_sdk_mcp_server

    tools = []

    for listed in await server.list_tools():
        tools.append(
            SdkMcpTool(
                name=listed.name,
                description=listed.description or "",
                input_schema=dict(listed.input_schema),
                handler=_tool_handler(server, listed.name),
            )
        )

    return create_sdk_mcp_server(TOOLS_SERVER, tools=tools)


def _tool_handler(server: MCPServer, name: str) -> Any:
    async def handler(arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await server.call_tool(name, arguments)
        except Exception as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}

        content = [
            block.model_dump(mode="json", by_alias=True, exclude_none=True)
            for block in getattr(result, "content", []) or []
        ]

        return {
            "content": content,
            "is_error": bool(getattr(result, "is_error", False)),
        }

    return handler


def _remember_key(name: str, data: dict[str, Any]) -> str:
    # A command is remembered as itself, so allowing one command for the
    # conversation does not allow every other.
    if name == "Bash":
        return f"Bash:{data.get('command', '')}"

    return name


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _summary(content: Any) -> str:
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "".join(
            str(item.get("text", "")) for item in content if isinstance(item, dict)
        )
    else:
        text = ""

    if len(text) > SUMMARY_LENGTH:
        return text[:SUMMARY_LENGTH] + "…"

    return text
