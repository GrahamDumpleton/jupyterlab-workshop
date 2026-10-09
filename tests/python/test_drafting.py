from pathlib import Path

import pytest

from jupyterlab_workshop.agents.policy import PermissionPolicy
from jupyterlab_workshop.drafting import (
    Proposal,
    ProposalError,
    brief,
    check_proposal,
)

PLAN = Proposal(
    title="Regular expressions",
    name="regular-expressions",
    audience="experienced",
    summary="Patterns in Python's re module, beyond the basics.",
    outline=("Groups", "Lookarounds", "Performance"),
    quizzes=False,
    gating=False,
)


def test_a_plan_is_checked_before_it_can_be_created(tmp_path: Path) -> None:
    check_proposal(PLAN, tmp_path)

    (tmp_path / "taken").mkdir()

    for changes, message in (
        ({"name": "Not A Name"}, "cannot be a directory name"),
        ({"name": "-leading"}, "cannot be a directory name"),
        ({"name": "x" * 65}, "cannot be a directory name"),
        ({"name": "taken"}, "personal/workshops/taken already exists"),
        ({"audience": "everyone"}, "audience is one of"),
        ({"title": " "}, "needs a title"),
        ({"summary": ""}, "needs a summary"),
        ({"outline": ("  ",)}, "needs an outline"),
    ):
        values = {**PLAN.to_dict(), **changes}

        with pytest.raises(ProposalError, match=message):
            check_proposal(Proposal.from_dict(values), tmp_path)


def test_the_brief_carries_the_plan() -> None:
    text = brief(PLAN)

    assert "Title: Regular expressions" in text
    assert "For: experienced practitioners, without quizzes and without gating" in text
    assert "1. Groups\n2. Lookarounds\n3. Performance" in text
    assert Proposal.from_dict(PLAN.to_dict()) == PLAN


def test_a_read_only_policy_refuses_every_change(tmp_path: Path) -> None:
    policy = PermissionPolicy(workshop=tmp_path, read_only=True, sandboxed=True)

    assert policy.decide("Read", {"file_path": str(tmp_path / "a")}).verdict == "allow"
    assert policy.decide("WebSearch", {}).verdict == "allow"
    assert policy.decide("mcp__workshop__propose_workshop", {}).verdict == "allow"

    for tool, data in (
        ("Write", {"file_path": str(tmp_path / "a")}),
        ("Edit", {"file_path": str(tmp_path / "a")}),
        ("Bash", {"command": "ls"}),
    ):
        decision = policy.decide(tool, data)

        assert decision.verdict == "deny"
        assert "propose_workshop" in decision.reason
