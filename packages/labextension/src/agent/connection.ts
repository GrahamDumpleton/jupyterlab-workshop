import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { ISignal, Signal } from '@lumino/signaling';

import { API_NAMESPACE } from '../request';
import { IAttachment } from './attachments';

/** One thing that happened in a conversation, as the server reports it. */
export interface IAgentEvent {
  /**
   * What it is: `user` for a message sent, `text-delta` and `text` for
   * the reply streaming in and complete, `tool-call` and `tool-result`,
   * `permission` for a request to be answered, `compacting` and
   * `compacted` around a summary of the conversation taking its place,
   * `error`, and `done` at the end of a turn.
   */
  kind: string;

  [key: string]: unknown;
}

/** A model the conversation can be switched to. */
export interface IModelChoice {
  value: string;
  name: string;
  description: string;

  /** The effort levels it takes; empty when it takes none. */
  efforts: string[];
}

/** What a conversation runs on, for the status bar. */
export interface IAgentInfo {
  /** The model asked for; empty for the agent's default. */
  model: string;

  /** The model actually answering, when known. */
  resolved?: string;

  /** The effort asked for; empty for the default. */
  effort: string;

  models: IModelChoice[];

  /** Tokens in the context window, and its size, when known. */
  context_used?: number | null;
  context_limit?: number | null;

  /** What the conversation has cost so far, where the agent says. */
  cost?: number;
}

/** What a conversation is about: one workshop, or a whole course. */
export type ConversationKind = 'workshop' | 'course';

/** A message from the server about the conversation. */
export type IAgentMessage =
  | { type: 'starting' }
  | {
      type: 'opened';
      path: string;

      /** The draft's id, for a workshop or course not created yet; empty otherwise. */
      draft?: string;

      /** Whether the conversation is about a workshop or a course. */
      kind?: ConversationKind;
      provider: string;
      session_id: string | null;
      running: boolean;
      history: IAgentEvent[];
      info?: IAgentInfo;
    }
  | { type: 'info'; info: IAgentInfo }
  | { type: 'event'; event: IAgentEvent }
  | { type: 'state'; running: boolean }
  | { type: 'cleared' }
  | { type: 'created'; path: string; kind?: ConversationKind }
  | {
      /**
       * The workshop was promoted into a course, whose conversation
       * carries on at `path`, with the workshop at `inside` within it.
       */
      type: 'moved';
      path: string;
      kind?: ConversationKind;
      inside?: string;
    }
  | { type: 'terminal'; cwd: string; command: string | null }
  | { type: 'error'; message: string }
  | { type: 'closed' };

/** How long to wait before reconnecting a socket that dropped. */
const RECONNECT_DELAY = 2000;

/**
 * The websocket carrying one workshop's conversation. It opens the
 * conversation on connecting, and again after a dropped connection, so
 * the server sends what happened so far each time.
 */
export class AgentConnection {
  constructor(options: AgentConnection.IOptions) {
    this._settings = options.serverSettings;
    this._open = options.open;
  }

  /** Emitted for every message from the server. */
  get message(): ISignal<this, IAgentMessage> {
    return this._message;
  }

  /** Whether the socket is connected. */
  get connected(): boolean {
    return this._socket?.readyState === WebSocket.OPEN;
  }

  /** Connect, if not connected already. */
  connect(): void {
    if (this._disposed || this._socket) {
      return;
    }

    let url = URLExt.join(
      this._settings.wsUrl,
      API_NAMESPACE,
      'agent',
      'conversation'
    );

    if (this._settings.token) {
      url += `?token=${encodeURIComponent(this._settings.token)}`;
    }

    const socket = new this._settings.WebSocket(url);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'open', ...this._open() }));
    };

    socket.onmessage = event => {
      try {
        this._message.emit(JSON.parse(String(event.data)) as IAgentMessage);
      } catch (error) {
        console.warn('Unreadable message from Workshop Author', error);
      }
    };

    socket.onclose = () => {
      this._socket = null;

      // The conversation lives in the server, so a dropped connection is
      // picked up again where it was.
      if (!this._disposed) {
        this._retry = window.setTimeout(() => this.connect(), RECONNECT_DELAY);
      }
    };

    this._socket = socket;
  }

  /** Send a message to the agent, with any files attached. */
  send(text: string, attachments: IAttachment[] = []): void {
    this._write({ type: 'send', text, attachments });
  }

  /** Answer a permission request. */
  answer(id: string, allow: boolean, remember = false): void {
    this._write({ type: 'permission', id, allow, remember });
  }

  /** Answer the agent's questions, by question text; null declines. */
  answerQuestion(id: string, answers: Record<string, string> | null): void {
    this._write({ type: 'answer', id, answers });
  }

  /** Stop the turn in progress. */
  interrupt(): void {
    this._write({ type: 'interrupt' });
  }

  /** Change the model or the effort, between turns. */
  configure(model: string, effort: string): void {
    this._write({ type: 'configure', model, effort });
  }

  /** Summarize the conversation so far, to free the context window. */
  compact(): void {
    this._write({ type: 'compact' });
  }

  /** Start the conversation over, forgetting what was said. */
  clear(): void {
    this._write({ type: 'clear' });
  }

  /** Create the workshop a draft agreed on. */
  create(): void {
    this._write({ type: 'create' });
  }

  /** End a draft and forget it. */
  discard(): void {
    this._write({ type: 'discard' });
  }

  /** Ask for the command that carries the conversation on in a terminal. */
  requestTerminal(): void {
    this._write({ type: 'terminal' });
  }

  /** Close the socket for good. The conversation carries on in the server. */
  dispose(): void {
    this._disposed = true;
    window.clearTimeout(this._retry);
    this._socket?.close();
    this._socket = null;
    Signal.clearData(this);
  }

  private _write(message: Record<string, unknown>): void {
    if (this._socket?.readyState !== WebSocket.OPEN) {
      this._message.emit({
        type: 'error',
        message: 'Not connected to the server; trying again.'
      });

      return;
    }

    this._socket.send(JSON.stringify(message));
  }

  private _settings: ServerConnection.ISettings;
  private _open: () => Record<string, unknown>;
  private _socket: WebSocket | null = null;
  private _disposed = false;
  private _retry = 0;
  private _message = new Signal<this, IAgentMessage>(this);
}

export namespace AgentConnection {
  export interface IOptions {
    serverSettings: ServerConnection.ISettings;

    /**
     * What the conversation is opened with each time the socket connects:
     * the workshop path, the workshops directory, the browser tab's id
     * and the model.
     */
    open: () => Record<string, unknown>;
  }
}
