# Using workshops

This page is for the person working through a workshop: how one is
opened, what the trust dialog asks, how to move through the pages and
what the checks want, and how to start over or clear up afterwards.
Authors and operators need it too, since it is what their learners see.

Commands named "Workshop: …" below are in JupyterLab's command palette,
the searchable list of every command, opened with Ctrl+Shift+C
(Cmd+Shift+C on a Mac) or View, Activate Command Palette. Most also have
a button in the panel header.

## Opening a workshop

The Workshop panel is the graduation cap tab in the sidebar. With no
workshop open it offers three ways in, and the panel header keeps the
same three as buttons once one is open:

- **Browse workshops** opens a tab listing the workshops already
  installed and, under Available, those the subscribed collections offer,
  grouped by collection. Install downloads one into the `workshops`
  directory under the JupyterLab root and lists it under Installed;
  Open or Resume opens an installed one. "Collections…" subscribes to
  and unsubscribes from collections and catalogs; see [Finding and installing workshops](collections.md).

- **Open a directory** opens a workshop directory that is already on
  disk, by path relative to the JupyterLab root. Right-clicking a
  directory in the file browser and choosing "Open as Workshop" does the
  same.

- **Open from URL** downloads a workshop from a git repository, a forge
  tree URL or an archive URL.

A JupyterLab URL with a `workshop` parameter, a [launch
link](collections.md#launch-links), opens a workshop as soon as JupyterLab
starts, which is how a course hands one out. A deployment may remove
some of these routes; see [Deploying workshops](deploying.md).

## The trust dialog

Before a workshop runs anything it shows a dialog with where it came
from, a hash of its content, the capabilities it declares with how many
actions use each (a terminal, writing files, running code in kernels,
changing settings, and so on), the number of actions that run without a
click, and any warnings the linter found in it. Three buttons choose
how far to trust it:

- **Trust** runs every declared capability, including automatic runs.

- **Restricted** turns commands into text: `execute` types the command
  into the terminal and leaves you to press Enter, and actions that
  write files, change notebooks, run code, press keys or change settings
  show what they will do and ask first. Automatic runs are skipped. This
  is the default choice, and the sensible one for a workshop you do not
  know.

- **Ask each time** confirms every action that needs a capability, with
  an Allow button that can also allow that capability for the rest of
  the workshop.

```{figure} _static/trust-dialog.png
:alt: The trust dialog
:width: 100%

The trust dialog for a showcase workshop.
```

Cancel leaves the workshop closed. The choice is remembered for that
workshop at that content, so it opens without asking next time and asks
again only if it has changed. The badge in the panel header shows the
level; clicking it, or "Workshop: Change Trust Level…", brings the
dialog back. In restricted mode the affected actions carry a badge
saying "types only", "confirms" or "auto off", and an action whose
capability the workshop never declared says "not allowed" and does not
run at any level. A workshop that asks to report progress to a server
adds a checkbox, off by default; see [Progress events](analytics.md).

## Reading and clicking

The panel shows one page at a time. The header has the workshop title,
a progress bar and a page selector; the footer has Previous and Next,
and Finish on the last page. Prose explains the step and the boxes are
actions: each shows what it will do, a command, a file, a notebook cell,
and clicking runs it in the session beside the panel. A tick or a cross
on the box shows how it went, and a failure shows its message under the
box. Clicking again runs it again. Some actions run by themselves when a
page opens or after another action, which the workshop declares up
front.

The workshop may arrange the window when it opens: a rendered README, a
terminal, a notebook. Drag things where you like; the arrangement is
remembered, and "Workshop: Reset Layout" puts the workshop's own back.
Commands typed by hand into a workshop terminal work as well as clicked
ones; the workshop's checks look at results, not at what was clicked.

## Checks, quizzes and forms

A check is a box with a label, a Check button and its last result. Many
run on their own when the action before them completes or when the
terminal shows something, so a step often ticks itself; Check runs it
now. A failing check says what is missing in plain words written by the
author. A quiz asks a question with one or several right answers and
may limit attempts; a wrong answer explains why. A form collects values
the rest of the workshop uses, such as a name or a directory, and can
be submitted again to change them.

A page may require some of these before moving on. With soft gating the
footer lists what is still to do, with links that scroll to it, but
Next still works and the page is not counted as done; with strict
gating Next waits. Moving forwards with the requirements met marks the
page done, which fills the progress bar and ticks the page in the
selector. The page selector always allows going back.

## Finishing

Finish on the last page marks it done and opens a dialog saying the
workshop is complete, with what to do next: browse other workshops,
close this one, shut the session down on Binder, or keep reading. The
author may add a note there, such as where to go next. Afterwards the
footer shows Finished with a "What next?" link that brings the dialog
back.

```{figure} _static/finish-dialog.png
:alt: The Finish dialog
:width: 60%

The Finish dialog, with the next workshop of the collection, browsing
and closing on offer.
```

## Starting over and clearing up

Everything the workshop records lives in a `_workshop` directory inside
it, and three commands in the panel header and the command palette
deal with it:

- **Restart** ("Workshop: Restart…", the restart button in the header,
  or Restart on the workshop's card in the browser) puts the workshop's
  files back as they were when it was first opened, deleting anything
  added since, forgets all progress, closes the documents and terminals
  it had open, and reopens it at the first page. It works offline and
  in JupyterLite. It only covers files inside the workshop directory,
  so a workshop that writes elsewhere, such as into the home directory,
  is not undone there.

- **Reset Progress** ("Workshop: Reset Progress…") forgets page
  progress, action results, captured variables and the action log,
  restores any JupyterLab settings the workshop changed, and reopens it
  at the first page, keeping the files as they are.

- **Remove** ("Workshop: Remove…", or Remove on the card in the
  browser) lists what it will do before doing it: delete the workshop
  directory for a downloaded workshop (for a local directory only the
  `_workshop` state is removed), restore any settings the workshop
  changed, unregister the kernel of an [isolated
  environment](environment.md) it created, and forget the trust
  decision.

Closing a workshop, from the header button or the Finish dialog, closes
the documents it put on screen and shuts down its terminals, so the next
workshop starts in a clear window. A file with unsaved changes asks
first. Restart and Remove do the same before touching the files.

## Variables and the action log

The gear button in the header, or "Workshop: Variables…", lists the
workshop's variables with their current values and where each came
from, and lets you change the ones the workshop allows; see
[Variables](variables.md). "Workshop: Show Action Log" lists every
action that ran, was skipped or asked for confirmation, with its time,
page, description and result, which is also where to look when
something did not do what the page said it would.

```

```
