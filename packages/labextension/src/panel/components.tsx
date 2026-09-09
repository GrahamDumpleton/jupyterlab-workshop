import {
  ACTION_TYPES,
  ActionDisposition,
  IDirectiveNode,
  IFormField,
  ILintMessage,
  IPage,
  IProseNode,
  PageNode,
  TRUST_LEVEL_DESCRIPTIONS,
  describeRequirement,
  isActionType,
  parseForm,
  parseQuiz,
  parseTriggers,
  validateForm
} from '@jupyterlab-workshop/core';
import {
  UseSignal,
  caretLeftIcon,
  caretRightIcon,
  checkIcon,
  closeIcon,
  downloadIcon,
  editIcon,
  folderIcon,
  launcherIcon,
  listIcon,
  refreshIcon,
  runIcon,
  settingsIcon,
  stopIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState
} from 'react';

import { infoIcon } from '../icons';
import {
  CommandIDs,
  IActionRequest,
  IActionStatus,
  IFeaturePolicy,
  IWorkshopManager
} from '../tokens';
import { visibleDirectives } from '../util';

/** Props shared by the panel components. */
export interface IPanelProps {
  manager: IWorkshopManager;
  commands: CommandRegistry;

  /** Which buttons the settings leave enabled. */
  features: IFeaturePolicy;
}

const PULSE_CLASS = 'jp-mod-pulse';

/**
 * Root component of the workshop panel. Re-renders whenever the manager
 * signals a change.
 */
export function WorkshopPanelComponent(props: IPanelProps): JSX.Element {
  return (
    <UseSignal signal={props.manager.changed}>
      {() => <PanelContent {...props} />}
    </UseSignal>
  );
}

function IconButton({
  icon,
  title,
  disabled,
  onClick
}: {
  icon: typeof runIcon;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="jp-WorkshopPanel-iconButton"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <icon.react tag="span" width="16px" height="16px" />
    </button>
  );
}

function PanelContent({
  manager,
  commands,
  features
}: IPanelProps): JSX.Element {
  const workshop = manager.workshop;
  const page = manager.currentPage;

  if (!workshop || !page) {
    return (
      <EmptyState
        error={manager.error}
        onOpen={
          features.enabled('open-directory')
            ? () => void commands.execute(CommandIDs.open)
            : undefined
        }
        onOpenUrl={
          features.enabled('open-url')
            ? () => void commands.execute(CommandIDs.openUrl)
            : undefined
        }
        onBrowse={
          features.enabled('browse')
            ? () => void commands.execute(CommandIDs.browse)
            : undefined
        }
      />
    );
  }

  const visible = manager.visiblePages;
  const count = visible.length;
  const index = manager.pageIndex;
  const doneCount = visible.filter(
    item => manager.pageProgress(item.id).done
  ).length;
  const last = index >= count - 1;
  const gate = manager.gate(page.id);
  const run = (command: string): void => void commands.execute(command);
  const jumpTo = (id: string): void => manager.focusAction(id);

  return (
    <div className="jp-WorkshopPanel-content">
      <div className="jp-WorkshopPanel-header">
        <div className="jp-WorkshopPanel-titleRow">
          <h2
            className="jp-WorkshopPanel-title"
            title={workshop.manifest.description}
          >
            {workshop.manifest.title}
          </h2>
          <div className="jp-WorkshopPanel-headerTools">
            <TrustBadge
              manager={manager}
              onClick={() => run(CommandIDs.trust)}
            />
            <IconButton
              icon={infoIcon}
              title="About this workshop"
              onClick={() => run(CommandIDs.about)}
            />
            {manager.chainRunning ? (
              <IconButton
                icon={stopIcon}
                title="Stop running actions"
                onClick={() => run(CommandIDs.stopChain)}
              />
            ) : null}
            <IconButton
              icon={settingsIcon}
              title="Variables"
              onClick={() => run(CommandIDs.variables)}
            />
            <IconButton
              icon={listIcon}
              title="Action log"
              onClick={() => run(CommandIDs.showLog)}
            />
            <IconButton
              icon={refreshIcon}
              title="Restart this workshop"
              onClick={() => run(CommandIDs.restart)}
            />
            {features.enabled('author') ? (
              <IconButton
                icon={editIcon}
                title={
                  manager.authoring ? 'Leave author mode' : 'Edit this workshop'
                }
                onClick={() => run(CommandIDs.authorMode)}
              />
            ) : null}
            {features.enabled('browse') ? (
              <IconButton
                icon={launcherIcon}
                title="Browse workshops"
                onClick={() => run(CommandIDs.browse)}
              />
            ) : null}
            {features.enabled('open-directory') ? (
              <IconButton
                icon={folderIcon}
                title="Open another workshop"
                onClick={() => run(CommandIDs.open)}
              />
            ) : null}
            {features.enabled('open-url') ? (
              <IconButton
                icon={downloadIcon}
                title="Open a workshop from a URL"
                onClick={() => run(CommandIDs.openUrl)}
              />
            ) : null}
            {features.enabled('close') ? (
              <IconButton
                icon={closeIcon}
                title="Close this workshop"
                onClick={() => run(CommandIDs.close)}
              />
            ) : null}
          </div>
        </div>
        <div
          className="jp-WorkshopPanel-progress"
          title={`${doneCount} of ${count} pages done`}
        >
          <div
            className="jp-WorkshopPanel-progressBar"
            style={{ width: `${count > 0 ? (doneCount / count) * 100 : 0}%` }}
          />
        </div>
        {manager.authoring ? (
          <AuthorToolbar manager={manager} commands={commands} />
        ) : null}
        <div className="jp-WorkshopPanel-nav">
          <IconButton
            icon={caretLeftIcon}
            title="Previous page"
            disabled={index === 0}
            onClick={() => manager.previous()}
          />
          <select
            className="jp-WorkshopPanel-pageSelect"
            value={index}
            onChange={event => manager.goTo(Number(event.target.value))}
          >
            {visible.map((item, position) => (
              <option key={item.path} value={position}>
                {position + 1}. {item.title}
                {item.frontmatter.optional ? ' (optional)' : ''}
                {manager.pageProgress(item.id).done ? ' ✓' : ''}
              </option>
            ))}
          </select>
          <IconButton
            icon={caretRightIcon}
            title="Next page"
            disabled={index >= count - 1}
            onClick={() => manager.next()}
          />
        </div>
      </div>
      <PageBody
        key={`${workshop.path}:${page.id}`}
        page={page}
        manager={manager}
        commands={commands}
      />
      {gate.unmet.length > 0 ? (
        <div
          className={`jp-WorkshopPanel-gate${gate.blocked ? ' jp-mod-blocked' : ''}`}
        >
          <span>{gate.blocked ? 'Before moving on: ' : 'Not yet done: '}</span>
          {gate.unmet.map((item, position) => (
            <React.Fragment key={item.id}>
              {position > 0 ? ', ' : null}
              <a
                href="#"
                onClick={event => {
                  event.preventDefault();
                  jumpTo(item.id);
                }}
              >
                {describeRequirement(item)}
              </a>
            </React.Fragment>
          ))}
        </div>
      ) : null}
      <div className="jp-WorkshopPanel-footer">
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          disabled={index === 0}
          onClick={() => manager.previous()}
        >
          Previous
        </button>
        {last && manager.finished ? (
          <span className="jp-WorkshopPanel-finished">
            <checkIcon.react tag="span" width="14px" height="14px" />
            Finished
            <a
              href="#"
              onClick={event => {
                event.preventDefault();
                run(CommandIDs.finish);
              }}
            >
              What next?
            </a>
          </span>
        ) : (
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-accept"
            disabled={gate.blocked}
            title={gate.blocked ? 'Complete the requirements above first' : ''}
            onClick={() => (last ? run(CommandIDs.finish) : manager.next())}
          >
            {last ? 'Finish' : 'Next'}
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  error,
  onOpen,
  onOpenUrl,
  onBrowse
}: {
  error: string | null;

  /** Handlers for the ways of opening a workshop the settings allow. */
  onOpen?: () => void;
  onOpenUrl?: () => void;
  onBrowse?: () => void;
}): JSX.Element {
  return (
    <div className="jp-WorkshopPanel-empty">
      <p>No workshop is open.</p>
      {error ? <p className="jp-WorkshopPanel-error">{error}</p> : null}
      <div className="jp-WorkshopPanel-emptyActions">
        {onBrowse ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-accept"
            onClick={onBrowse}
          >
            Browse workshops
          </button>
        ) : null}
        {onOpen ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            onClick={onOpen}
          >
            Open a directory
          </button>
        ) : null}
        {onOpenUrl ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            onClick={onOpenUrl}
          >
            Open from URL
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TrustBadge({
  manager,
  onClick
}: {
  manager: IWorkshopManager;
  onClick: () => void;
}): JSX.Element | null {
  const level = manager.trust;

  if (!level) {
    return null;
  }

  const label =
    level === 'trusted'
      ? 'trusted'
      : level === 'restricted'
        ? 'restricted'
        : 'ask';

  return (
    <button
      type="button"
      className={`jp-WorkshopPanel-trust jp-mod-${level}`}
      title={`Trust level: ${TRUST_LEVEL_DESCRIPTIONS[level]} Click to change.`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function PageBody({
  page,
  manager,
  commands
}: {
  page: IPage;
  manager: IWorkshopManager;
  commands: CommandRegistry;
}): JSX.Element {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const container = useRef<HTMLDivElement>(null);

  // Re-render on action status changes, and scroll to automatic runs.
  useEffect(() => {
    const onChanged = (): void => refresh();
    const onFocused = (_: IWorkshopManager, id: string): void => {
      const element = container.current?.querySelector<HTMLElement>(
        `[data-action-id="${CSS.escape(id)}"]`
      );

      if (element) {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        element.classList.add(PULSE_CLASS);
        window.setTimeout(() => element.classList.remove(PULSE_CLASS), 1500);
      }
    };

    manager.actionChanged.connect(onChanged);
    manager.actionFocused.connect(onFocused);

    return () => {
      manager.actionChanged.disconnect(onChanged);
      manager.actionFocused.disconnect(onFocused);
    };
  }, [manager]);

  const onProseClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        'button[data-role]'
      );

      if (!target) {
        return;
      }

      const request = roleRequest(
        target.dataset.role ?? '',
        target.dataset.value ?? ''
      );

      if (request) {
        void manager.runRequest(request, 'role');
      }
    },
    [manager]
  );

  return (
    <div className="jp-WorkshopPanel-body" ref={container}>
      <h3 className="jp-WorkshopPanel-pageTitle">{page.title}</h3>
      {manager.pageIndex === 0 ? <PlatformBanner manager={manager} /> : null}
      {manager.pageIndex === 0 ? <PreflightBanner manager={manager} /> : null}
      {manager.pageIndex === 0 ? <ShellBanner manager={manager} /> : null}
      <EnvironmentBanner manager={manager} />
      {manager.authoring ? <PageLint page={page} manager={manager} /> : null}
      {page.warnings.length > 0 ? (
        <div className="jp-WorkshopPanel-warnings">
          {page.warnings.map((warning, position) => (
            <div key={position}>{warning}</div>
          ))}
        </div>
      ) : null}
      <Nodes
        nodes={page.nodes}
        manager={manager}
        commands={commands}
        onProseClick={onProseClick}
      />
    </div>
  );
}

function Nodes({
  nodes,
  manager,
  commands,
  onProseClick
}: {
  nodes: PageNode[];
  manager: IWorkshopManager;
  commands: CommandRegistry;
  onProseClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return (
    <>
      {nodes.map((node, position) => {
        if (node.kind === 'prose') {
          return (
            <ProseBlock key={position} node={node} onClick={onProseClick} />
          );
        }

        if (node.kind === 'when') {
          return manager.evaluate(node.condition) ? (
            <Nodes
              key={position}
              nodes={node.nodes}
              manager={manager}
              commands={commands}
              onProseClick={onProseClick}
            />
          ) : null;
        }

        if (node.options.when && !manager.evaluate(node.options.when)) {
          return null;
        }

        if (manager.authoring) {
          return (
            <AuthorGutter
              key={node.id}
              node={node}
              manager={manager}
              commands={commands}
            >
              <DirectiveBlock node={node} manager={manager} />
            </AuthorGutter>
          );
        }

        return <DirectiveBlock key={node.id} node={node} manager={manager} />;
      })}
    </>
  );
}

/** The author toolbar's buttons: label, command and tooltip. */
const AUTHOR_BUTTONS: readonly [string, string, string][] = [
  ['Edit page', CommandIDs.editPage, 'Open the page source in the editor'],
  ['New page', CommandIDs.newPage, 'Add a page after the last one'],
  ['Pages', CommandIDs.managePages, 'Reorder, rename, add and remove pages'],
  ['Manifest', CommandIDs.editManifest, 'Open workshop.yaml in the editor'],
  ['Insert', CommandIDs.insertAction, 'Insert an action into the page'],
  ['Capture', CommandIDs.capture, 'Add what was just done in the session'],
  ['Run actions', CommandIDs.runPageActions, 'Run the actions of this page'],
  ['Run checks', CommandIDs.runPageChecks, 'Run the checks of this page'],
  ['Trust', CommandIDs.trustPreview, 'Preview the trust dialog'],
  ['Publish', CommandIDs.publish, 'Build the archive and registry entry']
];

function AuthorToolbar({
  manager,
  commands
}: {
  manager: IWorkshopManager;
  commands: CommandRegistry;
}): JSX.Element {
  const errors = manager.lint.filter(item => item.level === 'error').length;
  const warnings = manager.lint.length - errors;
  const recording = commands.isToggled(CommandIDs.record);
  const run = (command: string, args = {}): void =>
    void commands.execute(command, args);

  return (
    <div className="jp-WorkshopPanel-author">
      <div className="jp-WorkshopPanel-authorRow">
        {AUTHOR_BUTTONS.map(([label, command, title]) => (
          <button
            key={command}
            type="button"
            className="jp-WorkshopPanel-authorButton"
            title={title}
            onClick={() => run(command)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={`jp-WorkshopPanel-authorButton${errors > 0 ? ' jp-mod-error' : warnings > 0 ? ' jp-mod-warning' : ''}`}
          title="Show the lint findings"
          onClick={() => run(CommandIDs.showLint)}
        >
          Lint
          {manager.lint.length > 0 ? ` (${manager.lint.length})` : ''}
        </button>
        <button
          type="button"
          className={`jp-WorkshopPanel-authorButton jp-WorkshopPanel-record${recording ? ' jp-mod-recording' : ''}`}
          title={
            recording
              ? 'Stop recording and write draft pages'
              : 'Record the session into draft pages'
          }
          onClick={() => run(CommandIDs.record)}
        >
          {recording ? '■ Stop' : '● Record'}
        </button>
        {recording ? (
          <button
            type="button"
            className="jp-WorkshopPanel-authorButton"
            title="Start a new page in the recording"
            onClick={() => run(CommandIDs.recordPageBreak)}
          >
            + Page
          </button>
        ) : null}
      </div>
      {manager.error ? (
        <div className="jp-WorkshopPanel-authorError">{manager.error}</div>
      ) : null}
    </div>
  );
}

function PageLint({
  page,
  manager
}: {
  page: IPage;
  manager: IWorkshopManager;
}): JSX.Element | null {
  // Findings without a line belong to the page as a whole; the rest are
  // shown under the directive they refer to.
  const messages = manager.lint.filter(
    item => item.path === page.path && !item.line
  );

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="jp-WorkshopPanel-lintList">
      {messages.map((message, index) => (
        <LintMarker key={index} message={message} />
      ))}
    </div>
  );
}

function LintMarker({ message }: { message: ILintMessage }): JSX.Element {
  return (
    <div className={`jp-WorkshopPanel-lint jp-mod-${message.level}`}>
      <code>{message.rule}</code> {message.message}
    </div>
  );
}

function AuthorGutter({
  node,
  manager,
  commands,
  children
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
  commands: CommandRegistry;
  children: React.ReactNode;
}): JSX.Element {
  const page = manager.currentPage;
  const messages = manager.lint.filter(
    item => item.path === page?.path && item.line === node.line
  );
  const edit = (command: string): void => {
    if (page) {
      void commands.execute(command, { page: page.path, line: node.line });
    }
  };

  return (
    <div className="jp-WorkshopPanel-gutterBlock">
      {children}
      <div className="jp-WorkshopPanel-gutter">
        <span className="jp-WorkshopPanel-gutterInfo">
          {node.name} · line {node.line}
        </span>
        <button
          type="button"
          className="jp-WorkshopPanel-gutterButton"
          title="Edit this action"
          onClick={() => edit(CommandIDs.editAction)}
        >
          edit
        </button>
        <button
          type="button"
          className="jp-WorkshopPanel-gutterButton"
          title="Delete this action"
          onClick={() => edit(CommandIDs.deleteAction)}
        >
          delete
        </button>
      </div>
      {messages.map((message, index) => (
        <LintMarker key={index} message={message} />
      ))}
    </div>
  );
}

function ProseBlock({
  node,
  onClick
}: {
  node: IProseNode;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  // Pages are rendered with raw HTML disabled, so this is generated markup.
  return (
    <div
      className="jp-WorkshopPanel-prose jp-RenderedHTMLCommon"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: node.html }}
    />
  );
}

function DirectiveBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  switch (node.name) {
    case 'hint':
      return <HintBlock node={node} manager={manager} />;
    case 'choice':
      return <ChoiceBlock node={node} manager={manager} />;
    case 'verify':
      return <VerifyBlock node={node} manager={manager} />;
    case 'quiz':
      return <QuizBlock node={node} manager={manager} />;
    case 'form':
      return <FormBlock node={node} manager={manager} />;
    default:
      return isActionType(node.name) ? (
        <ActionBlock node={node} manager={manager} />
      ) : (
        <UnknownBlock node={node} />
      );
  }
}

function HintBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  return (
    <details
      className="jp-WorkshopPanel-hint"
      open={node.options.open === 'true'}
      onToggle={event => {
        if ((event.target as HTMLDetailsElement).open) {
          manager.track('hint-opened', { id: node.id });
        }
      }}
    >
      <summary>{node.options.title ?? 'Hint'}</summary>
      <div
        className="jp-WorkshopPanel-prose jp-RenderedHTMLCommon"
        dangerouslySetInnerHTML={{ __html: node.html ?? '' }}
      />
    </details>
  );
}

function ChoiceBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const manifest = manager.workshop?.manifest;
  const isTrack = node.options.track === 'true';
  const variable = node.options.variable ?? (isTrack ? 'track' : '');

  // Options come from the directive, the variable definition, or the tracks.
  let options: { value: string; label: string }[] = [];

  if (node.options.options) {
    options = node.options.options
      .split(',')
      .map(item => item.trim())
      .filter(item => item !== '')
      .map(value => ({ value, label: value }));
  } else if (isTrack && manifest && manifest.tracks.length > 0) {
    options = manifest.tracks.map(track => ({
      value: track.id,
      label: track.label
    }));
  } else if (manifest) {
    const definition = manifest.variables.find(item => item.name === variable);

    options = (definition?.options ?? []).map(value => ({
      value,
      label: value
    }));
  }

  const current = manager.variables.get(variable);
  const status = manager.actionStatus(node.id);

  return (
    <div
      className="jp-WorkshopPanel-action jp-WorkshopPanel-choice"
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          {node.options.label ??
            node.options.title ??
            (isTrack ? 'Choose a track' : `Choose ${variable}`)}
        </span>
      </div>
      {node.body.trim() ? (
        <div className="jp-WorkshopPanel-choiceText">{node.body}</div>
      ) : null}
      <div className="jp-WorkshopPanel-choiceOptions">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            className={`jp-Button jp-mod-styled${current === option.value ? ' jp-mod-accept' : ''}`}
            onClick={() => void manager.runAction(node, 'click', option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {status.status === 'error' && status.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{status.message}</div>
      ) : null}
    </div>
  );
}

function ActionBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const status = effectiveStatus(node, manager);
  const request: IActionRequest = {
    type: node.name,
    id: node.id,
    argument: node.argument,
    options: node.options,
    body: node.body
  };
  const title =
    node.options.title ?? manager.registry?.describe(request) ?? node.name;
  const display = displayText(node);
  const disposition = manager.disposition(node);
  const trustBadge = dispositionBadge(disposition, node);
  const onRun = (): void => void manager.runAction(node, 'click');
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRun();
    }
  };

  return (
    <div
      className={`jp-WorkshopPanel-action jp-mod-${node.name} jp-mod-status-${status.status}`}
      data-action-id={node.id}
      role="button"
      tabIndex={0}
      title="Click to run"
      onClick={onRun}
      onKeyDown={onKeyDown}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <runIcon.react tag="span" width="14px" height="14px" />
        <span className="jp-WorkshopPanel-actionLabel">{title}</span>
        {node.options.auto ? (
          <span className="jp-WorkshopPanel-badge">auto</span>
        ) : null}
        {node.options.cascade && node.options.cascade !== 'false' ? (
          <span className="jp-WorkshopPanel-badge">cascade</span>
        ) : null}
        {node.variant && node.variant !== 'default' ? (
          <span
            className="jp-WorkshopPanel-badge jp-mod-platform"
            title={`This is the ${node.variant} version of the action`}
          >
            {node.variant}
          </span>
        ) : null}
        {trustBadge ? (
          <span
            className={`jp-WorkshopPanel-badge ${trustBadge.className}`}
            title={trustBadge.title}
          >
            {trustBadge.label}
          </span>
        ) : null}
        <span className="jp-WorkshopPanel-actionStatus">
          {statusText(status)}
        </span>
      </div>
      {display ? (
        <pre className="jp-WorkshopPanel-actionBody">{display}</pre>
      ) : null}
      {status.status === 'error' && status.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{status.message}</div>
      ) : null}
      {status.status === 'ok' && status.message && showsOutput(node) ? (
        <pre className="jp-WorkshopPanel-actionOutput">{status.message}</pre>
      ) : null}
    </div>
  );
}

function PreflightBanner({
  manager
}: {
  manager: IWorkshopManager;
}): JSX.Element | null {
  const results = manager.preflight;

  if (!results) {
    return null;
  }

  const problems = results.filter(result => !result.satisfied);

  if (problems.length === 0) {
    return null;
  }

  return (
    <div className="jp-WorkshopPanel-preflight">
      <div className="jp-WorkshopPanel-preflightTitle">
        This workshop needs tools that were not found:
      </div>
      <ul>
        {problems.map(result => (
          <li key={result.name}>
            <code>{result.name}</code>
            {result.requirement ? ` ${result.requirement}` : ''}
            {result.found
              ? result.version
                ? ` (found ${result.version})`
                : ' (version unknown)'
              : ' (not installed)'}
            {result.optional ? ', optional' : ''}
            {result.hint ? (
              <span className="jp-WorkshopPanel-preflightHint">
                {' '}
                Try: <code>{result.hint}</code>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The status an action block shows. An `environment-create` step that
 * has not been clicked reads as done once the environment exists, since
 * the banner or an earlier session may have created it.
 */
function effectiveStatus(
  node: IDirectiveNode,
  manager: IWorkshopManager
): IActionStatus {
  const status = manager.actionStatus(node.id);
  const environment = manager.environment;

  if (
    node.name === 'environment-create' &&
    status.status === 'idle' &&
    environment?.ready &&
    environment.registered &&
    !environment.stale
  ) {
    return {
      status: 'ok',
      message: `Environment ready with kernel "${environment.kernel}"`,
      runs: 0
    };
  }

  return status;
}

/** How the platforms are named to learners. */
export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
  lite: 'JupyterLite'
};

function PlatformBanner({
  manager
}: {
  manager: IWorkshopManager;
}): JSX.Element | null {
  const platforms = manager.workshop?.manifest.platforms ?? [];
  const os = manager.platform?.os;

  // The list is advisory: the workshop still opens, with a warning.
  if (!os || platforms.length === 0 || platforms.includes(os)) {
    return null;
  }

  const listed = platforms.map(name => PLATFORM_LABELS[name] ?? name);

  return (
    <div className="jp-WorkshopPanel-preflight">
      <div className="jp-WorkshopPanel-preflightTitle">
        This workshop was written for {listed.join(', ')}, not{' '}
        {PLATFORM_LABELS[os] ?? os}.
      </div>
      <div className="jp-WorkshopPanel-preflightHint">
        {os === 'lite'
          ? 'JupyterLite has no server and its terminal runs a small shell, so some actions may not work.'
          : 'Some commands may need adjusting.'}
      </div>
    </div>
  );
}

/** Shells that satisfy a `requires.shell` of each family. */
const SHELL_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  bash: ['bash'],
  zsh: ['zsh'],
  sh: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  powershell: ['powershell'],
  cmd: ['cmd']
};

function ShellBanner({
  manager
}: {
  manager: IWorkshopManager;
}): JSX.Element | null {
  const required = manager.workshop?.manifest.requires.shell;
  const platform = manager.platform;

  if (!required || !platform) {
    return null;
  }

  const accepted = SHELL_FAMILIES[required] ?? [required];

  if (accepted.includes(platform.shell)) {
    return null;
  }

  // JupyterLite terminals always run cockle; there is nothing to configure.
  if (platform.os === 'lite') {
    return (
      <div className="jp-WorkshopPanel-preflight">
        <div className="jp-WorkshopPanel-preflightTitle">
          This workshop expects a <code>{required}</code> shell but JupyterLite
          terminals run <code>cockle</code>, a small shell.
        </div>
        <div className="jp-WorkshopPanel-preflightHint">
          Commands that chain with <code>&amp;&amp;</code>, expand variables or
          substitute commands will not work as written.
        </div>
      </div>
    );
  }

  // The terminal shell is a server setting, so the advice names the
  // configuration line rather than a button.
  const example =
    platform.os === 'windows' && required !== 'powershell' && required !== 'cmd'
      ? `c.ServerApp.terminado_settings = {"shell_command": ["C:\\Program Files\\Git\\bin\\bash.exe"]}`
      : `c.ServerApp.terminado_settings = {"shell_command": ["${required}"]}`;

  return (
    <div className="jp-WorkshopPanel-preflight">
      <div className="jp-WorkshopPanel-preflightTitle">
        This workshop expects a <code>{required}</code> shell but terminals here
        run <code>{platform.shell}</code>.
      </div>
      <div className="jp-WorkshopPanel-preflightHint">
        Commands may need adjusting. To change the terminal shell, add to the
        server configuration and restart JupyterLab: <code>{example}</code>
        {platform.os === 'windows' && required === 'bash'
          ? ' (Git for Windows provides bash.)'
          : ''}
      </div>
    </div>
  );
}

function EnvironmentBanner({
  manager
}: {
  manager: IWorkshopManager;
}): JSX.Element | null {
  const environment = manager.environment;
  const declared = manager.workshop?.manifest.environment;

  if (!declared?.requirements || !environment) {
    return null;
  }

  if (environment.ready && environment.registered && !environment.stale) {
    return null;
  }

  // A page that carries the step explains it itself; the banner would
  // offer the same thing twice. It still shows for an error, which the
  // page's action cannot report as fully.
  const page = manager.currentPage;
  const onPage =
    page !== null &&
    visibleDirectives(page, manager.variables.values).some(
      node => node.name === 'environment-create'
    );

  if (onPage && !environment.error) {
    return null;
  }

  // Recreate rebuilds an environment that exists; Create is a no-op for
  // one that already matches its requirements.
  const request: IActionRequest = {
    type: 'environment-create',
    id: 'environment-create',
    argument: '',
    options: environment.ready ? { force: 'true' } : {},
    body: ''
  };
  const disposition = manager.disposition({
    kind: 'directive',
    name: 'environment-create',
    argument: '',
    id: 'environment-create',
    options: {},
    body: '',
    line: 0
  });
  const rejected = disposition.kind === 'reject';

  return (
    <div className="jp-WorkshopPanel-preflight jp-WorkshopPanel-environment">
      <div className="jp-WorkshopPanel-preflightTitle">
        {environment.stale
          ? 'The requirements of this workshop changed since its environment was created.'
          : environment.ready
            ? 'The workshop environment exists but its kernel is not registered.'
            : 'This workshop wants its own Python environment.'}
      </div>
      <div className="jp-WorkshopPanel-preflightHint">
        A virtual environment is created inside the workshop from{' '}
        <code>{declared.requirements}</code> and a kernel named{' '}
        <code>{environment.kernel}</code> is registered for it. Notebooks and
        checks use that kernel once it exists. Nothing outside the workshop
        directory changes except the kernel registration, which is removed with
        the workshop.
      </div>
      {environment.error ? (
        <pre className="jp-WorkshopPanel-environmentLog">
          {environment.error}
        </pre>
      ) : null}
      <div className="jp-WorkshopPanel-environmentActions">
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={environment.creating || rejected}
          title={rejected ? disposition.reason : ''}
          onClick={() => void manager.runRequest(request, 'click')}
        >
          {environment.creating
            ? 'Creating…'
            : environment.ready
              ? 'Recreate environment'
              : 'Create environment'}
        </button>
        {rejected ? (
          <span className="jp-WorkshopPanel-note">{disposition.reason}</span>
        ) : null}
      </div>
    </div>
  );
}

function VerifyBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const status = manager.actionStatus(node.id);
  const label = node.options.label ?? node.options.title ?? 'Check progress';
  const triggers = parseTriggers(node.options.trigger).triggers.filter(
    trigger => trigger.kind !== 'click'
  );
  const disposition = manager.disposition(node);
  const trustBadge = dispositionBadge(disposition, node);
  const state =
    status.status === 'ok'
      ? 'pass'
      : status.status === 'error'
        ? 'fail'
        : status.status;

  return (
    <div
      className={`jp-WorkshopPanel-action jp-WorkshopPanel-verify jp-mod-verify-${state}`}
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-verifyMark" aria-hidden="true">
          {state === 'pass' ? '✓' : state === 'fail' ? '✗' : '○'}
        </span>
        <span className="jp-WorkshopPanel-actionLabel">{label}</span>
        {triggers.length > 0 ? (
          <span
            className="jp-WorkshopPanel-badge"
            title={`Runs on: ${triggers.map(describeTrigger).join(', ')}`}
          >
            auto
          </span>
        ) : null}
        {trustBadge ? (
          <span
            className={`jp-WorkshopPanel-badge ${trustBadge.className}`}
            title={trustBadge.title}
          >
            {trustBadge.label}
          </span>
        ) : null}
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-WorkshopPanel-verifyButton"
          disabled={status.status === 'running'}
          onClick={() => void manager.runAction(node, 'click')}
        >
          {status.status === 'running' ? 'Checking…' : 'Check'}
        </button>
      </div>
      {status.message ? (
        <div className="jp-WorkshopPanel-verifyMessage">{status.message}</div>
      ) : null}
    </div>
  );
}

function describeTrigger(trigger: {
  kind: string;
  id?: string;
  pattern?: string;
  path?: string;
  tag?: string;
  ms?: number;
}): string {
  switch (trigger.kind) {
    case 'action':
      return trigger.id ? `after ${trigger.id}` : 'after any action';
    case 'terminal-output':
      return `terminal prints "${trigger.pattern}"`;
    case 'file-saved':
      return `${trigger.path} is saved`;
    case 'cell-executed':
      return `cell "${trigger.tag}" runs`;
    case 'interval':
      return `every ${Math.round((trigger.ms ?? 0) / 1000)}s`;
    default:
      return trigger.kind;
  }
}

function QuizBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const parsed = parseQuiz(node.body, node.options);
  const status = manager.actionStatus(node.id);
  const [picked, setPicked] = useState<number[]>([]);

  if (!parsed.quiz) {
    return (
      <div className="jp-WorkshopPanel-action jp-mod-unknown">
        <div className="jp-WorkshopPanel-actionHeader">
          <span className="jp-WorkshopPanel-actionLabel">Invalid quiz</span>
        </div>
        <div className="jp-WorkshopPanel-actionMessage">
          {parsed.errors.join('; ')}
        </div>
      </div>
    );
  }

  const quiz = parsed.quiz;
  const order = quiz.shuffle
    ? shuffled(quiz.options.length, node.id)
    : quiz.options.map((_, index) => index);
  const passed = status.status === 'ok';
  const exhausted =
    quiz.attempts > 0 && status.runs >= quiz.attempts && !passed;
  const locked = passed || exhausted || status.status === 'running';
  const remaining = quiz.attempts > 0 ? quiz.attempts - status.runs : null;

  const toggle = (index: number): void => {
    if (quiz.type === 'single') {
      setPicked([index]);
    } else {
      setPicked(current =>
        current.includes(index)
          ? current.filter(item => item !== index)
          : [...current, index]
      );
    }
  };

  return (
    <div
      className={`jp-WorkshopPanel-action jp-WorkshopPanel-quiz jp-mod-status-${status.status}`}
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          {node.options.title ?? 'Quiz'}
        </span>
        <span className="jp-WorkshopPanel-actionStatus">
          {passed ? 'correct' : exhausted ? 'no attempts left' : ''}
        </span>
      </div>
      <div className="jp-WorkshopPanel-quizBody">
        <div className="jp-WorkshopPanel-quizQuestion">{quiz.question}</div>
        <div className="jp-WorkshopPanel-quizOptions">
          {order.map(index => (
            <label key={index} className="jp-WorkshopPanel-quizOption">
              <input
                type={quiz.type === 'single' ? 'radio' : 'checkbox'}
                name={`quiz-${node.id}`}
                checked={picked.includes(index)}
                disabled={locked}
                onChange={() => toggle(index)}
              />{' '}
              {quiz.options[index].text}
            </label>
          ))}
        </div>
        <div className="jp-WorkshopPanel-quizFooter">
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-accept"
            disabled={locked || picked.length === 0}
            onClick={() =>
              void manager.runAction(node, 'click', JSON.stringify(picked))
            }
          >
            Submit
          </button>
          {remaining !== null && !passed ? (
            <span className="jp-WorkshopPanel-quizAttempts">
              {remaining} {remaining === 1 ? 'attempt' : 'attempts'} left
            </span>
          ) : null}
        </div>
        {status.message && status.status !== 'running' ? (
          <div
            className={`jp-WorkshopPanel-quizFeedback${passed ? ' jp-mod-pass' : ' jp-mod-fail'}`}
          >
            {status.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function shuffled(count: number, seed: string): number[] {
  // A stable shuffle per quiz id, so re-renders keep the same order.
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  const order = Array.from({ length: count }, (_, index) => index);

  for (let index = count - 1; index > 0; index -= 1) {
    hash = (hash * 1103515245 + 12345) >>> 0;

    const other = hash % (index + 1);

    [order[index], order[other]] = [order[other], order[index]];
  }

  return order;
}

function FormBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const parsed = parseForm(node.body);
  const status = manager.actionStatus(node.id);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};

    for (const field of parsed.form?.fields ?? []) {
      initial[field.name] =
        manager.variables.get(field.name) ?? field.default ?? '';
    }

    return initial;
  });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  if (!parsed.form) {
    return (
      <div className="jp-WorkshopPanel-action jp-mod-unknown">
        <div className="jp-WorkshopPanel-actionHeader">
          <span className="jp-WorkshopPanel-actionLabel">Invalid form</span>
        </div>
        <div className="jp-WorkshopPanel-actionMessage">
          {parsed.errors.join('; ')}
        </div>
      </div>
    );
  }

  const form = parsed.form;
  const update = (name: string, value: string): void => {
    setValues(current => ({ ...current, [name]: value }));
    setProblems(current => {
      const next = { ...current };

      delete next[name];

      return next;
    });
  };
  const submit = (): void => {
    const found = validateForm(form, values);

    setProblems(found);

    if (Object.keys(found).length === 0) {
      void manager.runAction(node, 'click', JSON.stringify(values));
    }
  };

  return (
    <form
      className={`jp-WorkshopPanel-action jp-WorkshopPanel-form jp-mod-status-${status.status}`}
      data-action-id={node.id}
      noValidate
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          {node.options.title ?? node.options.label ?? 'Your details'}
        </span>
        <span className="jp-WorkshopPanel-actionStatus">
          {status.status === 'ok' ? 'saved' : ''}
        </span>
      </div>
      <div className="jp-WorkshopPanel-formBody">
        {form.fields.map(field => (
          <FormFieldInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ''}
            problem={problems[field.name]}
            revealed={revealed[field.name] ?? false}
            onReveal={() =>
              setRevealed(current => ({
                ...current,
                [field.name]: !current[field.name]
              }))
            }
            onChange={value => update(field.name, value)}
          />
        ))}
        <div className="jp-WorkshopPanel-formFooter">
          <button
            type="submit"
            className="jp-Button jp-mod-styled jp-mod-accept"
            disabled={status.status === 'running'}
          >
            {status.status === 'ok' ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
      {status.status === 'error' && status.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{status.message}</div>
      ) : null}
    </form>
  );
}

function FormFieldInput({
  field,
  value,
  problem,
  revealed,
  onReveal,
  onChange
}: {
  field: IFormField;
  value: string;
  problem?: string;
  revealed: boolean;
  onReveal: () => void;
  onChange: (value: string) => void;
}): JSX.Element {
  let control: JSX.Element;

  switch (field.type) {
    case 'boolean':
      control = (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={event => onChange(event.target.checked ? 'true' : 'false')}
        />
      );
      break;

    case 'select':
      control = (
        <select value={value} onChange={event => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {field.options.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;

    case 'multiselect': {
      const chosen = value
        .split(',')
        .map(item => item.trim())
        .filter(item => item !== '');

      control = (
        <div className="jp-WorkshopPanel-formChoices">
          {field.options.map(option => (
            <label key={option}>
              <input
                type="checkbox"
                checked={chosen.includes(option)}
                onChange={event =>
                  onChange(
                    (event.target.checked
                      ? [...chosen, option]
                      : chosen.filter(item => item !== option)
                    ).join(',')
                  )
                }
              />{' '}
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }

    case 'secret':
      control = (
        <span className="jp-WorkshopPanel-formSecret">
          <input
            type={revealed ? 'text' : 'password'}
            value={value}
            placeholder={field.placeholder}
            autoComplete="off"
            onChange={event => onChange(event.target.value)}
          />
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-minimal"
            onClick={onReveal}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </span>
      );
      break;

    default:
      control = (
        <input
          type={
            field.type === 'number'
              ? 'number'
              : field.type === 'email'
                ? 'email'
                : field.type === 'url'
                  ? 'url'
                  : 'text'
          }
          value={value}
          placeholder={field.placeholder}
          min={field.type === 'number' ? field.min : undefined}
          max={field.type === 'number' ? field.max : undefined}
          onChange={event => onChange(event.target.value)}
        />
      );
      break;
  }

  return (
    <label
      className={`jp-WorkshopPanel-formField${problem ? ' jp-mod-invalid' : ''}`}
    >
      <span className="jp-WorkshopPanel-formLabel">
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {control}
      {field.description ? (
        <span className="jp-WorkshopPanel-formHelp">{field.description}</span>
      ) : null}
      {problem ? (
        <span className="jp-WorkshopPanel-formProblem">{problem}</span>
      ) : null}
    </label>
  );
}

function UnknownBlock({ node }: { node: IDirectiveNode }): JSX.Element {
  return (
    <div
      className="jp-WorkshopPanel-action jp-mod-unknown"
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          Unknown directive "{node.name}"
        </span>
      </div>
      <pre className="jp-WorkshopPanel-actionBody">{node.body}</pre>
    </div>
  );
}

function roleRequest(role: string, value: string): IActionRequest | null {
  switch (role) {
    case 'open':
      return {
        type: 'file-open',
        id: 'role-open',
        argument: '',
        options: { path: value },
        body: ''
      };
    case 'copy':
      return {
        type: 'copy',
        id: 'role-copy',
        argument: '',
        options: {},
        body: value
      };
    case 'highlight':
      return {
        type: 'highlight',
        id: 'role-highlight',
        argument: '',
        options: { selector: value },
        body: ''
      };
    default:
      return null;
  }
}

function dispositionBadge(
  disposition: ActionDisposition,
  node: IDirectiveNode
): { label: string; title: string; className: string } | null {
  switch (disposition.kind) {
    case 'reject':
      return {
        label: 'not allowed',
        title: disposition.reason,
        className: 'jp-mod-reject'
      };
    case 'skip':
      return {
        label: node.options.auto ? 'auto off' : 'off',
        title: disposition.reason,
        className: 'jp-mod-trust'
      };
    case 'downgrade':
      return {
        label: 'types only',
        title: disposition.reason,
        className: 'jp-mod-trust'
      };
    case 'confirm':
      return {
        label: 'confirms',
        title: disposition.reason,
        className: 'jp-mod-trust'
      };
    default:
      return null;
  }
}

function displayText(node: IDirectiveNode): string {
  const body = ACTION_TYPES[node.name]?.body;

  if (body === 'none' || node.name === 'file-open') {
    return '';
  }

  return node.body;
}

function showsOutput(node: IDirectiveNode): boolean {
  return node.name === 'execute-capture' || node.name === 'kernel-execute';
}

function statusText(status: { status: string; runs: number }): string {
  switch (status.status) {
    case 'running':
      return 'running';
    case 'ok':
      return status.runs > 1 ? `done ×${status.runs}` : 'done';
    case 'error':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return '';
  }
}
