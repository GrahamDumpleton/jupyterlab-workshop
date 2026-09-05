---
title: Kernels
---

# Kernels

Workshops can run code in a notebook's kernel without adding a cell, and
capture the output into a variable. This stores the Python version.

```{kernel-execute}
:path: scratch/hello.ipynb
:capture: python_version
import sys
print(sys.version.split()[0])
```

The notebook is running Python {var}`python_version`. The value appears
above once the action has run, because the page re-renders when variables
change.

Commands can also run in the background, through a hidden workshop kernel
on a server or the terminal's shell in JupyterLite, with their output
captured. JupyterLite has no `python3` command, so that platform gets a
variant of its own.

```{execute-capture}
:capture: answer
python3 -c "print(6 * 7)"
:lite:
echo 42
```

The answer is {var}`answer`.

Kernels can be interrupted and restarted.

```{kernel-interrupt}
:path: scratch/hello.ipynb
```

```{kernel-restart}
:path: scratch/hello.ipynb
```

A console attached to the notebook's kernel lets you poke at its state.

```{console-open}
:path: scratch/hello.ipynb
```
