import {
  ACTION_TYPES,
  ActionGroup,
  COMMON_OPTIONS,
  IActionTypeSpec,
  IDirectiveDraft,
  RecordedEvent
} from '@jupyterlab-workshop/core';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ReactWidget } from '@jupyterlab/ui-components';
import React from 'react';

/** Groups of actions as the insert form lists them. */
const GROUP_LABELS: Readonly<Record<ActionGroup, string>> = {
  terminal: 'Terminal',
  files: 'Files and editor',
  notebook: 'Notebooks and kernels',
  ui: 'Interface and layout',
  guidance: 'Guidance',
  flow: 'Flow and variables',
  checks: 'Checks, forms and checkpoints',
  external: 'Other'
};

const PLATFORMS: readonly string[] = ['linux', 'macos', 'windows', 'lite'];

const CAPABILITIES: readonly string[] = [
  'terminal',
  'write-files:workspace',
  'write-files:home',
  'write-files:any',
  'kernel-exec',
  'network',
  'install-packages',
  'auto-run',
  'ui-settings'
];

/**
 * A dialog body whose value is edited by a React component and read back
 * when the dialog closes.
 */
class ValueBody<T> extends ReactWidget implements Dialog.IBodyWidget<T> {
  constructor(
    initial: T,
    render: (value: T, update: (next: T) => void) => JSX.Element
  ) {
    super();

    this._value = initial;
    this._renderValue = render;
  }

  getValue(): T {
    return this._value;
  }

  protected render(): JSX.Element {
    return this._renderValue(this._value, next => {
      this._value = next;
      this.update();
    });
  }

  private _value: T;
  private _renderValue: (value: T, update: (next: T) => void) => JSX.Element;
}

function Field({
  label,
  children,
  hint
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <label className="jp-WorkshopAuthor-field">
      <span className="jp-WorkshopAuthor-fieldLabel">{label}</span>
      {children}
      {hint ? (
        <span className="jp-WorkshopAuthor-fieldHint">{hint}</span>
      ) : null}
    </label>
  );
}

/** What the new workshop wizard asks for. */
export interface INewWorkshopRequest {
  directory: string;
  name: string;
  title: string;
  template: string;
  platforms: string[];
  capabilities: string[];
  gating: string;
  ci: boolean;
}

/**
 * Ask for the details of a new workshop.
 */
export async function showNewWorkshopDialog(
  defaultDirectory: string
): Promise<INewWorkshopRequest | null> {
  const initial: INewWorkshopRequest = {
    directory: defaultDirectory,
    name: '',
    title: '',
    template: 'starter',
    platforms: ['linux', 'macos'],
    capabilities: ['terminal', 'write-files:workspace'],
    gating: 'soft',
    ci: false
  };
  const templateCapabilities: Record<string, string[]> = {
    starter: ['terminal', 'write-files:workspace'],
    blank: [],
    notebook: ['write-files:workspace', 'kernel-exec']
  };
  const body = new ValueBody<INewWorkshopRequest>(initial, (value, update) => {
    const toggle = (
      key: 'platforms' | 'capabilities',
      item: string,
      on: boolean
    ): void =>
      update({
        ...value,
        [key]: on
          ? [...value[key], item]
          : value[key].filter(entry => entry !== item)
      });

    return (
      <div className="jp-WorkshopAuthor-form">
        <Field label="Title">
          <input
            type="text"
            className="jp-WorkshopAuthor-input"
            value={value.title}
            placeholder="Git from the command line"
            onChange={event => {
              const title = event.target.value;
              const name = slugify(title);
              const directory = value.directory.replace(
                /[^/]*$/,
                name || 'new-workshop'
              );

              update({ ...value, title, name, directory });
            }}
          />
        </Field>
        <Field label="Name" hint="Lower case letters, digits and hyphens.">
          <input
            type="text"
            className="jp-WorkshopAuthor-input"
            value={value.name}
            onChange={event => update({ ...value, name: event.target.value })}
          />
        </Field>
        <Field
          label="Directory"
          hint="Relative to the JupyterLab root; it is created."
        >
          <input
            type="text"
            className="jp-WorkshopAuthor-input"
            value={value.directory}
            onChange={event =>
              update({ ...value, directory: event.target.value })
            }
          />
        </Field>
        <Field label="Template">
          <select
            className="jp-WorkshopAuthor-input"
            value={value.template}
            onChange={event =>
              update({
                ...value,
                template: event.target.value,
                capabilities: templateCapabilities[event.target.value] ?? []
              })
            }
          >
            <option value="starter">
              Starter: terminal, file, check, quiz
            </option>
            <option value="blank">Blank: one page of prose</option>
            <option value="notebook">Notebook: cells and a kernel check</option>
          </select>
        </Field>
        <Field label="Platforms">
          <span className="jp-WorkshopAuthor-checks">
            {PLATFORMS.map(platform => (
              <label key={platform}>
                <input
                  type="checkbox"
                  checked={value.platforms.includes(platform)}
                  onChange={event =>
                    toggle('platforms', platform, event.target.checked)
                  }
                />{' '}
                {platform}
              </label>
            ))}
          </span>
        </Field>
        <Field label="Capabilities">
          <span className="jp-WorkshopAuthor-checks">
            {CAPABILITIES.map(capability => (
              <label key={capability}>
                <input
                  type="checkbox"
                  checked={value.capabilities.includes(capability)}
                  onChange={event =>
                    toggle('capabilities', capability, event.target.checked)
                  }
                />{' '}
                {capability}
              </label>
            ))}
          </span>
        </Field>
        <Field label="Gating">
          <select
            className="jp-WorkshopAuthor-input"
            value={value.gating}
            onChange={event => update({ ...value, gating: event.target.value })}
          >
            <option value="off">off: requirements are ignored</option>
            <option value="soft">soft: show what is missing</option>
            <option value="strict">strict: block Next until done</option>
          </select>
        </Field>
        <label className="jp-WorkshopAuthor-check">
          <input
            type="checkbox"
            checked={value.ci}
            onChange={event => update({ ...value, ci: event.target.checked })}
          />{' '}
          Write a GitHub Actions workflow that lints and self-tests it
        </label>
      </div>
    );
  });

  const result = await showDialog<INewWorkshopRequest>({
    title: 'New workshop',
    body,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Create' })],
    hasClose: true
  });

  if (!result.button.accept || !result.value) {
    return null;
  }

  const value = result.value;

  return value.directory.trim() === '' ? null : value;
}

/** One page as the page manager edits it. */
export interface IPageEntry {
  path: string;
  title: string;
  optional: boolean;
  requires: string;
  isNew: boolean;
  removed: boolean;
}

/**
 * Show the page manager: reorder, rename, add and remove pages and set
 * their gating fields.
 */
export async function showPageManagerDialog(
  pages: IPageEntry[]
): Promise<IPageEntry[] | null> {
  const body = new ValueBody<{ pages: IPageEntry[]; newTitle: string }>(
    { pages: pages.map(page => ({ ...page })), newTitle: '' },
    (value, update) => {
      const setPage = (index: number, changes: Partial<IPageEntry>): void =>
        update({
          ...value,
          pages: value.pages.map((page, position) =>
            position === index ? { ...page, ...changes } : page
          )
        });
      const move = (index: number, delta: number): void => {
        const target = index + delta;

        if (target < 0 || target >= value.pages.length) {
          return;
        }

        const next = [...value.pages];

        [next[index], next[target]] = [next[target], next[index]];
        update({ ...value, pages: next });
      };
      const add = (): void => {
        const title = value.newTitle.trim();

        if (title === '') {
          return;
        }

        update({
          pages: [
            ...value.pages,
            {
              path: '',
              title,
              optional: false,
              requires: '',
              isNew: true,
              removed: false
            }
          ],
          newTitle: ''
        });
      };

      return (
        <div className="jp-WorkshopAuthor-form jp-WorkshopAuthor-pages">
          <table className="jp-WorkshopAuthor-pageTable">
            <thead>
              <tr>
                <th className="jp-WorkshopAuthor-pageCell">Title</th>
                <th className="jp-WorkshopAuthor-pageCell">File</th>
                <th
                  className="jp-WorkshopAuthor-pageCell"
                  title="Optional page"
                >
                  Opt.
                </th>
                <th className="jp-WorkshopAuthor-pageCell">Requires</th>
                <th className="jp-WorkshopAuthor-pageCell"></th>
              </tr>
            </thead>
            <tbody>
              {value.pages.map((page, index) => (
                <tr
                  key={`${page.path}-${index}`}
                  className={`jp-WorkshopAuthor-pageRow${page.removed ? ' jp-mod-removed' : ''}`}
                >
                  <td className="jp-WorkshopAuthor-pageCell">
                    <input
                      type="text"
                      className="jp-WorkshopAuthor-input"
                      value={page.title}
                      disabled={page.removed}
                      onChange={event =>
                        setPage(index, { title: event.target.value })
                      }
                    />
                  </td>
                  <td className="jp-WorkshopAuthor-pageCell">
                    <code>{page.isNew ? '(new)' : page.path}</code>
                  </td>
                  <td className="jp-WorkshopAuthor-pageCell">
                    <input
                      type="checkbox"
                      checked={page.optional}
                      disabled={page.removed}
                      onChange={event =>
                        setPage(index, { optional: event.target.checked })
                      }
                    />
                  </td>
                  <td className="jp-WorkshopAuthor-pageCell">
                    <input
                      type="text"
                      className="jp-WorkshopAuthor-input"
                      value={page.requires}
                      placeholder="verify:id, quiz:id"
                      disabled={page.removed}
                      onChange={event =>
                        setPage(index, { requires: event.target.value })
                      }
                    />
                  </td>
                  <td className="jp-WorkshopAuthor-pageCell jp-WorkshopAuthor-pageButtons">
                    <button
                      type="button"
                      className="jp-WorkshopAuthor-pageButton"
                      title="Move up"
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="jp-WorkshopAuthor-pageButton"
                      title="Move down"
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      title={
                        page.removed
                          ? 'Keep the page'
                          : 'Remove from the workshop (the file stays)'
                      }
                      onClick={() => setPage(index, { removed: !page.removed })}
                    >
                      {page.removed ? '↶' : '✕'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="jp-WorkshopAuthor-addPage">
            <input
              type="text"
              className="jp-WorkshopAuthor-input"
              value={value.newTitle}
              placeholder="Title of a new page"
              onChange={event =>
                update({ ...value, newTitle: event.target.value })
              }
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <button
              type="button"
              className="jp-Button jp-mod-styled"
              onClick={add}
            >
              Add page
            </button>
          </div>
        </div>
      );
    }
  );

  const result = await showDialog({
    title: 'Pages',
    body,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Apply' })],
    hasClose: true
  });

  return result.button.accept && result.value ? result.value.pages : null;
}

/** The action form's value. */
export interface IActionFormValue extends IDirectiveDraft {
  name: string;
}

/**
 * Show the insert or edit action form.
 */
export async function showActionFormDialog(
  initial: IActionFormValue | null
): Promise<IActionFormValue | null> {
  const start: IActionFormValue = initial ?? {
    name: 'execute',
    options: {},
    body: ''
  };
  const body = new ValueBody<IActionFormValue>(start, (value, update) => {
    const spec: IActionTypeSpec | undefined = ACTION_TYPES[value.name];
    const setOption = (option: string, text: string): void => {
      const options = { ...value.options };

      if (text === '') {
        delete options[option];
      } else {
        options[option] = text;
      }

      update({ ...value, options });
    };
    const groups = new Map<ActionGroup, IActionTypeSpec[]>();

    for (const item of Object.values(ACTION_TYPES)) {
      groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    }

    return (
      <div className="jp-WorkshopAuthor-form">
        <Field label="Action" hint={spec?.description}>
          <select
            className="jp-WorkshopAuthor-input"
            value={value.name}
            disabled={initial !== null}
            onChange={event => update({ ...value, name: event.target.value })}
          >
            {[...groups.entries()].map(([group, items]) => (
              <optgroup key={group} label={GROUP_LABELS[group]}>
                {items.map(item => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        {value.name === 'when' ? (
          <Field label="Condition">
            <input
              type="text"
              className="jp-WorkshopAuthor-input"
              value={value.argument ?? ''}
              onChange={event =>
                update({ ...value, argument: event.target.value })
              }
            />
          </Field>
        ) : null}
        {(spec?.options ?? []).map(option => (
          <Field key={option} label={option}>
            <input
              type="text"
              className="jp-WorkshopAuthor-input"
              value={value.options[option] ?? ''}
              onChange={event => setOption(option, event.target.value)}
            />
          </Field>
        ))}
        <details className="jp-WorkshopAuthor-common">
          <summary className="jp-WorkshopAuthor-commonSummary">
            Common options
          </summary>
          {COMMON_OPTIONS.map(option => (
            <Field key={option} label={option}>
              <input
                type="text"
                className="jp-WorkshopAuthor-input"
                value={value.options[option] ?? ''}
                onChange={event => setOption(option, event.target.value)}
              />
            </Field>
          ))}
        </details>
        {spec?.body !== 'none' ? (
          <Field
            label="Body"
            hint={
              spec?.body === 'yaml'
                ? 'YAML, as the documentation for this directive shows.'
                : spec?.body === 'markdown'
                  ? 'Markdown.'
                  : spec?.body === 'required'
                    ? 'Required. A :windows: line starts a Windows variant.'
                    : 'Optional.'
            }
          >
            <textarea
              className="jp-WorkshopAuthor-input jp-WorkshopAuthor-textarea"
              rows={8}
              value={value.body}
              spellCheck={false}
              onChange={event => update({ ...value, body: event.target.value })}
            />
          </Field>
        ) : null}
      </div>
    );
  });

  const result = await showDialog<IActionFormValue>({
    title: initial ? `Edit ${initial.name}` : 'Insert action',
    body,
    buttons: [
      Dialog.cancelButton(),
      Dialog.okButton({ label: initial ? 'Save' : 'Insert' })
    ],
    hasClose: true
  });

  return result.button.accept && result.value ? result.value : null;
}

/**
 * Describe a recorded event in a line.
 */
export function describeEvent(event: RecordedEvent): string {
  switch (event.kind) {
    case 'terminal':
      return `Ran: ${event.command}`;
    case 'file-saved':
      return `${event.previous === null ? 'Wrote' : 'Changed'} ${event.path}`;
    case 'cell-executed':
      return `Ran a cell in ${event.path}: ${event.source.split('\n')[0]}`;
    case 'file-opened':
      return `Opened ${event.path}`;
    case 'page-break':
      return `New page: ${event.title}`;
  }
}

/**
 * Let the author pick recent events to add to the page.
 */
export async function showCaptureDialog(
  events: readonly RecordedEvent[]
): Promise<RecordedEvent[] | null> {
  if (events.length === 0) {
    await showDialog({
      title: 'Nothing to capture',
      body: 'Run a command in a terminal, save a file or run a cell first; the recorder keeps the last few things done in the session while author mode is on.',
      buttons: [Dialog.okButton()]
    });

    return null;
  }

  const newestFirst = [...events].reverse();
  const body = new ValueBody<boolean[]>(
    newestFirst.map((_, index) => index === 0),
    (value, update) => (
      <div className="jp-WorkshopAuthor-form">
        <p>Add these steps to the current page, oldest first:</p>
        {newestFirst.map((event, index) => (
          <label key={index} className="jp-WorkshopAuthor-check">
            <input
              type="checkbox"
              checked={value[index]}
              onChange={event =>
                update(
                  value.map((item, position) =>
                    position === index ? event.target.checked : item
                  )
                )
              }
            />{' '}
            <code>{describeEvent(event)}</code>
          </label>
        ))}
      </div>
    )
  );

  const result = await showDialog<boolean[]>({
    title: 'Capture from session',
    body,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Add' })],
    hasClose: true
  });

  if (!result.button.accept || !result.value) {
    return null;
  }

  const picked = result.value;

  return newestFirst.filter((_, index) => picked[index]).reverse();
}

/** What to do with a finished recording. */
export interface IRecordingChoice {
  mode: 'append' | 'new' | 'discard';
  directory: string;
  title: string;
}

/**
 * Ask what to do with the recording that just ended.
 */
export async function showRecordingDialog(
  count: number,
  canAppend: boolean,
  defaultDirectory: string
): Promise<IRecordingChoice> {
  const body = new ValueBody<IRecordingChoice>(
    {
      mode: canAppend ? 'append' : 'new',
      directory: defaultDirectory,
      title: 'Recorded workshop'
    },
    (value, update) => (
      <div className="jp-WorkshopAuthor-form">
        <p>
          {count} {count === 1 ? 'step was' : 'steps were'} recorded. Each
          becomes an action with a placeholder paragraph to fill in.
        </p>
        {canAppend ? (
          <label className="jp-WorkshopAuthor-check">
            <input
              type="radio"
              checked={value.mode === 'append'}
              onChange={() => update({ ...value, mode: 'append' })}
            />{' '}
            Add pages to the open workshop
          </label>
        ) : null}
        <label className="jp-WorkshopAuthor-check">
          <input
            type="radio"
            checked={value.mode === 'new'}
            onChange={() => update({ ...value, mode: 'new' })}
          />{' '}
          Create a new workshop
        </label>
        {value.mode === 'new' ? (
          <>
            <Field label="Title">
              <input
                type="text"
                className="jp-WorkshopAuthor-input"
                value={value.title}
                onChange={event =>
                  update({ ...value, title: event.target.value })
                }
              />
            </Field>
            <Field label="Directory" hint="Relative to the JupyterLab root.">
              <input
                type="text"
                className="jp-WorkshopAuthor-input"
                value={value.directory}
                onChange={event =>
                  update({ ...value, directory: event.target.value })
                }
              />
            </Field>
          </>
        ) : null}
      </div>
    )
  );

  const result = await showDialog<IRecordingChoice>({
    title: 'Recording finished',
    body,
    buttons: [
      Dialog.cancelButton({ label: 'Discard' }),
      Dialog.okButton({ label: 'Write pages' })
    ],
    hasClose: true
  });

  if (!result.button.accept || !result.value) {
    return { mode: 'discard', directory: '', title: '' };
  }

  return result.value;
}

/**
 * Show what publishing produced.
 */
export async function showPublishResult(result: {
  archive: string;
  sha256: string;
  entryPath: string;
}): Promise<void> {
  await showDialog({
    title: 'Workshop published',
    body: new ValueBody<null>(null, () => (
      <dl className="jp-WorkshopAuthor-facts">
        <dt>Archive</dt>
        <dd>
          <code>{result.archive}</code>
        </dd>
        <dt>SHA-256</dt>
        <dd>
          <code>{result.sha256}</code>
        </dd>
        <dt>Registry entry</dt>
        <dd>
          <code>{result.entryPath}</code>
        </dd>
        <dd className="jp-WorkshopAuthor-fieldHint">
          Host the archive, put its URL in the entry and merge the entry into a
          registry index with jupyter workshop registry.
        </dd>
      </dl>
    )),
    buttons: [Dialog.okButton()]
  });
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
