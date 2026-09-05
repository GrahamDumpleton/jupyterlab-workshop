import {
  IDirectiveNode,
  IPage,
  IVariableDefinition,
  IWorkshopManifest,
  Variables
} from '@educates/workshop-core';
import { Token } from '@lumino/coreutils';
import { ISignal } from '@lumino/signaling';

/** What the server reports about the platform it runs on. */
export interface IPlatformInfo {
  os: string;
  shell: string;
  home: string;
  user: string;
  path_sep: string;
  root_dir: string;
}

/** A workshop that has been read and parsed. */
export interface ILoadedWorkshop {
  /** Directory of the workshop relative to the JupyterLab root. */
  path: string;

  manifest: IWorkshopManifest;

  /** Page sources keyed by page path, kept so pages can be re-rendered. */
  sources: Record<string, string>;

  /** Every page, in manifest order, rendered with the current variables. */
  pages: IPage[];
}

/** Where a variable value came from, lowest precedence first. */
export type VariableSource =
  'builtin' | 'manifest' | 'override' | 'form' | 'capture' | 'manual';

/** A variable with its effective value and metadata. */
export interface IVariableEntry {
  name: string;
  value: string;
  source: VariableSource;
  definition: IVariableDefinition | null;
  secret: boolean;
  readonly: boolean;
}

/** Ordered store of workshop variables. */
export interface IVariableStore {
  /** Emitted after any value changes. */
  readonly changed: ISignal<IVariableStore, void>;

  /** Effective values keyed by name. */
  readonly values: Variables;

  entries(): IVariableEntry[];
  get(name: string): string | undefined;
  has(name: string): boolean;

  /** Set a value from a source; higher precedence sources win. */
  set(name: string, value: string, source?: VariableSource): void;

  /** Remove learner-provided values so the declared default applies. */
  reset(name: string): void;
}

/** A request to run one action. */
export interface IActionRequest {
  type: string;
  id: string;
  argument: string;
  options: Record<string, string>;
  body: string;

  /** Id of the page the action is on, when it comes from a page. */
  page?: string;
}

/** The outcome of running an action. */
export interface IActionResult {
  status: 'ok' | 'error' | 'skipped';
  message?: string;

  /** Variables captured by the action, stored with the `capture` source. */
  captured?: Record<string, string>;
}

/** Implementation of one action type against JupyterLab. */
export interface IActionImplementation {
  readonly type: string;

  /** Short human-readable summary of what the request will do. */
  describe(request: IActionRequest): string;

  run(request: IActionRequest): Promise<IActionResult>;
}

/** Registry of action implementations keyed by action type. */
export interface IActionRegistry {
  register(implementation: IActionImplementation): void;
  has(type: string): boolean;
  describe(request: IActionRequest): string;
  run(request: IActionRequest): Promise<IActionResult>;
}

export const IActionRegistry = new Token<IActionRegistry>(
  '@educates/jupyterlab-workshop:IActionRegistry',
  'Registry of workshop action implementations.'
);

/** How an action came to run. */
export type ActionTrigger = 'click' | 'cascade' | 'auto' | 'role' | 'layout';

/** Recorded run state of an action. */
export interface IActionStatus {
  status: 'idle' | 'running' | 'ok' | 'error' | 'skipped';
  message?: string;
  runs: number;
}

/** One line of the action log. */
export interface IActionLogEntry {
  time: string;
  page: string;
  id: string;
  type: string;
  text: string;
  status: 'ok' | 'error' | 'skipped';
  message?: string;
  trigger: ActionTrigger;
}

/** Progress recorded for one page. */
export interface IPageProgress {
  done: boolean;
  enteredAt?: string;
}

/** Loads workshops, tracks progress and runs actions. */
export interface IWorkshopManager {
  /** Emitted whenever the workshop, page, variables, error or progress change. */
  readonly changed: ISignal<IWorkshopManager, void>;

  /** Emitted with an action id when its status changes. */
  readonly actionChanged: ISignal<IWorkshopManager, string>;

  /** Emitted with an action id when an automatic run is about to start. */
  readonly actionFocused: ISignal<IWorkshopManager, string>;

  /** Emitted after the environment files have been rewritten. */
  readonly environmentChanged: ISignal<IWorkshopManager, void>;

  readonly workshop: ILoadedWorkshop | null;
  readonly variables: IVariableStore;
  readonly platform: IPlatformInfo | null;

  /** Message describing why the last open failed, if it did. */
  readonly error: string | null;

  /** Pages whose `when` condition holds, in order. */
  readonly visiblePages: IPage[];

  /** Index of the current page within `visiblePages`. */
  readonly pageIndex: number;
  readonly currentPage: IPage | null;

  /** Whether a cascade or auto-run chain is in progress. */
  readonly chainRunning: boolean;

  readonly log: readonly IActionLogEntry[];

  /** The registry actions run through; set by the actions plugin. */
  registry: IActionRegistry | null;

  /** Open the workshop in a directory relative to the JupyterLab root. */
  open(path: string): Promise<void>;

  /** Close the current workshop. */
  close(): Promise<void>;

  goTo(index: number): void;
  goToPage(id: string): void;
  next(): void;
  previous(): void;

  pageProgress(id: string): IPageProgress;
  markDone(id?: string, done?: boolean): void;

  actionStatus(id: string): IActionStatus;

  /** Run an action from a page, recording its result and following cascades. */
  runAction(
    node: IDirectiveNode,
    trigger: ActionTrigger,
    argument?: string
  ): Promise<IActionResult>;

  /** Run an ad hoc request, such as from an inline role, recording it. */
  runRequest(
    request: IActionRequest,
    trigger: ActionTrigger
  ): Promise<IActionResult>;

  /** Cancel any pending cascade or auto-run. */
  stopChain(): void;

  /** Evaluate a `when` condition against the current variables. */
  evaluate(condition: string): boolean;

  /**
   * Resolve a path relative to the workshop directory to a path relative
   * to the JupyterLab root, refusing paths that escape the workshop.
   */
  resolvePath(path: string): string;

  /** Absolute path of the workshop directory on the server, when known. */
  absolutePath(path?: string): string;
}

export const IWorkshopManager = new Token<IWorkshopManager>(
  '@educates/jupyterlab-workshop:IWorkshopManager',
  'Loads workshops and tracks the current page.'
);

/** Ids of the commands the extension registers. */
export namespace CommandIDs {
  export const open = 'workshop:open';
  export const close = 'workshop:close';
  export const nextPage = 'workshop:next-page';
  export const previousPage = 'workshop:previous-page';
  export const markDone = 'workshop:mark-done';
  export const variables = 'workshop:variables';
  export const showLog = 'workshop:show-log';
  export const stopChain = 'workshop:stop-chain';
}

/**
 * Return a readable message for a thrown value.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
