"""Check that the feature branch has been merged into main."""

import os
import subprocess
import sys

repo = os.environ.get("REPO_DIR", "demo")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, text=True, check=False
    ).stdout


merged = git("branch", "--merged", "main")

if "feature" not in merged:
    print("The feature branch is not merged into main yet")
    sys.exit(1)

print("feature is merged into main")
