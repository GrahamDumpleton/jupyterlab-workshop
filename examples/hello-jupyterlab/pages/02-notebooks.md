---
title: Notebooks
---

# Notebooks

Create a notebook from a list of cells. It opens in the main area.

```{notebook-create}
:path: scratch/hello.ipynb
- markdown: |
    # Hello notebook
    Created by a workshop action.
- code: |
    message = "Hello from a notebook"
    print(message)
- code: |
    answer = 6 * 7
    answer
  tags: [answer]
```

Run every cell. The kernel starts if it has not already.

```{cell-run-all}
:path: scratch/hello.ipynb
```

Insert a new code cell after the cell tagged `answer`, tagging it too.

```{cell-insert}
:path: scratch/hello.ipynb
:at: after:answer
:tags: [doubled]
print(answer * 2)
```

Run just that cell, then highlight it.

```{cell-run}
:path: scratch/hello.ipynb
:cell: doubled
```

```{cell-highlight}
:path: scratch/hello.ipynb
:cell: doubled
```

Clear the outputs and select the second cell.

```{output-clear}
:path: scratch/hello.ipynb
```

```{cell-select}
:path: scratch/hello.ipynb
:cell: 2
```
