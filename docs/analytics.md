# Progress events

The extension records what happens during a workshop as a stream of
events. They stay on the learner's machine unless the learner opts in to
a sink the workshop names, or an administrator configures one.

## Events

Every event carries `kind`, `ts` (ISO time), `session_id` (random per
open of the workshop), `workshop` (its directory), `version`, `platform`
and `trust`. The kinds and their extra fields:

| Kind                  | Fields                                          | When                                                   |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `workshop-start`      | `page`                                          | A workshop is opened for the first time.               |
| `workshop-resume`     | `page`                                          | A workshop with recorded progress is opened again.     |
| `workshop-finish`     | `pages`                                         | The last page is marked done.                          |
| `workshop-abandon`    | `page`                                          | The workshop is closed or replaced before finishing.   |
| `page-enter`          | `page`                                          | A page is shown.                                       |
| `page-leave`          | `page`, `active_ms`                             | A page is left, with the time spent on it.             |
| `action-executed`     | `id`, `type`, `status`, `trigger`, `downgraded` | An action ran, was skipped or failed.                  |
| `verify-result`       | `id`, `status`, `attempt`, `trigger`            | A check ran.                                           |
| `quiz-answered`       | `id`, `correct`, `attempt`                      | A quiz was answered.                                   |
| `form-submitted`      | `fields`                                        | A form was submitted (field names only, never values). |
| `hint-opened`         | `id`                                            | A hint was expanded.                                   |
| `checkpoint-restored` | `name`                                          | A checkpoint was restored.                             |
| `gate-skipped`        | `page`, `requirements`                          | The learner moved on past unmet requirements.          |
| `preflight-result`    | `tools`                                         | The required tools were checked.                       |
| `environment-created` | `kernel`                                        | The isolated environment was created.                  |

Events never include file contents, command output, variable values or
form answers.

## Local file and export

Events are appended to `_workshop/events.jsonl` in the workshop
directory, one JSON object per line. "Workshop: Export Progress Events"
downloads the file, which is how an offline class hands progress to an
instructor. Removing or resetting the workshop deletes it with the rest
of the state directory.

## Reporting to a sink

A workshop can ask for its events:

```yaml
analytics:
  sink: https://workshops.example.org/events
```

The trust dialog then shows a checkbox, off by default, "Report my
progress to workshops.example.org". Nothing is sent unless it is ticked;
the choice is stored with the trust decision and can be changed from
"Workshop: Change Trust Level…".

An administrator can report every workshop's events without asking, for
example under JupyterHub, through the `analytics` setting in
`overrides.json`:

```json
{
  "@educates/jupyterlab-workshop:panel": {
    "analytics": {
      "sink": "https://workshops.example.org/events",
      "identity": "hub"
    }
  }
}
```

`identity` is `none` (the default) or `hub`, which adds the
`JUPYTERHUB_USER` name to every event as `user`.

Batches are posted by the server, not the browser, as
`application/x-ndjson` bodies to the sink URL, so the sink needs no CORS
headers. In [JupyterLite](lite.md) there is no server: the browser posts
the same bodies itself, so a sink used from there must allow cross-origin
requests from the site. A sink is any endpoint that accepts a POST; a few lines of any
web framework that appends the body to a file is enough. Delivery is
best effort: a sink that is down loses the batch, and the local file
remains the record.
