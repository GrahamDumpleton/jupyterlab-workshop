import { ISignal, Signal } from '@lumino/signaling';

import { IAgentEvent, IAgentInfo, IAgentMessage } from './connection';

/** The workshop the agent proposes while drafting. */
export interface IProposal {
  title: string;
  name: string;
  audience: string;
  summary: string;
  outline: string[];
  quizzes: boolean;
  gating: boolean;
}

/** One of the agent's questions, with the options to choose from. */
export interface IQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** The tool the agent asks the person questions with. */
export const QUESTION_TOOL = 'AskUserQuestion';

/** The tool a drafting agent proposes a workshop with. */
export const PROPOSE_TOOL = 'mcp__workshop__propose_workshop';

/** A file that was attached to a message, as the history keeps it. */
export interface IAttachmentInfo {
  name: string;
  type: string;
  size: number;
}

/** One entry of the conversation as the panel shows it. */
export type TranscriptItem =
  | { type: 'user'; text: string; attachments: IAttachmentInfo[] }
  | { type: 'assistant'; text: string; streaming: boolean }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: { ok: boolean; summary: string };
    }
  | {
      type: 'permission';
      id: string;
      tool: string;
      input: Record<string, unknown>;
      reason: string;

      /** Whether Always allow is offered for it. */
      rememberable: boolean;
      answer?: 'allowed' | 'denied' | 'expired';
    }
  | { type: 'error'; message: string }
  | { type: 'note'; text: string }
  | {
      type: 'question';
      id: string;
      questions: IQuestion[];

      /** The answers given, by question; null when declined. */
      answers?: Record<string, string> | null;

      /** Whether the agent stopped waiting before an answer was given. */
      expired?: boolean;
    }
  | {
      type: 'proposal';
      id: string;
      plan: IProposal;

      /** Whether the server accepted the plan, and why not if it did not. */
      result?: { ok: boolean; summary: string };
    }
  | {
      type: 'compacted';

      /** Whether the agent compacted on its own, as the context filled. */
      automatic: boolean;
      tokensBefore: number | null;
      tokensAfter: number | null;
    };

/** Where the panel's connection to the agent stands. */
export type ConnectionState = 'connecting' | 'starting' | 'ready' | 'failed';

/**
 * The conversation as the panel shows it, built from what the server
 * reports. Opening the conversation again, after a reload or a dropped
 * connection, replays its history, so the transcript is rebuilt from
 * scratch each time.
 */
export class ConversationModel {
  /** Emitted whenever anything shown changes. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /** The conversation so far. */
  get items(): readonly TranscriptItem[] {
    return this._items;
  }

  /** Whether the agent is working on a message. */
  get running(): boolean {
    return this._running;
  }

  /** Whether the agent is summarizing the conversation. */
  get compacting(): boolean {
    return this._compacting;
  }

  /** Where the connection stands. */
  get state(): ConnectionState {
    return this._state;
  }

  /** Why the conversation could not be opened, when it could not. */
  get failure(): string {
    return this._failure;
  }

  /** What the conversation runs on, once known. */
  get info(): IAgentInfo | null {
    return this._info;
  }

  /** The id the conversation resumes by, once there is one. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** The id of the plan Create would make: the last one accepted. */
  get latestProposal(): string | null {
    for (let index = this._items.length - 1; index >= 0; index--) {
      const item = this._items[index];

      if (item.type === 'proposal' && item.result?.ok) {
        return item.id;
      }
    }

    return null;
  }

  /** Take in one message from the server. */
  handle(message: IAgentMessage): void {
    switch (message.type) {
      case 'starting':
        this._state = 'starting';
        break;

      case 'opened':
        this._state = 'ready';
        this._failure = '';
        this._sessionId = message.session_id;
        this._running = message.running;
        this._info = message.info ?? this._info;
        this._items = [];
        this._compacting = false;

        for (const event of message.history) {
          this._apply(event);
        }

        // A replayed request nobody answered is no longer waited on.
        if (!message.running) {
          this._expirePermissions();
        }
        break;

      case 'event':
        this._apply(message.event);
        break;

      case 'state':
        this._running = message.running;

        if (!message.running) {
          this._compacting = false;
        }
        break;

      case 'cleared':
        this._items = [];
        this._sessionId = null;
        this._compacting = false;
        break;

      case 'info':
        this._info = message.info;
        break;

      case 'error':
        // An error before the conversation opened is why it did not.
        if (this._state !== 'ready') {
          this._state = 'failed';
          this._failure = message.message;
        } else {
          this._items = [
            ...this._items,
            { type: 'error', message: message.message }
          ];
        }
        break;

      default:
        return;
    }

    this._changed.emit();
  }

  /** Record the person's answers to the agent's questions. */
  answeredQuestion(id: string, answers: Record<string, string> | null): void {
    this._items = this._items.map(item =>
      item.type === 'question' && item.id === id ? { ...item, answers } : item
    );
    this._changed.emit();
  }

  /** Record the person's answer to a permission request. */
  answered(id: string, allow: boolean): void {
    this._items = this._items.map(item =>
      item.type === 'permission' && item.id === id
        ? { ...item, answer: allow ? 'allowed' : 'denied' }
        : item
    );
    this._changed.emit();
  }

  /** Mark the connection as being made again. */
  reconnecting(): void {
    if (this._state === 'ready') {
      this._state = 'connecting';
      this._changed.emit();
    }
  }

  private _apply(event: IAgentEvent): void {
    const last = this._items[this._items.length - 1];

    switch (event.kind) {
      case 'user':
        this._push({
          type: 'user',
          text: String(event.text ?? ''),
          attachments: Array.isArray(event.attachments)
            ? event.attachments.filter(isRecord).map(toAttachmentInfo)
            : []
        });
        break;

      case 'text-delta':
        if (last?.type === 'assistant' && last.streaming) {
          this._replaceLast({
            ...last,
            text: last.text + String(event.text ?? '')
          });
        } else {
          this._push({
            type: 'assistant',
            text: String(event.text ?? ''),
            streaming: true
          });
        }
        break;

      case 'text':
        // The complete block takes the place of the pieces it streamed in.
        if (last?.type === 'assistant' && last.streaming) {
          this._replaceLast({
            type: 'assistant',
            text: String(event.text ?? ''),
            streaming: false
          });
        } else {
          this._push({
            type: 'assistant',
            text: String(event.text ?? ''),
            streaming: false
          });
        }
        break;

      case 'tool-call':
        // The agent's questions are shown by their own card, from the
        // question event, so the call itself is not shown again.
        if (event.name === QUESTION_TOOL) {
          break;
        }

        // A proposed plan is shown as a card to create from, not as a
        // tool row.
        if (event.name === PROPOSE_TOOL) {
          this._push({
            type: 'proposal',
            id: String(event.id ?? ''),
            plan: toProposal(event.input)
          });
          break;
        }

        this._push({
          type: 'tool',
          id: String(event.id ?? ''),
          name: String(event.name ?? ''),
          input: isRecord(event.input) ? event.input : {}
        });
        break;

      case 'tool-result':
        this._items = this._items.map(item =>
          (item.type === 'tool' || item.type === 'proposal') &&
          item.id === event.id
            ? {
                ...item,
                result: {
                  ok: event.ok === true,
                  summary: String(event.summary ?? '')
                }
              }
            : item
        );
        break;

      case 'permission':
        this._push({
          type: 'permission',
          id: String(event.id ?? ''),
          tool: String(event.tool ?? ''),
          input: isRecord(event.input) ? event.input : {},
          reason: String(event.reason ?? ''),
          rememberable: event.rememberable !== false
        });
        break;

      case 'error':
        this._push({ type: 'error', message: String(event.message ?? '') });
        break;

      case 'question':
        this._push({
          type: 'question',
          id: String(event.id ?? ''),
          questions: Array.isArray(event.questions)
            ? event.questions.map(toQuestion)
            : []
        });
        break;

      // The agent stopped waiting for an answer, so the request no longer
      // offers one.
      case 'permission-withdrawn':
        this._items = this._items.map(item =>
          item.type === 'permission' &&
          item.id === event.id &&
          item.answer === undefined
            ? { ...item, answer: 'expired' }
            : item.type === 'question' &&
                item.id === event.id &&
                item.answers === undefined
              ? { ...item, expired: true }
              : item
        );
        break;

      case 'compacting':
        this._compacting = true;
        break;

      case 'compacted':
        this._compacting = false;
        this._push({
          type: 'compacted',
          automatic: event.trigger === 'auto',
          tokensBefore: optionalNumber(event.tokens_before),
          tokensAfter: optionalNumber(event.tokens_after)
        });
        break;

      case 'done':
        this._compacting = false;
        this._sessionId = (event.session_id as string | null) ?? null;
        this._items = this._items.map(item =>
          item.type === 'assistant' && item.streaming
            ? { ...item, streaming: false }
            : item
        );
        this._expirePermissions();

        if (event.interrupted === true) {
          this._push({ type: 'note', text: 'Stopped.' });
        }
        break;
    }
  }

  private _expirePermissions(): void {
    this._items = this._items.map(item =>
      item.type === 'permission' && item.answer === undefined
        ? { ...item, answer: 'expired' }
        : item.type === 'question' && item.answers === undefined
          ? { ...item, expired: true }
          : item
    );
  }

  private _push(item: TranscriptItem): void {
    this._items = [...this._items, item];
  }

  private _replaceLast(item: TranscriptItem): void {
    this._items = [...this._items.slice(0, -1), item];
  }

  private _items: TranscriptItem[] = [];
  private _running = false;
  private _compacting = false;
  private _state: ConnectionState = 'connecting';
  private _failure = '';
  private _sessionId: string | null = null;
  private _info: IAgentInfo | null = null;
  private _changed = new Signal<this, void>(this);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toProposal(value: unknown): IProposal {
  const input = isRecord(value) ? value : {};

  return {
    title: String(input.title ?? ''),
    name: String(input.name ?? ''),
    audience: String(input.audience ?? ''),
    summary: String(input.summary ?? ''),
    outline: Array.isArray(input.outline) ? input.outline.map(String) : [],
    quizzes: input.quizzes === true,
    gating: input.gating === true
  };
}

function toAttachmentInfo(value: Record<string, unknown>): IAttachmentInfo {
  return {
    name: String(value.name ?? ''),
    type: String(value.type ?? ''),
    size: typeof value.size === 'number' ? value.size : 0
  };
}

function toQuestion(value: unknown): IQuestion {
  const input = isRecord(value) ? value : {};
  const options = Array.isArray(input.options) ? input.options : [];

  return {
    question: String(input.question ?? ''),
    header: String(input.header ?? ''),
    multiSelect: input.multiSelect === true,
    options: options.filter(isRecord).map(option => ({
      label: String(option.label ?? ''),
      description: String(option.description ?? '')
    }))
  };
}
