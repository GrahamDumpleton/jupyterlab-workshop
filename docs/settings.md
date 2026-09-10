# Settings reference

The extension has one settings plugin, `@jupyterlab-workshop/labextension:panel`,
shown as Workshop in the JupyterLab settings editor. A learner changes
the personal settings there; an administrator sets the deployment ones
site-wide in `overrides.json`, JupyterLab's file of setting overrides,
under that plugin key:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "defaultWorkshop": "",
    "browseOnStart": true
  }
}
```

The file is `settings/overrides.json` under JupyterLab's application
directory, which is `share/jupyter/lab` in the environment JupyterLab
runs from; `jupyter lab path` prints it. [Deploying workshops](deploying.md) shows the combinations a
Binder image or a classroom uses.

## Personal settings

| Setting              | Type   | Default      | Meaning                                                                                                                                                                                               |
| -------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultWorkshop`    | string | `""`         | Directory of the workshop to open when JupyterLab starts and no workshop was open before, relative to the JupyterLab root. Empty, the default, opens nothing.                                         |
| `panelSide`          | string | `right`      | Which sidebar the panel starts in, `left` or `right`. Dragging the panel to the other side is remembered by JupyterLab's layout, and a workshop layout naming `instructions` for a side overrides it. |
| `workshopsDirectory` | string | `workshops`  | Directory, relative to the JupyterLab root, that downloaded workshops are placed in and that the browser lists as installed.                                                                          |
| `defaultTrustLevel`  | string | `restricted` | The button selected by default in the trust dialog for a workshop with no stored decision: `trusted`, `restricted` or `ask`.                                                                          |
| `collections`        | list   | `[]`         | Subscribed collections, whose workshops the browser offers: `http(s)` URLs of `collection.json` files, or paths relative to the JupyterLab root. The Collections dialog edits this list.              |
| `catalogs`           | list   | `[]`         | Subscribed catalogs, whose collections the browser offers to subscribe to: `http(s)` URLs of `catalog.json` files, or paths relative to the JupyterLab root.                                          |

## Deployment settings

These are meant for `overrides.json`, though nothing stops a learner
setting them.

| Setting            | Type    | Default | Meaning                                                                                                                                                                                                                                        |
| ------------------ | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browseOnStart`    | boolean | `false` | Open the workshop browser in place of the launcher, with both sidebars collapsed, when JupyterLab starts with no workshop to open or restore. See [starting in the browser](deploying.md#starting-in-the-browser).                             |
| `trustPolicy`      | object  | `{}`    | Administrator trust decisions; the keys are below. See [settling trust](deploying.md#settling-trust).                                                                                                                                          |
| `disabledFeatures` | list    | `[]`    | Parts of the extension to remove, from `open-directory`, `open-url`, `collections`, `catalogs`, `available`, `install-all`, `remove`, `close`, `browse` and `author`. See [locking down a deployment](deploying.md#locking-down-a-deployment). |
| `analytics`        | object  | `{}`    | Site-wide reporting of progress events; the keys are below. See [reporting progress](deploying.md#reporting-progress).                                                                                                                         |
| `welcome`          | string  | `""`    | Path, relative to the JupyterLab root, of a Markdown file shown in a dialog when JupyterLab starts, once per browser for the server. See [a welcome message](deploying.md#a-welcome-message).                                                  |

`trustPolicy` holds:

| Key                    | Type           | Default | Meaning                                                                                                                       |
| ---------------------- | -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `forcedLevel`          | string or null | `null`  | When set, every workshop opens at this level and the trust dialog is not shown.                                               |
| `trustedSources`       | list           | `[]`    | Source key prefixes that open as trusted without asking, such as `git:https://github.com/example-org/` or `local:workshops/`. |
| `disabledCapabilities` | list           | `[]`    | Capabilities that never run regardless of the trust level.                                                                    |

`analytics` holds:

| Key        | Type   | Default | Meaning                                                                                                                                          |
| ---------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sink`     | string | `""`    | URL that receives every workshop's events as JSON lines by POST, without asking the learner. Empty reports only to sinks the learner opts in to. |
| `identity` | string | `none`  | Whether events carry the JupyterHub user name (`hub`) or no identity (`none`).                                                                   |

Events are always written to `_workshop/events.jsonl` in the workshop
directory whatever these say; see [Progress events](analytics.md).
