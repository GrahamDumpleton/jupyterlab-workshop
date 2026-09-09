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
:id: run-all
:path: scratch/hello.ipynb
```

The check below passes once the cell tagged `answer` has been run. It
re-runs whenever a cell with that tag is executed.

```{verify}
:id: answer-ran
:label: The answer cell has been run
:substrate: contents
:trigger: cell-executed answer; after:run-all
cell-executed scratch/hello.ipynb answer
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

A check can run in the notebook's own kernel and see what the cells
computed; the value of its last expression decides.

```{verify}
:id: answer-doubled
:label: answer times two is 84 in the notebook's kernel
:substrate: learner-kernel
:path: scratch/hello.ipynb
:trigger: cell-executed doubled
answer * 2 == 84
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
