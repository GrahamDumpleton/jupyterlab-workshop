import { renderPlainMarkdown } from '@jupyterlab-workshop/core';
import {
  Dialog,
  ReactWidget,
  showDialog,
  UseSignal
} from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { stopIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import { requestAPI } from '../request';
import { errorMessage } from '../tokens';
import { AgentConnection, IAgentInfo, IAgentMessage } from './connection';
import { ConversationModel, TranscriptItem } from './model';

/** What the server says about the agent before a conversation starts. */
export interface IAgentStatus {
  provider: string;
  available: boolean;
  install_hint: string;
  logged_in: boolean;
  auth_method: string;
  plan: string;
  warnings: string[];

  /** The line to type in a terminal to log the agent in, if it has one. */
  login: string | null;
}

/** The name the panel goes by. */
export const AUTHOR_TITLE = 'Workshop Author';

/**
 * Workshop Author: a conversation with an AI agent about one of the
 * library owner's workshops, in the main area. The conversation lives in
 * the server; the panel shows it and sends what the person types.
 */
export class AuthorPanel extends ReactWidget {
  constructor(options: AuthorPanel.IOptions) {
    super();

    this._options = options;
    this.id = AuthorPanel.idFor(options.path);
    this.title.label = `${AUTHOR_TITLE}: ${lastSegment(options.path)}`;
    this.title.caption = `${AUTHOR_TITLE} for ${options.path}`;
    this.title.closable = true;
    this.addClass('jp-WorkshopAgent');

    this._connection = new AgentConnection({
      serverSettings: options.serverSettings,
      open: options.open
    });
    this._connection.message.connect(this._onMessage, this);

    void this._checkStatus();
  }

  /** The id of the panel for a workshop, so there is one per workshop. */
  static idFor(path: string): string {
    return `jupyterlab-workshop-author-${encodeURIComponent(path)}`;
  }

  /** The workshop the conversation is about. */
  get path(): string {
    return this._options.path;
  }

  /** The conversation as shown. */
  get model(): ConversationModel {
    return this._model;
  }

  /**
   * Send a message, as if typed. A message given before the conversation
   * has opened is sent once it has.
   */
  send(text: string): void {
    if (this._model.state === 'ready') {
      this._connection.send(text);
    } else {
      this._queued.push(text);
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._connection.dispose();
    super.dispose();
  }

  /**
   * Closing the tab ends the panel, not the conversation, which goes on
   * in the server and is shown again when the workshop's panel reopens.
   * Without this a closed panel would only be detached, and found again
   * by its workshop without being shown.
   */
  close(): void {
    super.close();
    this.dispose();
  }

  protected render(): JSX.Element {
    return (
      <UseSignal signal={this._model.changed}>
        {() => (
          <AuthorContent
            panel={this}
            status={this._status}
            statusError={this._statusError}
            onSend={text => this._connection.send(text)}
            onStop={() => this._connection.interrupt()}
            onAnswer={(id, allow, remember) => {
              this._connection.answer(id, allow, remember);
              this._model.answered(id, allow);
            }}
            onCheckAgain={() => void this._checkStatus()}
            onLogin={() => {
              if (this._status?.login) {
                void this._options.openTerminal('', this._status.login);
              }
            }}
            onOpenWorkshop={() => void this._options.openWorkshop()}
            onContinueInTerminal={() => this._connection.requestTerminal()}
            onConfigure={(model, effort) =>
              this._connection.configure(model, effort)
            }
            onCompact={() => this._connection.compact()}
            onNewConversation={() => void this._newConversation()}
          />
        )}
      </UseSignal>
    );
  }

  /** Start the conversation over, once the person confirms. */
  private async _newConversation(): Promise<void> {
    const result = await showDialog({
      title: 'Start a new conversation?',
      body:
        'The agent forgets what was said so far and the conversation is ' +
        'cleared. The workshop itself is not changed.',
      buttons: [
        Dialog.cancelButton(),
        Dialog.warnButton({ label: 'New conversation' })
      ]
    });

    if (result.button.accept) {
      this._connection.clear();
    }
  }

  private async _checkStatus(): Promise<void> {
    this._statusError = '';

    try {
      this._status = await requestAPI<IAgentStatus>(
        'agent/status',
        this._options.serverSettings
      );
    } catch (error) {
      this._status = null;
      this._statusError = errorMessage(error);
    }

    // Only once the agent can run is the conversation opened.
    if (this._status?.available && this._status.logged_in) {
      this._connection.connect();
    }

    this.update();
  }

  private _onMessage(_: AgentConnection, message: IAgentMessage): void {
    if (message.type === 'terminal') {
      if (message.command) {
        void this._options.openTerminal(message.cwd, message.command);
      } else {
        this._model.handle({
          type: 'error',
          message:
            'There is no conversation to carry on yet: send a message first.'
        });
      }

      return;
    }

    this._model.handle(message);

    if (message.type === 'opened') {
      for (const text of this._queued.splice(0)) {
        this._connection.send(text);
      }
    }
  }

  private _options: AuthorPanel.IOptions;
  private _connection: AgentConnection;
  private _model = new ConversationModel();
  private _status: IAgentStatus | null = null;
  private _statusError = '';
  private _queued: string[] = [];
}

export namespace AuthorPanel {
  export interface IOptions {
    /** The workshop, relative to the JupyterLab root. */
    path: string;

    serverSettings: ServerConnection.ISettings;

    /** What the conversation is opened with; see AgentConnection. */
    open: () => Record<string, unknown>;

    /** Open a terminal in a directory under the root and type a command. */
    openTerminal: (cwd: string, command: string) => Promise<void>;

    /** Open the workshop in the instructions panel, in author mode. */
    openWorkshop: () => Promise<void>;
  }
}

function AuthorContent({
  panel,
  status,
  statusError,
  onSend,
  onStop,
  onAnswer,
  onCheckAgain,
  onLogin,
  onOpenWorkshop,
  onContinueInTerminal,
  onConfigure,
  onCompact,
  onNewConversation
}: {
  panel: AuthorPanel;
  status: IAgentStatus | null;
  statusError: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onAnswer: (id: string, allow: boolean, remember: boolean) => void;
  onCheckAgain: () => void;
  onLogin: () => void;
  onOpenWorkshop: () => void;
  onContinueInTerminal: () => void;
  onConfigure: (model: string, effort: string) => void;
  onCompact: () => void;
  onNewConversation: () => void;
}): JSX.Element {
  const model = panel.model;
  const [draft, setDraft] = React.useState('');
  const end = React.useRef<HTMLDivElement>(null);
  const ready = model.state === 'ready';

  // Keep the newest entry in view as the conversation grows.
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [model.items]);

  const submit = (): void => {
    const text = draft.trim();

    if (!text || model.running || !ready) {
      return;
    }

    onSend(text);
    setDraft('');
  };

  return (
    <div className="jp-WorkshopAgent-content">
      <div className="jp-WorkshopAgent-header">
        <div className="jp-WorkshopAgent-title">
          <h2>{AUTHOR_TITLE}</h2>
          <span className="jp-WorkshopAgent-path">{panel.path}</span>
        </div>
        <div className="jp-WorkshopAgent-headerActions">
          {status?.logged_in ? (
            <span className="jp-WorkshopAgent-account">
              {describeAccount(status)}
            </span>
          ) : null}
          <button
            type="button"
            className="jp-WorkshopAgent-barButton"
            title="Start the conversation over; the agent forgets what was said so far"
            disabled={!ready || model.running || model.items.length === 0}
            onClick={onNewConversation}
          >
            New conversation
          </button>
        </div>
      </div>
      <Setup
        status={status}
        statusError={statusError}
        onCheckAgain={onCheckAgain}
        onLogin={onLogin}
      />
      {model.state === 'failed' ? (
        <p className="jp-WorkshopAgent-failure">{model.failure}</p>
      ) : null}
      <div className="jp-WorkshopAgent-transcript">
        {model.items.length === 0 && ready ? (
          <p className="jp-WorkshopAgent-hint">
            Say what the workshop should teach, or what to change in it.
          </p>
        ) : null}
        {model.items.map((item, index) => (
          <Entry
            key={index}
            item={item}
            workshop={panel.path}
            onAnswer={onAnswer}
          />
        ))}
        <div ref={end} />
      </div>
      <div className="jp-WorkshopAgent-composer">
        <textarea
          className="jp-WorkshopAgent-input"
          placeholder={
            ready
              ? 'Message Workshop Author (Enter to send, Shift+Enter for a new line)'
              : 'Waiting for the agent…'
          }
          rows={3}
          value={draft}
          disabled={!ready}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="jp-WorkshopAgent-bar">
          <div className="jp-WorkshopAgent-barControls">
            <button
              type="button"
              className="jp-WorkshopAgent-barButton"
              title="Open the workshop in the instructions panel, in author mode"
              onClick={onOpenWorkshop}
            >
              Open workshop
            </button>
            <button
              type="button"
              className="jp-WorkshopAgent-barButton"
              title="Carry the conversation on in a terminal, in the workshop's directory"
              disabled={!ready || model.running}
              onClick={onContinueInTerminal}
            >
              Continue in terminal
            </button>
            <ModelPicker
              info={model.info}
              disabled={!ready || model.running}
              onConfigure={onConfigure}
            />
            <span className="jp-WorkshopAgent-barGroup">
              <ContextMeter info={model.info} />
              <button
                type="button"
                className="jp-WorkshopAgent-barButton"
                title="Summarize the conversation so far, to free up the context window. The agent also does this by itself when the window fills."
                disabled={!ready || model.running || !model.sessionId}
                onClick={onCompact}
              >
                Compact
              </button>
            </span>
            {status?.auth_method === 'api_key' && model.info?.cost ? (
              <span
                className="jp-WorkshopAgent-barItem"
                title="What this conversation has cost on the API account so far"
              >
                ${model.info.cost.toFixed(2)}
              </span>
            ) : null}
          </div>
          <div className="jp-WorkshopAgent-barEnd">
            <span className="jp-WorkshopAgent-barStatus">
              {describeState(model)}
            </span>
            {model.running ? (
              <button
                type="button"
                className="jp-Button jp-mod-styled jp-mod-warn jp-WorkshopAgent-send"
                title="Stop the agent"
                onClick={onStop}
              >
                <stopIcon.react
                  tag="span"
                  width="12px"
                  height="12px"
                  display="flex"
                />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="jp-Button jp-mod-styled jp-mod-accept jp-WorkshopAgent-send"
                title="Send (Enter)"
                disabled={!ready || !draft.trim()}
                onClick={submit}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The model and effort the conversation answers with, changed between
 * turns. The choices are what the agent itself offers.
 */
function ModelPicker({
  info,
  disabled,
  onConfigure
}: {
  info: IAgentInfo | null;
  disabled: boolean;
  onConfigure: (model: string, effort: string) => void;
}): JSX.Element | null {
  if (!info || info.models.length === 0) {
    return info?.resolved ? (
      <span className="jp-WorkshopAgent-barItem">{info.resolved}</span>
    ) : null;
  }

  // An empty choice is the agent's default, which it may list by name.
  const hasDefault = info.models.some(choice => choice.value === 'default');
  const selected = info.model || (hasDefault ? 'default' : '');
  const choice = info.models.find(item => item.value === selected);
  const efforts = choice?.efforts ?? [];

  const choose = (value: string, effort: string): void => {
    const next = value === 'default' ? '' : value;
    const kept = info.models
      .find(item => item.value === value)
      ?.efforts.includes(effort)
      ? effort
      : '';

    onConfigure(next, kept);
  };

  return (
    <>
      <select
        className="jp-WorkshopAgent-select"
        aria-label="Model"
        title={
          info.resolved
            ? `Answering with ${info.resolved}. Choose another model for the next message.`
            : 'Choose the model for the next message'
        }
        value={selected}
        disabled={disabled}
        onChange={event => choose(event.target.value, info.effort)}
      >
        {hasDefault ? null : <option value="">Default</option>}
        {info.models.map(item => (
          <option key={item.value} value={item.value} title={item.description}>
            {item.name}
          </option>
        ))}
      </select>
      {efforts.length > 0 ? (
        <select
          className="jp-WorkshopAgent-select"
          aria-label="Effort"
          title="How much effort the model puts in. Changing it restarts the conversation from where it is, keeping what was said."
          value={info.effort}
          disabled={disabled}
          onChange={event => choose(selected, event.target.value)}
        >
          <option value="">Default effort</option>
          {efforts.map(level => (
            <option key={level} value={level}>
              {capitalize(level)}
            </option>
          ))}
        </select>
      ) : null}
    </>
  );
}

/** How much of the model's context window the conversation fills. */
function ContextMeter({
  info
}: {
  info: IAgentInfo | null;
}): JSX.Element | null {
  const used = info?.context_used ?? null;
  const limit = info?.context_limit ?? null;

  if (used === null || !limit) {
    return null;
  }

  const percent = Math.min(100, Math.round((used / limit) * 100));

  return (
    <span
      className="jp-WorkshopAgent-barItem jp-WorkshopAgent-context"
      title={`${used.toLocaleString()} of ${limit.toLocaleString()} tokens in the context window`}
    >
      <span className="jp-WorkshopAgent-meter">
        <span style={{ width: `${percent}%` }} />
      </span>
      {percent}% context
    </span>
  );
}

/** Where the conversation stands, in a word or two. */
function describeState(model: ConversationModel): string {
  switch (model.state) {
    case 'connecting':
      return 'Connecting…';
    case 'starting':
      return 'Starting…';
    case 'failed':
      return 'Not available';
    default:
      if (model.compacting) {
        return 'Compacting…';
      }

      return model.running ? 'Working…' : 'Ready';
  }
}

/** Whose account the agent answers on. */
function describeAccount(status: IAgentStatus): string {
  if (status.auth_method === 'api_key') {
    return 'Using an API key';
  }

  return status.plan
    ? `Claude ${capitalize(status.plan)} plan`
    : 'Claude subscription';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What stands between the person and a conversation, if anything. */
function Setup({
  status,
  statusError,
  onCheckAgain,
  onLogin
}: {
  status: IAgentStatus | null;
  statusError: string;
  onCheckAgain: () => void;
  onLogin: () => void;
}): JSX.Element | null {
  if (statusError) {
    return (
      <div className="jp-WorkshopAgent-setup">
        <p>Unable to ask the server about the agent: {statusError}</p>
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          onClick={onCheckAgain}
        >
          Check again
        </button>
      </div>
    );
  }

  if (status === null) {
    return null;
  }

  if (!status.available) {
    return (
      <div className="jp-WorkshopAgent-setup">
        <p>
          Workshop Author needs the AI extra installed where JupyterLab runs,
          then JupyterLab started again:
        </p>
        <pre>{status.install_hint}</pre>
      </div>
    );
  }

  const warnings = status.warnings.map(warning => (
    <p key={warning} className="jp-WorkshopAgent-warning">
      {warning}
    </p>
  ));

  if (!status.logged_in) {
    return (
      <div className="jp-WorkshopAgent-setup">
        <p>
          Workshop Author uses Claude Code&apos;s login. Log in in a terminal,
          then check again.
        </p>
        {warnings}
        <div className="jp-WorkshopAgent-setupActions">
          {status.login ? (
            <button
              type="button"
              className="jp-Button jp-mod-styled jp-mod-accept"
              onClick={onLogin}
            >
              Log in
            </button>
          ) : null}
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            onClick={onCheckAgain}
          >
            Check again
          </button>
        </div>
      </div>
    );
  }

  return warnings.length > 0 ? (
    <div className="jp-WorkshopAgent-setup">{warnings}</div>
  ) : null;
}

/** One entry of the transcript. */
function Entry({
  item,
  workshop,
  onAnswer
}: {
  item: TranscriptItem;

  /** The workshop's path, which paths in tool calls are shown relative to. */
  workshop: string;
  onAnswer: (id: string, allow: boolean, remember: boolean) => void;
}): JSX.Element {
  switch (item.type) {
    case 'user':
      return <div className="jp-WorkshopAgent-user">{item.text}</div>;

    case 'assistant':
      return (
        <div
          className="jp-WorkshopAgent-assistant jp-RenderedHTMLCommon"
          // The agent's reply is rendered as plain Markdown with raw HTML
          // escaped, as workshop pages are.
          dangerouslySetInnerHTML={{ __html: renderPlainMarkdown(item.text) }}
        />
      );

    case 'tool':
      return (
        <details
          className={`jp-WorkshopAgent-tool${
            item.result === undefined
              ? ''
              : item.result.ok
                ? ' jp-mod-ok'
                : ' jp-mod-failed'
          }`}
        >
          <summary>
            {describeTool(item.name, item.input, workshop)}
            {item.result === undefined ? '…' : ''}
          </summary>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result?.summary ? <pre>{item.result.summary}</pre> : null}
        </details>
      );

    case 'permission':
      return (
        <div className="jp-WorkshopAgent-permission">
          <p>
            <strong>{item.reason || `Uses ${item.tool}`}</strong>
          </p>
          <pre>{describeInput(item.tool, item.input)}</pre>
          {item.answer === undefined ? (
            <div className="jp-WorkshopAgent-setupActions">
              <button
                type="button"
                className="jp-Button jp-mod-styled jp-mod-accept"
                onClick={() => onAnswer(item.id, true, false)}
              >
                Allow
              </button>
              {item.rememberable ? (
                <button
                  type="button"
                  className="jp-Button jp-mod-styled"
                  title="Allow this again, without asking, for the rest of the conversation"
                  onClick={() => onAnswer(item.id, true, true)}
                >
                  Always allow
                </button>
              ) : null}
              <button
                type="button"
                className="jp-Button jp-mod-styled"
                onClick={() => onAnswer(item.id, false, false)}
              >
                Deny
              </button>
            </div>
          ) : (
            <p className="jp-WorkshopAgent-answer">
              {item.answer === 'allowed'
                ? 'Allowed.'
                : item.answer === 'denied'
                  ? 'Denied.'
                  : 'No longer waiting.'}
            </p>
          )}
        </div>
      );

    case 'error':
      return <p className="jp-WorkshopAgent-error">{item.message}</p>;

    case 'note':
      return <p className="jp-WorkshopAgent-note">{item.text}</p>;

    case 'compacted':
      return (
        <p
          className="jp-WorkshopAgent-compacted"
          title={describeTokens(item.tokensBefore, item.tokensAfter)}
        >
          {item.automatic
            ? 'Conversation compacted automatically, as the context window was filling'
            : 'Conversation compacted'}
        </p>
      );
  }
}

/** A tool call in a few words: what it did, to what. */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
  workshop = ''
): string {
  const tool = name.startsWith('mcp__workshop__')
    ? name.slice('mcp__workshop__'.length).replace(/_/g, ' ')
    : name;
  let target = String(
    input.file_path ?? input.path ?? input.directory ?? input.command ?? ''
  );

  // The agent names files by absolute path; inside the workshop the part
  // up to the workshop is noise.
  const marker = workshop ? `/${workshop}/` : '';
  const at = marker ? target.indexOf(marker) : -1;

  if (at >= 0) {
    target = target.slice(at + marker.length);
  }

  return target ? `${tool}: ${target}` : tool;
}

/** The tokens compaction freed, when the agent said. */
function describeTokens(before: number | null, after: number | null): string {
  if (before === null) {
    return 'The conversation so far was replaced by a summary of it';
  }

  return after === null
    ? `${before.toLocaleString()} tokens were summarized`
    : `${before.toLocaleString()} tokens down to ${after.toLocaleString()}`;
}

function describeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return input.command;
  }

  if (typeof input.file_path === 'string') {
    return input.file_path;
  }

  return JSON.stringify(input, null, 2);
}

function lastSegment(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
