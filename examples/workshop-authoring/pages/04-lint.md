---
title: Lint
requires: [verify:lint-fixed]
---

# Lint

`jupyter workshop lint` reads the manifest and every page and reports
problems: unknown directives and options, capabilities a page needs but
the manifest does not declare, checks that name nothing, and more. Run it
on the new workshop. It needs Node.js on the path.

```{execute}
:id: lint
:session: author
jupyter workshop lint {{ workshop_dir }}
```

```{verify}
:id: lint-clean
:label: Lint reports no errors
:trigger: after:lint
import json
import subprocess

completed = subprocess.run(
    ["jupyter", "workshop", "lint", "{{ workshop_dir }}", "--json"],
    capture_output=True,
    text=True,
)
assert "Node.js" not in completed.stderr, "Install Node.js so that lint can run"
report = json.loads(completed.stdout)
assert report["errors"] == 0, f"Lint found {report['errors']} error(s)"
```

Now add a page that runs code in a kernel without declaring the
`kernel-exec` capability the action needs, and list it in the manifest.

````{file-write}
:id: write-broken
:path: {{ workshop_dir }}/pages/04-compute.md
---
title: Compute
---

# Compute

Add two numbers in the workshop kernel.

```{kernel-execute}
print(1 + 1)
```
````

```{editor-insert}
:id: list-broken
:path: {{ workshop_dir }}/workshop.yaml
:save: true
  - pages/04-compute.md
```

Lint again. The error names the capability and the manifest line to
change.

```{execute}
:id: lint-again
:session: author
jupyter workshop lint {{ workshop_dir }}
```

```{verify}
:id: lint-error-seen
:label: Lint reports the undeclared capability
:trigger: after:lint-again
import json
import subprocess

completed = subprocess.run(
    ["jupyter", "workshop", "lint", "{{ workshop_dir }}", "--json"],
    capture_output=True,
    text=True,
)
report = json.loads(completed.stdout)
rules = [message["rule"] for message in report["messages"]]
assert "undeclared-capability" in rules, "Write pages/04-compute.md and list it in the manifest first"
```

Declare the capability. The action finds the `terminal` entry of the
capabilities list and adds `kernel-exec` after it. In author mode the
Lint panel offers this fix as a button.

```{editor-replace}
:id: declare-kernel
:path: {{ workshop_dir }}/workshop.yaml
:match: - terminal
:save: true
- terminal
  - kernel-exec
```

```{verify}
:id: lint-fixed
:label: Lint is clean again
:trigger: after:declare-kernel; file-saved {{ workshop_dir }}/workshop.yaml
import json
import subprocess

completed = subprocess.run(
    ["jupyter", "workshop", "lint", "{{ workshop_dir }}", "--json"],
    capture_output=True,
    text=True,
)
report = json.loads(completed.stdout)
assert report["errors"] == 0, "; ".join(m["message"] for m in report["messages"] if m["level"] == "error")
```
