import { renderPlainMarkdown } from '@jupyterlab-workshop/core';
import {
  Dialog,
  ReactWidget,
  showDialog,
  UseSignal
} from '@jupyterlab/apputils';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { stopIcon } from '@jupyterlab/ui-components';
import { IDragEvent } from '@lumino/dragdrop';
import { ISignal, Signal } from '@lumino/signaling';
import * as React from 'react';

import { requestAPI } from '../request';
import { errorMessage } from '../tokens';
import {
  checkRoom,
  describeSize,
  IAttachment,
  IPendingAttachment,
  isLongPaste,
  pastedText,
  prepareAttachment,
  releaseAttachment
} from './attachments';
import { AgentConnection, IAgentInfo, IAgentMessage } from './connection';
import {
  ConversationModel,
  IAttachmentInfo,
  IProposal,
  IQuestion,
  TranscriptItem
} from './model';

/** The mime type the file browser drags paths under. */
const CONTENTS_MIME = 'application/x-jupyter-icontents';

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

    // A draft has no workshop yet, so it goes by its own id until the
    // workshop is created and a panel for it takes over.
    if (options.draft) {
      this.id = AuthorPanel.idForDraft(options.draft);
      this.title.label = `${AUTHOR_TITLE}: New workshop`;
      this.title.caption = `${AUTHOR_TITLE}, drafting a new workshop`;
    } else {
      this.id = AuthorPanel.idFor(options.path);
      this.title.label = `${AUTHOR_TITLE}: ${lastSegment(options.path)}`;
      this.title.caption = `${AUTHOR_TITLE} for ${options.path}`;
    }

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

  /** The id of the panel drafting a new workshop. */
  static idForDraft(draft: string): string {
    return `jupyterlab-workshop-author-draft-${draft}`;
  }

  /** The workshop the conversation is about; empty while drafting. */
  get path(): string {
    return this._options.path;
  }

  /** The draft's id while a new workshop is drafted; empty otherwise. */
  get draft(): string {
    return this._options.draft ?? '';
  }

  /** Emitted with the workshop's path when a draft's workshop is created. */
  get created(): ISignal<this, string> {
    return this._created;
  }

  /** The conversation as shown. */
  get model(): ConversationModel {
    return this._model;
  }

  /** The files attached to the message being written, not yet sent. */
  get pending(): readonly IPendingAttachment[] {
    return this._pending;
  }

  /** What went wrong with the last file attached, if anything. */
  get attachError(): string {
    return this._attachError;
  }

  /**
   * Send a message, as if typed. A message given before the conversation
   * has opened is sent once it has.
   */
  send(text: string, attachments: IAttachment[] = []): void {
    if (this._model.state === 'ready') {
      this._connection.send(text, attachments);
    } else {
      this._queued.push({ text, attachments });
    }
  }

  /**
   * Attach files to the message being written. Each is checked and made
   * ready; one that cannot be attached is reported and the rest go on.
   */
  async attach(files: Iterable<{ blob: Blob; name: string }>): Promise<void> {
    this._attachError = '';

    for (const file of files) {
      try {
        const attachment = await prepareAttachment(file.blob, file.name);

        checkRoom(this._pending, attachment);
        this._pending = [...this._pending, attachment];
      } catch (error) {
        this._attachError = errorMessage(error);
      }
    }

    this.update();
  }

  /** Attach pasted text as a file, named by how many have been. */
  async attachText(text: string): Promise<void> {
    this._pasted += 1;

    try {
      const attachment = await pastedText(text, this._pasted);

      checkRoom(this._pending, attachment);
      this._pending = [...this._pending, attachment];
      this._attachError = '';
    } catch (error) {
      this._attachError = errorMessage(error);
    }

    this.update();
  }

  /** Take an attachment off the message being written. */
  detach(index: number): void {
    const [removed] = this._pending.splice(index, 1);

    if (removed) {
      releaseAttachment(removed);
    }

    this._pending = [...this._pending];
    this._attachError = '';
    this.update();
  }

  /** The attachments to send, and the composer cleared of them. */
  takePending(): IAttachment[] {
    const taken = this._pending.map(({ name, type, data }) => ({
      name,
      type,
      data
    }));

    this._pending.forEach(releaseAttachment);
    this._pending = [];
    this._attachError = '';

    return taken;
  }

  /** Files dragged from the file browser are attached on drop. */
  handleEvent(event: Event): void {
    switch (event.type) {
      case 'lm-dragenter':
      case 'lm-dragover':
        this._dragOver(event as IDragEvent);
        break;

      case 'lm-drop':
        this._drop(event as IDragEvent);
        break;
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._pending.forEach(releaseAttachment);
    this._connection.dispose();
    super.dispose();
  }

  protected onAfterAttach(): void {
    this.node.addEventListener('lm-dragenter', this);
    this.node.addEventListener('lm-dragover', this);
    this.node.addEventListener('lm-drop', this);
  }

  protected onBeforeDetach(): void {
    this.node.removeEventListener('lm-dragenter', this);
    this.node.removeEventListener('lm-dragover', this);
    this.node.removeEventListener('lm-drop', this);
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
            onSend={text => this._connection.send(text, this.takePending())}
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
            onAnswerQuestion={(id, answers) => {
              this._connection.answerQuestion(id, answers);
              this._model.answeredQuestion(id, answers);
            }}
            onCreate={() => this._connection.create()}
            onDiscard={() => void this._discard()}
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

  /** End the draft, once the person confirms. */
  private async _discard(): Promise<void> {
    const result = await showDialog({
      title: 'Discard this draft?',
      body: 'The conversation is forgotten. Nothing was created, so nothing else changes.',
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Discard' })]
    });

    if (result.button.accept) {
      this._connection.discard();
    }
  }

  private _dragOver(event: IDragEvent): void {
    if (!this._options.contents || !event.mimeData.hasData(CONTENTS_MIME)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dropAction = 'copy';
  }

  private _drop(event: IDragEvent): void {
    const contents = this._options.contents;
    const paths = event.mimeData.getData(CONTENTS_MIME);

    if (!contents || !Array.isArray(paths) || event.proposedAction === 'none') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dropAction = 'copy';

    void this._attachPaths(contents, paths.map(String));
  }

  // Files from the file browser come through the contents API: binary
  // ones as base64, text as text, notebooks as JSON. A directory is left.
  private async _attachPaths(
    contents: Contents.IManager,
    paths: string[]
  ): Promise<void> {
    const files: { blob: Blob; name: string }[] = [];

    for (const path of paths) {
      try {
        const model = await contents.get(path, { content: true });

        if (model.type === 'directory') {
          continue;
        }

        files.push({ blob: blobOf(model), name: lastSegment(path) });
      } catch (error) {
        this._attachError = `Unable to read ${path}: ${errorMessage(error)}`;
        this.update();
      }
    }

    await this.attach(files);
  }

  private _reveal(): void {
    this._options.reveal();

    // Once shown and drawn, scroll the newest request into view.
    requestAnimationFrame(() => {
      const requests = this.node.querySelectorAll(
        '.jp-WorkshopAgent-permission, .jp-WorkshopAgent-question'
      );

      requests[requests.length - 1]?.scrollIntoView({ block: 'center' });
    });
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

    if (message.type === 'created') {
      this._created.emit(message.path);

      return;
    }

    // A discarded draft has nothing left to show.
    if (message.type === 'closed' && this.draft) {
      this.dispose();

      return;
    }

    this._model.handle(message);

    // A request the agent waits on is no use behind other tabs, so the
    // panel comes to the front with the request in view.
    if (
      message.type === 'event' &&
      (message.event.kind === 'permission' || message.event.kind === 'question')
    ) {
      this._reveal();
    }

    // A play-through that passed has closed the workshop, so this
    // conversation, the one that asked for the run, comes back to the
    // front: not whichever tab was left showing when the workshop's
    // documents and terminals closed.
    if (
      message.type === 'event' &&
      message.event.kind === 'tool-result' &&
      this._model.closedWorkshop(String(message.event.id ?? ''))
    ) {
      this._options.reveal();
    }

    if (message.type === 'opened') {
      for (const queued of this._queued.splice(0)) {
        this._connection.send(queued.text, queued.attachments);
      }
    }
  }

  private _options: AuthorPanel.IOptions;
  private _created = new Signal<this, string>(this);
  private _connection: AgentConnection;
  private _model = new ConversationModel();
  private _status: IAgentStatus | null = null;
  private _statusError = '';
  private _queued: { text: string; attachments: IAttachment[] }[] = [];
  private _pending: IPendingAttachment[] = [];
  private _attachError = '';
  private _pasted = 0;
}

export namespace AuthorPanel {
  export interface IOptions {
    /** The workshop, relative to the JupyterLab root; empty for a draft. */
    path: string;

    /** The draft's id, for a workshop not created yet. */
    draft?: string;

    serverSettings: ServerConnection.ISettings;

    /** What the conversation is opened with; see AgentConnection. */
    open: () => Record<string, unknown>;

    /** Open a terminal in a directory under the root and type a command. */
    openTerminal: (cwd: string, command: string) => Promise<void>;

    /** Open the workshop in the instructions panel, in author mode. */
    openWorkshop: () => Promise<void>;

    /** Bring the panel to the front, for something that needs an answer. */
    reveal: () => void;

    /** The contents API, for files dragged in from the file browser. */
    contents?: Contents.IManager;
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
  onNewConversation,
  onAnswerQuestion,
  onCreate,
  onDiscard
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
  onAnswerQuestion: (
    id: string,
    answers: Record<string, string> | null
  ) => void;
  onCreate: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const model = panel.model;
  const [draft, setDraft] = React.useState('');
  const [dragging, setDragging] = React.useState(false);
  const end = React.useRef<HTMLDivElement>(null);
  const chooser = React.useRef<HTMLInputElement>(null);
  const ready = model.state === 'ready';
  const drafting = panel.draft !== '';
  const pending = panel.pending;

  // Keep the newest entry in view as the conversation grows.
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [model.items]);

  const submit = (): void => {
    const text = draft.trim();

    if ((!text && pending.length === 0) || model.running || !ready) {
      return;
    }

    onSend(text);
    setDraft('');
  };

  const attachFiles = (files: FileList | File[]): void => {
    void panel.attach(
      Array.from(files).map(file => ({ blob: file, name: file.name }))
    );
  };

  // Files on the clipboard are attached; long text is attached as a file
  // rather than put in the box; anything else is pasted as usual.
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files);

    if (files.length > 0) {
      event.preventDefault();
      attachFiles(files);

      return;
    }

    const text = event.clipboardData.getData('text/plain');

    if (isLongPaste(text)) {
      event.preventDefault();
      void panel.attachText(text);
    }
  };

  const drop = (event: React.DragEvent<HTMLDivElement>): void => {
    setDragging(false);

    if (event.dataTransfer.files.length > 0) {
      event.preventDefault();
      attachFiles(event.dataTransfer.files);
    }
  };

  const dragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    }
  };

  return (
    <div className="jp-WorkshopAgent-content">
      <div className="jp-WorkshopAgent-header">
        <div className="jp-WorkshopAgent-title">
          <h2>{AUTHOR_TITLE}</h2>
          <span className="jp-WorkshopAgent-path">
            {drafting ? 'New workshop, not created yet' : panel.path}
          </span>
        </div>
        <div className="jp-WorkshopAgent-headerActions">
          {status?.logged_in ? (
            <span className="jp-WorkshopAgent-account">
              {describeAccount(status)}
            </span>
          ) : null}
          {drafting ? (
            <button
              type="button"
              className="jp-WorkshopAgent-barButton"
              title="Forget this draft; nothing has been created"
              disabled={!ready || model.running}
              onClick={onDiscard}
            >
              Discard draft
            </button>
          ) : (
            <button
              type="button"
              className="jp-WorkshopAgent-barButton"
              title="Start the conversation over; the agent forgets what was said so far"
              disabled={!ready || model.running || model.items.length === 0}
              onClick={onNewConversation}
            >
              New conversation
            </button>
          )}
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
            {drafting
              ? 'Say what the workshop should teach and who it is for. ' +
                'Workshop Author asks about anything unclear and proposes a ' +
                'plan; nothing is created until you press Create.'
              : 'Say what the workshop should teach, or what to change in it.'}
          </p>
        ) : null}
        {model.items.map((item, index) => (
          <Entry
            key={index}
            item={item}
            workshop={panel.path}
            onAnswer={onAnswer}
            onAnswerQuestion={onAnswerQuestion}
            proposal={
              item.type === 'proposal'
                ? {
                    drafting,
                    latest: item.id === model.latestProposal,
                    canCreate: ready && !model.running,
                    onCreate
                  }
                : undefined
            }
          />
        ))}
        <div ref={end} />
      </div>
      <div
        className={`jp-WorkshopAgent-composer${dragging ? ' jp-mod-dropTarget' : ''}`}
        onDragOver={dragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        {pending.length > 0 ? (
          <ul className="jp-WorkshopAgent-attachments" aria-label="Attachments">
            {pending.map((attachment, index) => (
              <li
                key={`${index}-${attachment.name}`}
                className="jp-WorkshopAgent-attachment"
                title={`${attachment.name}, ${describeSize(attachment.size)}`}
              >
                {attachment.preview ? (
                  <img src={attachment.preview} alt="" />
                ) : null}
                <span className="jp-WorkshopAgent-attachmentName">
                  {attachment.name}
                </span>
                <span className="jp-WorkshopAgent-attachmentSize">
                  {describeSize(attachment.size)}
                </span>
                <button
                  type="button"
                  className="jp-WorkshopAgent-attachmentRemove"
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove"
                  onClick={() => panel.detach(index)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {panel.attachError ? (
          <p className="jp-WorkshopAgent-attachError">{panel.attachError}</p>
        ) : null}
        <textarea
          className="jp-WorkshopAgent-input"
          placeholder={
            ready
              ? 'Message Workshop Author (Enter to send, Shift+Enter for a new line, paste or drop files to attach)'
              : 'Waiting for the agent…'
          }
          rows={3}
          value={draft}
          disabled={!ready}
          onChange={event => setDraft(event.target.value)}
          onPaste={paste}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="jp-WorkshopAgent-bar">
          <div className="jp-WorkshopAgent-barControls">
            <input
              ref={chooser}
              type="file"
              multiple
              hidden
              aria-label="Files to attach"
              onChange={event => {
                if (event.target.files) {
                  attachFiles(event.target.files);
                }

                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="jp-WorkshopAgent-barButton"
              title="Attach images, PDFs or text files to the message; they can also be pasted or dropped into the box, or dragged from the file browser"
              disabled={!ready}
              onClick={() => chooser.current?.click()}
            >
              Attach
            </button>
            {drafting ? null : (
              <>
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
              </>
            )}
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
                disabled={!ready || (!draft.trim() && pending.length === 0)}
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
  onAnswer,
  onAnswerQuestion,
  proposal
}: {
  item: TranscriptItem;

  /** The workshop's path, which paths in tool calls are shown relative to. */
  workshop: string;
  onAnswer: (id: string, allow: boolean, remember: boolean) => void;
  onAnswerQuestion: (
    id: string,
    answers: Record<string, string> | null
  ) => void;

  /** For a proposed plan: where the conversation stands, and Create. */
  proposal?: IProposalState;
}): JSX.Element {
  switch (item.type) {
    case 'user':
      return (
        <div className="jp-WorkshopAgent-user">
          {item.text}
          {item.attachments.length > 0 ? (
            <ul className="jp-WorkshopAgent-attachments">
              {item.attachments.map((attachment: IAttachmentInfo, index) => (
                <li
                  key={`${index}-${attachment.name}`}
                  className="jp-WorkshopAgent-attachment"
                  title={attachment.type}
                >
                  <span className="jp-WorkshopAgent-attachmentName">
                    {attachment.name}
                  </span>
                  <span className="jp-WorkshopAgent-attachmentSize">
                    {describeSize(attachment.size)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );

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

    case 'proposal':
      return <ProposalCard item={item} state={proposal} />;

    case 'question':
      return (
        <QuestionCard
          item={item}
          onAnswer={answers => onAnswerQuestion(item.id, answers)}
        />
      );

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

/**
 * The agent's questions, each with its options to choose from, one or
 * several, and a box for an answer of the person's own.
 */
function QuestionCard({
  item,
  onAnswer
}: {
  item: Extract<TranscriptItem, { type: 'question' }>;
  onAnswer: (answers: Record<string, string> | null) => void;
}): JSX.Element {
  const [chosen, setChosen] = React.useState<Record<string, string[]>>({});
  const [other, setOther] = React.useState<Record<string, string>>({});

  // What each question is answered with: the options chosen, and the
  // person's own words where given.
  const answerFor = (question: IQuestion): string => {
    const own = (other[question.question] ?? '').trim();
    const picked = chosen[question.question] ?? [];

    if (!question.multiSelect) {
      return own || picked[0] || '';
    }

    return [...picked, ...(own ? [own] : [])].join(', ');
  };

  const answers = Object.fromEntries(
    item.questions.map(question => [question.question, answerFor(question)])
  );
  const complete = item.questions.every(question => answers[question.question]);

  const choose = (question: IQuestion, label: string): void => {
    const current = chosen[question.question] ?? [];
    const next = question.multiSelect
      ? current.includes(label)
        ? current.filter(item => item !== label)
        : [...current, label]
      : [label];

    setChosen({ ...chosen, [question.question]: next });

    if (!question.multiSelect) {
      setOther({ ...other, [question.question]: '' });
    }
  };

  // Once answered, or no longer waited on, the card shows how it ended.
  if (item.answers !== undefined || item.expired) {
    return (
      <div className="jp-WorkshopAgent-question">
        {item.questions.map(question => (
          <p key={question.question}>
            <strong>{question.question}</strong>{' '}
            {item.answers
              ? item.answers[question.question] || 'No answer.'
              : null}
          </p>
        ))}
        <p className="jp-WorkshopAgent-answer">
          {item.answers === null
            ? 'Not answered.'
            : item.answers
              ? 'Answered.'
              : 'No longer waiting.'}
        </p>
      </div>
    );
  }

  return (
    <div className="jp-WorkshopAgent-question">
      {item.questions.map(question => (
        <fieldset key={question.question}>
          <legend>
            {question.header ? (
              <span className="jp-WorkshopAgent-questionHeader">
                {question.header}
              </span>
            ) : null}
            {question.question}
          </legend>
          {question.options.map(option => (
            <label
              key={option.label}
              className="jp-WorkshopAgent-questionOption"
            >
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`${item.id}-${question.question}`}
                checked={(chosen[question.question] ?? []).includes(
                  option.label
                )}
                onChange={() => choose(question, option.label)}
              />
              <span>
                {option.label}
                {option.description ? (
                  <span className="jp-WorkshopAgent-questionDescription">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          <input
            type="text"
            className="jp-WorkshopAgent-questionOther"
            aria-label={`Other answer to: ${question.question}`}
            placeholder="Or answer in your own words"
            value={other[question.question] ?? ''}
            onChange={event => {
              setOther({ ...other, [question.question]: event.target.value });

              if (!question.multiSelect && event.target.value) {
                setChosen({ ...chosen, [question.question]: [] });
              }
            }}
          />
        </fieldset>
      ))}
      <div className="jp-WorkshopAgent-setupActions">
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={!complete}
          onClick={() => onAnswer(answers)}
        >
          Submit
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          title="Let the agent carry on without an answer"
          onClick={() => onAnswer(null)}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

/** Where a proposed plan stands, for its card. */
interface IProposalState {
  /** Whether the conversation is still a draft, with nothing created. */
  drafting: boolean;

  /** Whether this is the plan Create would make: the last one accepted. */
  latest: boolean;

  /** Whether Create may be pressed now. */
  canCreate: boolean;
  onCreate: () => void;
}

/** Who each audience a plan names is. */
const AUDIENCES: Record<string, string> = {
  newcomers: 'People new to the subject',
  experienced: 'Experienced practitioners',
  demonstration: 'A product demonstration or presentation'
};

/** A plan the agent proposed, with Create while drafting. */
function ProposalCard({
  item,
  state
}: {
  item: Extract<TranscriptItem, { type: 'proposal' }>;
  state?: IProposalState;
}): JSX.Element {
  const plan: IProposal = item.plan;
  const refused = item.result !== undefined && !item.result.ok;
  const checks = [
    plan.quizzes ? 'Quizzes' : 'No quizzes',
    plan.gating
      ? 'pages wait for their checks'
      : 'pages do not wait for their checks'
  ].join(', ');

  let footer: JSX.Element | null = null;

  if (refused) {
    footer = (
      <p className="jp-WorkshopAgent-error">
        Not accepted: {item.result?.summary}
      </p>
    );
  } else if (item.result === undefined) {
    footer = null;
  } else if (!state?.latest) {
    footer = (
      <p className="jp-WorkshopAgent-answer">Replaced by a later plan.</p>
    );
  } else if (state.drafting) {
    footer = (
      <div className="jp-WorkshopAgent-setupActions">
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={!state.canCreate}
          onClick={state.onCreate}
        >
          Create
        </button>
        <span className="jp-WorkshopAgent-answer">
          Or reply with what to change.
        </span>
      </div>
    );
  } else {
    footer = <p className="jp-WorkshopAgent-answer">The plan agreed.</p>;
  }

  return (
    <div
      className={`jp-WorkshopAgent-proposal${refused ? ' jp-mod-failed' : ''}`}
    >
      <h3>{plan.title}</h3>
      <dl>
        <dt>Directory</dt>
        <dd>
          <code>personal/{plan.name}</code>
        </dd>
        <dt>For</dt>
        <dd>{AUDIENCES[plan.audience] ?? plan.audience}</dd>
        <dt>Checks</dt>
        <dd>{checks}</dd>
      </dl>
      <p className="jp-WorkshopAgent-proposalSummary">{plan.summary}</p>
      <ol className="jp-WorkshopAgent-proposalOutline">
        {plan.outline.map((page, index) => (
          <li key={index}>{page}</li>
        ))}
      </ol>
      {footer}
    </div>
  );
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

/** A file from the contents API as a blob, typed as the server says. */
function blobOf(model: Contents.IModel): Blob {
  const type = model.mimetype ?? '';

  if (model.format === 'base64') {
    const bytes = Uint8Array.from(atob(String(model.content)), character =>
      character.charCodeAt(0)
    );

    return new Blob([bytes], { type });
  }

  if (model.format === 'json') {
    return new Blob([JSON.stringify(model.content, null, 1)], {
      type: type || 'application/json'
    });
  }

  return new Blob([String(model.content ?? '')], { type });
}

function lastSegment(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
