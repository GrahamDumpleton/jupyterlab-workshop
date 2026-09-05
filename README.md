# educates-jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

Workshop instructions are shown in a JupyterLab side panel and contain
clickable actions that drive the live JupyterLab session: terminals, the
file browser, the editor, notebooks, kernels and layout. The concept comes
from the [Educates Training Platform](https://educates.dev), re-imagined so
that a single workshop runs wherever JupyterLab runs, without Kubernetes or
containers.

This project is at the proof-of-concept stage. See `docs/demo.md` for how
to try the example workshop.

## Development

Requires [uv](https://docs.astral.sh/uv/) and [just](https://just.systems/).

```
just install
just lab
```

Then open the Workshop panel in the left sidebar. See `just --list` for the
other development tasks.
