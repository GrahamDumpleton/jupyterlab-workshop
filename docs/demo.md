# Demo: the git-basics workshop

The quickest look is the
[JupyterLite demo](https://grahamdumpleton.github.io/jupyterlab-workshop/demo/),
which runs entirely in the browser, or
[Binder](https://mybinder.org/v2/gh/GrahamDumpleton/jupyterlab-workshop/main?urlpath=lab%3Fworkshop%3Dexamples%2Fgit-basics),
which starts a full JupyterLab with the git-basics example open. Both
use the released package.

The rest of this page walks through the proof of concept by hand from a
checkout. It needs [uv](https://docs.astral.sh/uv/),
[just](https://just.systems/), Node.js and git.

## Set up

From the repository root:

```
just install
just lab
```

`just install` creates the Python environment, installs the JavaScript
workspace, builds the extension and links it into JupyterLab in development
mode. `just lab` starts JupyterLab with the repository root as its root
directory, which is where the example workshop lives.

To rebuild while editing the TypeScript, run `just watch` in a second
terminal and refresh the browser after each rebuild.

## Walk through

1. In JupyterLab, click the book icon in the right sidebar to show the
   Workshop panel (the `panelSide` setting moves it to the left, and
   JupyterLab remembers a tab you drag to the other side). The `examples/git-basics` workshop loads automatically
   (the path is the `defaultWorkshop` setting of the extension; change it
   under Settings, use the folder icon in the panel header to pick a
   different workshop directory, or right-click a directory in the file
   browser and choose "Open as Workshop").

2. On page one, click each command block in turn. The first click starts a
   terminal named `git` in a split beneath the main area and runs the
   command there. Every block shows exactly the text that is sent to the
   terminal.

3. On page two, the first action writes `README.md` into the `demo`
   directory and opens it in the editor above the terminal. The final
   action highlights the terminal with a short callout.

4. Page three appends a line to the open file through the editor and saves
   it, then opens a second terminal named `log` beside the first.

5. Pages four and five branch, merge, create a conflict, open the file at
   the conflict marker and resolve it by rewriting the file. The last action
   shows a success notification.

6. Use the arrows or the page dropdown to move between pages. Reload the
   browser tab: the panel reopens on the same page.

## The hello-jupyterlab workshop

Use the folder icon in the panel header and enter `examples/hello-jupyterlab`
to open the second example. It exercises notebooks, kernels, the interface,
files, variables, tracks and automatic runs, and its files land in
`examples/hello-jupyterlab/scratch`, which git ignores.

## Reset

The workshop creates `examples/git-basics/demo`, and the extension keeps
its progress, action log and environment files in
`examples/git-basics/_workshop`. Both are ignored by git. Delete them to
start again:

```
rm -rf examples/git-basics/demo examples/git-basics/_workshop
```
