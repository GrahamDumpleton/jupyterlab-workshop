# Progress events

The extension records what happens during a workshop as a stream of
events. They stay on the learner's machine unless the learner opts in to
a sink a workshop or its collection names, or an administrator
configures one. The format is published as a JSON schema, so a service
receiving events can validate them; the [events
reference](reference/events.md) is generated from it and lists every
field.

## Events

Every event carries the same base fields: what happened (`kind`) and
when (`ts`); which open of which workshop it belongs to (`session_id`,
`workshop`, `name`, `version`, `source`, `collection`, and
`collection_id` and `collection_title` when the collection's index
declares them); which running
JupyterLab it happened under (`instance_id`); its place in the session
(`seq`); where it ran (`frontend`, `frontend_version`, `host`,
`platform`, `trust`); the `labels` of the analytics block that supplied
the sink; and `user`, only where a deployment's identity policy adds
one. The kinds and their extra fields:

| Kind                  | Fields                                          | When                                                         |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `workshop-start`      | `page`, `pages`, `restarted_from`               | A workshop is opened for the first time, or after a restart. |
| `workshop-resume`     | `page`, `pages`, `resumed_from`                 | A workshop with recorded progress is opened again.           |
| `workshop-finish`     | `pages`                                         | Finish is pressed on the last page.                          |
| `workshop-abandon`    | `page`                                          | The workshop is closed or replaced before finishing.         |
| `page-enter`          | `page`                                          | A page is shown.                                             |
| `page-leave`          | `page`, `active_ms`                             | A page is left, with the time spent on it.                   |
| `heartbeat`           | `page`, `hidden`                                | Every minute while visible, every five while hidden.         |
| `action-executed`     | `id`, `type`, `status`, `trigger`, `downgraded` | An action ran, was skipped or failed.                        |
| `verify-result`       | `id`, `status`, `attempt`, `trigger`            | A check ran.                                                 |
| `quiz-answered`       | `id`, `correct`, `attempt`                      | A quiz was answered.                                         |
| `form-submitted`      | `id`, `fields`                                  | A form was submitted (field names only, never values).       |
| `hint-opened`         | `id`                                            | A hint was expanded.                                         |
| `checkpoint-restored` | `name`                                          | A checkpoint was restored.                                   |
| `gate-skipped`        | `page`, `requirements`                          | The learner moved on past unmet requirements.                |
| `preflight-result`    | `tools`                                         | The required tools were checked.                             |
| `environment-created` | `kernel`                                        | The isolated environment was created.                        |

Events never include file contents, command output, variable values or
form answers.

A workshop is identified across deployments by its `name` and its
collection. `collection` is where the collection was subscribed from,
a URL or a path, which differs between deployments of the same
collection, so an index that declares an [`id`](collections.md#index-format)
has it sent as `collection_id`, and a service keys on that when it is
present and on `collection` otherwise. `collection_title` is the
index's title, for display.

### Sessions, instances and sequence numbers

A session is one open of a workshop; every event of it carries the same
`session_id` and a `seq` that counts from one, so a service can tell
which events it received from which it should have and find the gaps
where a batch was lost. Closing the workshop and opening it again is a
new session whose `workshop-resume` names the old one in
`resumed_from`, and choosing Restart in the dialog described below is a
new session whose `workshop-start` names it in `restarted_from`, so the
learner's journey chains either way.

An instance is one running JupyterLab: one run of the Jupyter server,
or one page load of a [JupyterLite](lite.md) site. Every workshop opened
under it carries the same `instance_id`, which is how a service groups
the workshops one learner took in one sitting and shows how far they
got through a collection. A restarted server, or a stopped and resumed
codespace, is a new instance.

The `pages` list on `workshop-start` and `workshop-resume` gives the
visible pages in order, each with its `id`, `path` and `title`, so a
service can compute a funnel and show "page 3 of 8" without reading the
workshop, and each session keeps the list it actually ran with. Every
other event names a page by its id alone, which is the file name without
its extension unless the page's front matter sets `id`.

Each page entry also carries `directives`, since 0.2.1: the directives
on the page that can produce an event, in document order, so a service
can tell what nobody ran from what was there to run. Each is listed
with its `id`, as `action-executed`, `verify-result`, `quiz-answered`,
`form-submitted` and `hint-opened` report it, its `type` (an action
type such as `execute`, or `verify`, `quiz`, `form` or `hint`), and its
`trigger`, how it is expected to start, in the words those events use:
`auto` for a directive carrying `auto`, `cascade` for the target of
another directive's `cascade`, `trigger` for a check whose `trigger`
lists anything beyond a click, and `click` otherwise, the first of
those winning where more than one applies and the manifest's
`defaults.actions` applied under the page's own options. An entry
inside a `{when}` block, or carrying its own `when`, has
`conditional: true`, since whether the learner ever saw it depends on
the variables when the page was shown. Inline roles have no ids and
produce no events, so they are not listed. A sink that holds page
entries to an older copy of the schema rejects the event that carries
the field, so a sink is brought up to date before the extension that
sends it is released.

A `heartbeat` is sent every minute while the browser tab is visible and
every five minutes while it is hidden, with `hidden` saying which, and
once at every change between the two, so a service can tell a learner
who switched windows from a tab that was closed or a server that was
culled: the first keeps beating with the flag set, the second goes
quiet. `workshop-abandon` is the explicit signal when the extension sees
the close; a closed tab sends nothing.

### Resuming after a restart

Progress is kept in the workshop directory, but the terminals, running
programs and notebook kernels a workshop set up on earlier pages belong
to the JupyterLab process, and a restarted server or a reloaded
JupyterLite page has none of them. Unless the manifest says the
workshop can be continued regardless, with `resumable: true`, reopening
a workshop under a new instance asks first: Restart, the default, puts
the files back and forgets the progress; Continue carries on where the
learner left off. The workshop browser's card shows the same choice,
with Restart first and a "needs restart" chip, so the learner sees it
before opening. A workshop whose steps leave nothing live behind, one
that only edits files say, sets `resumable: true` and continues
silently.

## Local file and export

Events are appended to `_workshop/events.jsonl` in the workshop
directory, one JSON object per line. "Workshop: Export Progress Events"
downloads the file, which is how an offline class hands progress to an
instructor. Removing or resetting the workshop deletes it with the rest
of the state directory. Because every line carries the labels and the
identity fields, the file needs nothing beside it to be understood.

## Reporting to a sink

An `analytics` block says where events go, with what credential, and
how they are labelled. The same block, with the same shape, can be
declared at three levels, and the highest level that declares one
applies, whole:

```yaml
analytics:
  sink: https://analytics.example.org/events
  token: eyJhbGciOi...
  labels:
    course: intro-git
    term: 2026-s2
```

1. **The deployment.** An administrator's `analytics` setting, typically
   in `overrides.json`, applies to every workshop without asking, and is
   the only level that may also set `identity`; see [reporting
   progress](deploying.md#reporting-progress). A deployment's setting
   takes precedence over anything a collection or a workshop declares,
   so an author should not expect their sink to hear from a hub that
   reports elsewhere.

2. **A collection.** An `analytics` block in a [collection
   index](collections.md#index-format) applies to every workshop the
   collection lists, with the learner's opt-in. This is the level for an
   author who wants to know how their workshops fare on other people's
   machines.

3. **The workshop.** A block in the manifest applies to that workshop,
   with opt-in, for a standalone workshop that belongs to no collection.

For the collection and workshop levels the trust dialog shows a
checkbox, off by default, "Report my progress to
analytics.example.org", naming the collection when it is the
collection's sink. Nothing is sent unless it is ticked; the choice is
stored with the trust decision and can be changed from "Workshop: Change
Trust Level…". Blocks are never merged: the effective sink, token and
labels all come from one level.

`sink` is the URL that receives batches of events. `token`, when set, is
sent with every batch as a bearer credential in the `Authorization`
header, never in the URL, so the sink URL is safe to log; a sink may
also accept it as a `token` query parameter for a configuration that
must stay URL-only. The token is issued by the sink's operator and is
opaque to the extension. At the collection and workshop levels, and in
any public repository, it is public by construction, so a sink treats it
as routing rather than as a secret.

`labels` are key and value pairs stamped on every event so a service can
slice reports by them: a course, a cohort, a term, an instructor. They
are for slicing, never for identity: the workshop's name, source,
collection, host and frontend are fields every event already carries,
and a label repeating one of them is redundant. Keys are lower case
letters, digits, underscore, dot and hyphen up to 63 characters, values
are up to 128, and a block carries at most 16; a block that breaks the
rules is refused rather than trimmed.

Batches are posted by the server, not the browser, as
`application/x-ndjson` bodies whose lines are the events, so the sink
needs no CORS headers. In [JupyterLite](lite.md) there is no server: the
browser posts the same bodies itself, so a sink used from there must
allow cross-origin requests from the site, including the `Authorization`
header when a token is set. A sink is any endpoint that accepts a POST;
a few lines of any web framework that appends the body to a file is
enough, and `jupyter workshop schema --events` prints the schema to
validate against. Delivery is best effort: a sink that is down loses the
batch, the sequence numbers show the gap, and the local file remains the
record.
