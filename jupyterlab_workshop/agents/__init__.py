"""AI agents that write workshops, behind one provider interface.

Claude, through the Claude Agent SDK, is the one real provider; its
dependencies are the optional `ai` extra. The fake provider answers by
rule and serves the tests.
"""

from __future__ import annotations

from .base import AgentProvider

# The extra that installs the default provider's dependencies.
AGENT_EXTRA = "ai"

# The provider used unless the server is configured with another.
DEFAULT_PROVIDER = "claude"


class UnknownProviderError(ValueError):
    """No provider has the name asked for."""


def get_provider(name: str = DEFAULT_PROVIDER) -> AgentProvider:
    """The provider of a name, created afresh."""

    # Imported here so that a provider's module, and anything it imports,
    # loads only when that provider is used.
    if name == "claude":
        from .claude import ClaudeProvider

        return ClaudeProvider()

    if name == "fake":
        from .fake import FakeProvider

        return FakeProvider()

    raise UnknownProviderError(f'No agent provider is called "{name}"')
