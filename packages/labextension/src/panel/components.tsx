import {
  ACTION_TYPES,
  IDirectiveNode,
  IPage,
  IProseNode,
  PageNode,
  isActionType
} from '@educates/workshop-core';
import {
  UseSignal,
  caretLeftIcon,
  caretRightIcon,
  checkIcon,
  closeIcon,
  folderIcon,
  listIcon,
  runIcon,
  settingsIcon,
  stopIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import React, { useCallback, useEffect, useReducer, useRef } from 'react';

import { CommandIDs, IActionRequest, IWorkshopManager } from '../tokens';

/** Props shared by the panel components. */
export interface IPanelProps {
  manager: IWorkshopManager;
  commands: CommandRegistry;
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

function PanelContent({ manager, commands }: IPanelProps): JSX.Element {
  const workshop = manager.workshop;
  const page = manager.currentPage;

  if (!workshop || !page) {
    return (
      <EmptyState
        error={manager.error}
        onOpen={() => void commands.execute(CommandIDs.open)}
      />
    );
  }

  const visible = manager.visiblePages;
  const count = visible.length;
  const index = manager.pageIndex;
  const doneCount = visible.filter(
    item => manager.pageProgress(item.id).done
  ).length;
  const done = manager.pageProgress(page.id).done;
  const run = (command: string): void => void commands.execute(command);

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
            icon={folderIcon}
            title="Open another workshop"
            onClick={() => run(CommandIDs.open)}
          />
          <IconButton
            icon={closeIcon}
            title="Close this workshop"
            onClick={() => run(CommandIDs.close)}
          />
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
      />
      <div className="jp-WorkshopPanel-footer">
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          disabled={index === 0}
          onClick={() => manager.previous()}
        >
          Previous
        </button>
        <button
          type="button"
          className={`jp-Button jp-mod-styled jp-WorkshopPanel-doneButton${done ? ' jp-mod-done' : ''}`}
          title={done ? 'Mark this page as not done' : 'Mark this page as done'}
          onClick={() => manager.markDone(page.id, !done)}
        >
          <checkIcon.react tag="span" width="14px" height="14px" />
          {done ? 'Done' : 'Mark done'}
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={index >= count - 1}
          onClick={() => manager.next()}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  error,
  onOpen
}: {
  error: string | null;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="jp-WorkshopPanel-empty">
      <p>No workshop is open.</p>
      {error ? <p className="jp-WorkshopPanel-error">{error}</p> : null}
      <button
        type="button"
        className="jp-Button jp-mod-styled jp-mod-accept"
        onClick={onOpen}
      >
        Open a workshop
      </button>
    </div>
  );
}

function PageBody({
  page,
  manager
}: {
  page: IPage;
  manager: IWorkshopManager;
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
      {page.warnings.length > 0 ? (
        <div className="jp-WorkshopPanel-warnings">
          {page.warnings.map((warning, position) => (
            <div key={position}>{warning}</div>
          ))}
        </div>
      ) : null}
      <Nodes nodes={page.nodes} manager={manager} onProseClick={onProseClick} />
    </div>
  );
}

function Nodes({
  nodes,
  manager,
  onProseClick
}: {
  nodes: PageNode[];
  manager: IWorkshopManager;
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
              onProseClick={onProseClick}
            />
          ) : null;
        }

        if (node.options.when && !manager.evaluate(node.options.when)) {
          return null;
        }

        return <DirectiveBlock key={node.id} node={node} manager={manager} />;
      })}
    </>
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
      return <HintBlock node={node} />;
    case 'choice':
      return <ChoiceBlock node={node} manager={manager} />;
    default:
      return isActionType(node.name) ? (
        <ActionBlock node={node} manager={manager} />
      ) : (
        <UnknownBlock node={node} />
      );
  }
}

function HintBlock({ node }: { node: IDirectiveNode }): JSX.Element {
  return (
    <details
      className="jp-WorkshopPanel-hint"
      open={node.options.open === 'true'}
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
  const status = manager.actionStatus(node.id);
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
