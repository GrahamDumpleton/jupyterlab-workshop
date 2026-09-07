# jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

Workshop instructions are shown in a JupyterLab side panel and contain
clickable actions that drive the live session: terminals, the file
browser, the editor, notebooks, kernels and layout. Workshops can check
what the learner has done, ask questions, collect values, hold pages
until requirements are met, and snapshot the working directory. The
concept comes from the [Educates Training Platform](https://educates.dev),
re-imagined so that a single workshop runs wherever JupyterLab runs,
without Kubernetes or containers.

A workshop is a directory with a `workshop.yaml` manifest and Markdown
pages. The format is text based and git friendly, and a workshop can
also be published as a static JupyterLite site that runs entirely in the
browser.

> **Warning:** This project is in an early phase of development. The
> documentation is still being improved, the experience is still being
> polished, and the workshop format, settings and command line can change
> between releases without a compatibility path.

## Install

```
pip install jupyterlab-workshop
```

The package is a prebuilt JupyterLab 4 extension with its server
extension; nothing else needs installing. Open the Workshop panel from
the right sidebar, or right-click a workshop directory in the file browser
and choose "Open as Workshop".

## Writing a workshop

```
pip install "jupyterlab-workshop[test]"
playwright install chromium
jupyter workshop init my-workshop
jupyter workshop lint my-workshop
jupyter workshop test my-workshop
```

`lint` needs Node.js on the path; `test` runs every action of the
workshop in a real JupyterLab and reports each one. Inside JupyterLab,
"Workshop: Author Mode" adds an editing toolbar to the panel, and
`jupyter workshop mcp` (with the `mcp` extra) serves the same tools to AI
agents. The `lite` extra adds `jupyter workshop lite` for building a
JupyterLite site.

## Learn more

- [Getting started](https://jupyterlab-workshop.readthedocs.io/en/latest/getting-started.html):
  install the extension, run an example workshop and scaffold your own.

- [Documentation](https://jupyterlab-workshop.readthedocs.io/): how
  workshops work, the actions a page can use, checks, forms and
  checkpoints, platforms, JupyterLite, the manifest reference, trust,
  the command line and authoring in JupyterLab.

- [Try the demo](https://grahamdumpleton.github.io/jupyterlab-workshop/demo/lab/index.html?reset&workshop=hello-jupyterlab&restart=force):
  the Hello JupyterLab workshop running in JupyterLite, started afresh
  on every visit.

- [Launch on Binder](https://mybinder.org/v2/gh/GrahamDumpleton/jupyterlab-workshop/main?urlpath=lab):
  pick one of the example workshops in a full JupyterLab with a real
  terminal.

- [Source, issues and contributing](https://github.com/GrahamDumpleton/jupyterlab-workshop):
  see `CONTRIBUTING.md` in the repository for the development setup.

## License

Apache License 2.0.
