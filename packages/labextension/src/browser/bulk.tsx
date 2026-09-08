import {
  ICollectionEntry,
  IInstallPlanItem,
  planInstallAll
} from '@jupyterlab-workshop/core';
import { Dialog, Notification } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { ReactWidget } from '@jupyterlab/ui-components';
import React, { useState } from 'react';

import { IInstalledWorkshop, IWorkshopManager, errorMessage } from '../tokens';
import { fetchRequestFor, isInstalledFrom } from './install';

/**
 * How long the frontend waits for one download before giving up on it.
 * The server caps a download itself, so this only catches a server that
 * has gone away; it is longer than the server's cap so the two never
 * disagree about a download that is merely slow.
 */
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How many failures of the same kind in a row, from the start, mean the
 * problem is not one workshop but the network or the forge, so the run
 * stops rather than trying the rest.
 */
const SYSTEMIC_FAILURES = 3;

/** Why an install failed, as far as the message lets us tell. */
export type FailureKind = 'hash' | 'network' | 'exists' | 'other';

/** What happened to one workshop of a bulk run. */
export interface IBulkOutcome {
  entry: ICollectionEntry;

  /** Installed, failed, or not attempted because the run stopped early. */
  status: 'installed' | 'failed' | 'skipped';
  kind?: FailureKind;
  message?: string;
}

/** What a bulk install run produced. */
export interface IBulkResult {
  outcomes: IBulkOutcome[];

  /** Whether the learner cancelled the run. */
  cancelled: boolean;

  /** Whether the run stopped after repeated failures of one kind. */
  stopped: boolean;
}

/** What Install all needs to know. */
export interface IInstallAllOptions {
  manager: IWorkshopManager;
  collection: string;
  title: string;
  entries: readonly ICollectionEntry[];
  installed: readonly IInstalledWorkshop[];
  directory: string;
  platform: string;
}

/**
 * Install every workshop of a collection the learner picks: the
 * checklist dialog first, then the downloads one at a time with a
 * progress notification that can cancel, then a summary that can retry
 * what did not land. Resolves once the learner closes the summary, or
 * at once when the dialog is cancelled.
 */
export async function installAll(options: IInstallAllOptions): Promise<void> {
  const { collection, entries, installed, platform } = options;
  const plan = planInstallAll(entries, platform, entry =>
    installed.some(item => isInstalledFrom(item, collection, entry.name))
  );
  let chosen = await showInstallAllDialog(options.title, plan);

  while (chosen && chosen.length > 0) {
    const result = await runInstallAll(chosen, options);
    const remaining = result.outcomes
      .filter(item => item.status !== 'installed')
      .map(item => item.entry);

    // The summary offers to retry what failed or was not attempted; a
    // later attempt sees the installed list as it now is.
    const retry = await showSummaryDialog(options.title, result);

    if (!retry || remaining.length === 0) {
      return;
    }

    chosen = remaining;
  }
}

/**
 * Download the chosen workshops one after another, in the order given,
 * keeping what lands when one fails, stopping after the learner cancels
 * or after the first few fail the same way.
 */
export async function runInstallAll(
  chosen: readonly ICollectionEntry[],
  options: IInstallAllOptions
): Promise<IBulkResult> {
  const { manager, collection, directory } = options;
  const outcomes: IBulkOutcome[] = [];
  let cancelled = false;
  let stopped = false;
  let installed = [...options.installed];

  const notification = Notification.emit(
    progressMessage(options.title, 0, chosen.length, chosen[0]),
    'in-progress',
    {
      autoClose: false,
      actions: [
        {
          label: 'Cancel',
          caption: 'Stop after the workshop being downloaded now',
          callback: (event: MouseEvent): void => {
            event.preventDefault();
            cancelled = true;
          }
        }
      ]
    }
  );

  for (const [index, entry] of chosen.entries()) {
    if (cancelled || stopped) {
      outcomes.push({ entry, status: 'skipped' });

      continue;
    }

    Notification.update({
      id: notification,
      message: progressMessage(options.title, index, chosen.length, entry),
      progress: index / chosen.length
    });

    // The request names the directory the same way a single install
    // would, so a clash with another collection gets the same suffix.
    const request = fetchRequestFor(entry, collection, directory, installed);

    try {
      const result = await withTimeout(manager.fetch(request), STEP_TIMEOUT_MS);

      outcomes.push({ entry, status: 'installed' });
      installed = [
        ...installed,
        installedRecord(entry, result.path, result.sha256, collection)
      ];
    } catch (error) {
      const kind = classifyFailure(error);

      outcomes.push({
        entry,
        status: 'failed',
        kind,
        message: errorMessage(error)
      });

      // The same failure from the start, a few times over, is the
      // network or the forge rather than the workshop.
      if (isSystemic(outcomes)) {
        stopped = true;
      }
    }
  }

  const done = outcomes.filter(item => item.status === 'installed').length;
  const failed = outcomes.filter(item => item.status === 'failed').length;

  Notification.update({
    id: notification,
    message:
      failed === 0 && !cancelled
        ? `Installed ${count(done, 'workshop')} from ${options.title}`
        : `Installed ${count(done, 'workshop')} from ${options.title}, ${failed} failed`,
    type: failed === 0 && !cancelled ? 'success' : 'warning',
    progress: 1,
    autoClose: 6000,
    actions: []
  });

  return { outcomes, cancelled, stopped };
}

/** What Remove all needs to know. */
export interface IRemoveAllOptions {
  manager: IWorkshopManager;
  collection: string;
  title: string;
  installed: readonly IInstalledWorkshop[];
}

/**
 * Remove every installed workshop of a collection after a confirmation
 * listing the directories that will go. Progress recorded in them is
 * lost, so the dialog says so. Resolves to what failed, if anything.
 */
export async function removeAll(
  options: IRemoveAllOptions
): Promise<IBulkOutcome[]> {
  const { manager, collection, installed } = options;
  const targets = installed.filter(
    item =>
      item.collection !== null && isInstalledFrom(item, collection, item.name)
  );

  if (targets.length === 0) {
    return [];
  }

  const body = ReactWidget.create(
    <div className="jp-WorkshopBulk">
      <p className="jp-WorkshopBulk-text">
        {count(targets.length, 'directory', 'directories')} and any progress
        recorded in them will be deleted.
      </p>
      <ul className="jp-WorkshopBulk-list">
        {targets.map(item => (
          <li key={item.path}>
            <span className="jp-WorkshopBulk-title">{item.title}</span>
            <span className="jp-WorkshopBulk-detail">{item.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  const dialog = new Dialog({
    title: `Remove every workshop of "${options.title}"?`,
    body,
    buttons: [
      Dialog.cancelButton(),
      Dialog.warnButton({ label: 'Remove all' })
    ],
    defaultButton: 0
  });
  const result = await dialog.launch();

  if (!result.button.accept) {
    return [];
  }

  const failures: IBulkOutcome[] = [];

  for (const item of targets) {
    try {
      await manager.removeInstalled(item.path);
    } catch (error) {
      failures.push({
        entry: entryFor(item),
        status: 'failed',
        kind: 'other',
        message: errorMessage(error)
      });
    }
  }

  if (failures.length > 0) {
    await showFailuresDialog(
      `Some workshops of "${options.title}" were not removed`,
      failures
    );
  }

  return failures;
}

/**
 * The checklist dialog: every entry of the collection with a checkbox,
 * the installed ones greyed out, and the count that will be installed.
 * Resolves to the chosen entries in collection order, or null when
 * cancelled, which is also the default button.
 */
async function showInstallAllDialog(
  title: string,
  plan: readonly IInstallPlanItem[]
): Promise<ICollectionEntry[] | null> {
  const selected = new Set(
    plan.filter(item => item.selected).map(item => item.entry.name)
  );
  const body = ReactWidget.create(
    <InstallAllBody
      plan={plan}
      initial={selected}
      onChange={names => {
        selected.clear();

        for (const name of names) {
          selected.add(name);
        }
      }}
    />
  );
  const dialog = new Dialog({
    title: `Install every workshop of "${title}"?`,
    body,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Install' })],
    defaultButton: 0
  });

  dialog.addClass('jp-WorkshopBulkDialog');

  const result = await dialog.launch();

  if (!result.button.accept) {
    return null;
  }

  return plan
    .filter(item => selected.has(item.entry.name))
    .map(item => item.entry);
}

function InstallAllBody({
  plan,
  initial,
  onChange
}: {
  plan: readonly IInstallPlanItem[];
  initial: ReadonlySet<string>;
  onChange: (names: ReadonlySet<string>) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(initial);
  const toggle = (name: string): void => {
    const next = new Set(selected);

    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }

    setSelected(next);
    onChange(next);
  };

  const chosen = plan.filter(item => selected.has(item.entry.name)).length;
  const already = plan.filter(item => item.installed).length;
  const unsupported = plan.filter(
    item => !item.installed && !item.supported
  ).length;

  return (
    <div className="jp-WorkshopBulk">
      <p className="jp-WorkshopBulk-text">
        Each workshop is downloaded in turn into the workshops directory.
        Nothing runs until you open one, when it asks for trust as usual.
      </p>
      <ul className="jp-WorkshopBulk-list">
        {plan.map(item => (
          <li
            key={item.entry.name}
            className={item.installed ? 'jp-mod-installed' : ''}
          >
            <label>
              <input
                type="checkbox"
                checked={selected.has(item.entry.name)}
                disabled={item.installed}
                onChange={() => toggle(item.entry.name)}
              />
              <span className="jp-WorkshopBulk-title">{item.entry.title}</span>
              <span className="jp-WorkshopBulk-detail">
                {item.installed
                  ? 'installed'
                  : item.supported
                    ? (item.entry.versions[0]?.version ?? '')
                    : 'not written for this platform'}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="jp-WorkshopBulk-text jp-WorkshopBulk-count">
        {count(chosen, 'workshop')} to install
        {already > 0 ? `, ${already} installed already` : ''}
        {unsupported > 0 ? `, ${unsupported} not for this platform` : ''}.
      </p>
    </div>
  );
}

/**
 * The summary after a run: what landed, what failed and why, and what
 * was not attempted. Resolves to whether the learner asked to retry the
 * rest.
 */
async function showSummaryDialog(
  title: string,
  result: IBulkResult
): Promise<boolean> {
  const installed = result.outcomes.filter(item => item.status === 'installed');
  const failed = result.outcomes.filter(item => item.status === 'failed');
  const skipped = result.outcomes.filter(item => item.status === 'skipped');
  const hashFailures = failed.filter(item => item.kind === 'hash');

  // A clean run needs no more than the notification.
  if (failed.length === 0 && skipped.length === 0) {
    return false;
  }

  const body = ReactWidget.create(
    <div className="jp-WorkshopBulk">
      {result.cancelled ? (
        <p className="jp-WorkshopBulk-text">The run was cancelled.</p>
      ) : null}
      {result.stopped ? (
        <p className="jp-WorkshopBulk-text">
          The run stopped after repeated failures of the same kind, which points
          to the network or the source rather than one workshop.
        </p>
      ) : null}
      {hashFailures.length > 0 ? (
        <p className="jp-WorkshopBulk-text jp-WorkshopBulk-warning">
          {count(hashFailures.length, 'download')} did not match the hash the
          collection gives. The collection may be out of date or the files may
          have been altered; check with its publisher before retrying.
        </p>
      ) : null}
      <OutcomeList heading="Installed" items={installed} />
      <OutcomeList heading="Failed" items={failed} />
      <OutcomeList heading="Not attempted" items={skipped} />
    </div>
  );
  const retryable = failed.length + skipped.length > 0;
  const dialog = new Dialog({
    title: `Install all from "${title}"`,
    body,
    buttons: retryable
      ? [
          Dialog.cancelButton({ label: 'Close' }),
          Dialog.okButton({ label: 'Retry remaining' })
        ]
      : [Dialog.okButton({ label: 'Close' })],
    defaultButton: 0
  });

  dialog.addClass('jp-WorkshopBulkDialog');

  const answer = await dialog.launch();

  return retryable && answer.button.accept;
}

async function showFailuresDialog(
  title: string,
  failures: readonly IBulkOutcome[]
): Promise<void> {
  const body = ReactWidget.create(
    <div className="jp-WorkshopBulk">
      <OutcomeList heading="Failed" items={failures} />
    </div>
  );
  const dialog = new Dialog({
    title,
    body,
    buttons: [Dialog.okButton({ label: 'Close' })]
  });

  await dialog.launch();
}

function OutcomeList({
  heading,
  items
}: {
  heading: string;
  items: readonly IBulkOutcome[];
}): JSX.Element | null {
  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <h4 className="jp-WorkshopBulk-heading">
        {heading} ({items.length})
      </h4>
      <ul className="jp-WorkshopBulk-list">
        {items.map(item => (
          <li key={item.entry.name}>
            <span className="jp-WorkshopBulk-title">{item.entry.title}</span>
            {item.message ? (
              <span className="jp-WorkshopBulk-detail">
                {describeFailure(item)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function progressMessage(
  title: string,
  index: number,
  total: number,
  entry: ICollectionEntry
): string {
  return `Installing ${index + 1} of ${total} from ${title}: ${entry.title}`;
}

function count(value: number, singular: string, plural?: string): string {
  return `${value} ${value === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/**
 * Sort a failure by what its message says, since the server reports
 * every fetch problem as one error type: a hash mismatch is a warning
 * about the collection, a download problem is the network or the forge,
 * and an existing directory is a leftover the learner can deal with.
 */
export function classifyFailure(error: unknown): FailureKind {
  const message = errorMessage(error).toLowerCase();

  if (error instanceof ServerConnection.NetworkError) {
    return 'network';
  }

  if (message.includes('sha256') && message.includes('does not match')) {
    return 'hash';
  }

  if (message.includes('already exists')) {
    return 'exists';
  }

  if (
    message.includes('unable to download') ||
    message.includes('timed out') ||
    message.includes('larger than the limit')
  ) {
    return 'network';
  }

  return 'other';
}

function describeFailure(item: IBulkOutcome): string {
  switch (item.kind) {
    case 'hash':
      return 'hash did not match the collection';
    case 'exists':
      return 'a directory of that name exists already';
    case 'network':
      return `download failed: ${item.message ?? ''}`;
    default:
      return item.message ?? '';
  }
}

/**
 * Whether every outcome so far is a failure of one kind, and there are
 * enough of them to call it systemic.
 */
export function isSystemic(outcomes: readonly IBulkOutcome[]): boolean {
  if (outcomes.length < SYSTEMIC_FAILURES) {
    return false;
  }

  const first = outcomes[0];

  return outcomes.every(
    item => item.status === 'failed' && item.kind === first.kind
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () =>
        reject(new Error(`The download timed out after ${ms / 60000} minutes`)),
      ms
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}

/**
 * The installed record a fresh download would produce, enough for the
 * clash rule to see it while the run goes on.
 */
function installedRecord(
  entry: ICollectionEntry,
  path: string,
  sha256: string,
  collection: string
): IInstalledWorkshop {
  return {
    path,
    name: entry.name,
    title: entry.title,
    version: entry.versions[0]?.version ?? '',
    description: entry.description,
    tags: entry.tags,
    platforms: entry.platforms,
    source: null,
    sha256,
    collection,
    pages: 0,
    done: 0,
    currentPage: '',
    trust: '',
    started: false
  };
}

function entryFor(item: IInstalledWorkshop): ICollectionEntry {
  return {
    name: item.name,
    title: item.title,
    description: item.description,
    tags: item.tags,
    platforms: item.platforms,
    capabilities: [],
    authors: [],
    versions: []
  };
}
