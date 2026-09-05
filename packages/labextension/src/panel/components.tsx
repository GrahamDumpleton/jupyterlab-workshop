import {
  IDirectiveNode,
  IPage,
  IProseNode,
  isActionType
} from '@educates/workshop-core';
import {
  UseSignal,
  caretLeftIcon,
  caretRightIcon,
  closeIcon,
  folderIcon,
  runIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import React, { useCallback, useState } from 'react';

import {
  CommandIDs,
  IActionRegistry,
  IActionRequest,
  IWorkshopManager
} from '../tokens';

/** Props shared by the panel components. */
export interface IPanelProps {
  manager: IWorkshopManager;
  registry: IActionRegistry;
  commands: CommandRegistry;
}

type ActionStatus = 'idle' | 'running' | 'ok' | 'error';

interface IActionState {
  status: ActionStatus;
  message?: string;
}

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

function PanelContent({
  manager,
  registry,
  commands
}: IPanelProps): JSX.Element {
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

  const count = workshop.pages.length;
  const index = manager.pageIndex;

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
          <button
            type="button"
            className="jp-WorkshopPanel-iconButton"
            title="Open another workshop"
            onClick={() => void commands.execute(CommandIDs.open)}
          >
            <folderIcon.react tag="span" width="16px" height="16px" />
          </button>
          <button
            type="button"
            className="jp-WorkshopPanel-iconButton"
            title="Close this workshop"
            onClick={() => void commands.execute(CommandIDs.close)}
          >
            <closeIcon.react tag="span" width="16px" height="16px" />
          </button>
        </div>
        <div
          className="jp-WorkshopPanel-progress"
          title={`Page ${index + 1} of ${count}`}
        >
          <div
            className="jp-WorkshopPanel-progressBar"
            style={{ width: `${((index + 1) / count) * 100}%` }}
          />
        </div>
        <div className="jp-WorkshopPanel-nav">
          <button
            type="button"
            className="jp-WorkshopPanel-iconButton"
            title="Previous page"
            disabled={index === 0}
            onClick={() => manager.previous()}
          >
            <caretLeftIcon.react tag="span" width="16px" height="16px" />
          </button>
          <select
            className="jp-WorkshopPanel-pageSelect"
            value={index}
            onChange={event => manager.goTo(Number(event.target.value))}
          >
            {workshop.pages.map((item, position) => (
              <option key={item.path} value={position}>
                {position + 1}. {item.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="jp-WorkshopPanel-iconButton"
            title="Next page"
            disabled={index >= count - 1}
            onClick={() => manager.next()}
          >
            <caretRightIcon.react tag="span" width="16px" height="16px" />
          </button>
        </div>
      </div>
      <PageBody
        key={`${workshop.path}:${page.id}`}
        page={page}
        registry={registry}
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
        <span className="jp-WorkshopPanel-pageCount">
          {index + 1} / {count}
        </span>
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
  registry
}: {
  page: IPage;
  registry: IActionRegistry;
}): JSX.Element {
  const [states, setStates] = useState<Record<string, IActionState>>({});

  const run = useCallback(
    async (key: string, request: IActionRequest): Promise<void> => {
      setStates(previous => ({ ...previous, [key]: { status: 'running' } }));

      const result = await registry.run(request);

      setStates(previous => ({
        ...previous,
        [key]: { status: result.status, message: result.message }
      }));
    },
    [registry]
  );

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
        void run(
          `role:${target.dataset.role}:${target.dataset.value}`,
          request
        );
      }
    },
    [run]
  );

  return (
    <div className="jp-WorkshopPanel-body">
      <h3 className="jp-WorkshopPanel-pageTitle">{page.title}</h3>
      {page.warnings.length > 0 ? (
        <div className="jp-WorkshopPanel-warnings">
          {page.warnings.map((warning, position) => (
            <div key={position}>{warning}</div>
          ))}
        </div>
      ) : null}
      {page.nodes.map((node, position) =>
        node.kind === 'prose' ? (
          <ProseBlock key={position} node={node} onClick={onProseClick} />
        ) : (
          <ActionBlock
            key={node.id}
            node={node}
            label={registry.describe(toRequest(node))}
            state={states[node.id] ?? { status: 'idle' }}
            onRun={() => void run(node.id, toRequest(node))}
          />
        )
      )}
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

function ActionBlock({
  node,
  label,
  state,
  onRun
}: {
  node: IDirectiveNode;
  label: string;
  state: IActionState;
  onRun: () => void;
}): JSX.Element {
  if (!isActionType(node.name)) {
    return (
      <div className="jp-WorkshopPanel-action jp-mod-unknown">
        <div className="jp-WorkshopPanel-actionHeader">
          <span className="jp-WorkshopPanel-actionLabel">
            Unknown directive "{node.name}"
          </span>
        </div>
        <pre className="jp-WorkshopPanel-actionBody">{node.body}</pre>
      </div>
    );
  }

  const title = node.options.title ?? label;
  const display = displayText(node);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRun();
    }
  };

  return (
    <div
      className={`jp-WorkshopPanel-action jp-mod-${node.name} jp-mod-status-${state.status}`}
      role="button"
      tabIndex={0}
      title="Click to run"
      onClick={onRun}
      onKeyDown={onKeyDown}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <runIcon.react tag="span" width="14px" height="14px" />
        <span className="jp-WorkshopPanel-actionLabel">{title}</span>
        <span className="jp-WorkshopPanel-actionStatus">
          {statusText(state.status)}
        </span>
      </div>
      {display ? (
        <pre className="jp-WorkshopPanel-actionBody">{display}</pre>
      ) : null}
      {state.status === 'error' && state.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{state.message}</div>
      ) : null}
    </div>
  );
}

function toRequest(node: IDirectiveNode): IActionRequest {
  return {
    type: node.name,
    id: node.id,
    options: node.options,
    body: node.body
  };
}

function roleRequest(role: string, value: string): IActionRequest | null {
  switch (role) {
    case 'open':
      return {
        type: 'file-open',
        id: `role-open`,
        options: { path: value },
        body: ''
      };
    case 'copy':
      return { type: 'copy', id: 'role-copy', options: {}, body: value };
    case 'highlight':
      return {
        type: 'highlight',
        id: 'role-highlight',
        options: { selector: value },
        body: ''
      };
    default:
      return null;
  }
}

function displayText(node: IDirectiveNode): string {
  switch (node.name) {
    case 'file-open':
      return '';
    case 'highlight':
      return node.body;
    default:
      return node.body;
  }
}

function statusText(status: ActionStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'ok':
      return 'done';
    case 'error':
      return 'failed';
    default:
      return '';
  }
}
