import { IPage, IWorkshopManifest, Variables } from '@educates/workshop-core';
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
  pages: IPage[];
}

/** Loads workshops and tracks the current page. */
export interface IWorkshopManager {
  /** Emitted whenever the loaded workshop, current page or error changes. */
  readonly changed: ISignal<IWorkshopManager, void>;

  readonly workshop: ILoadedWorkshop | null;
  readonly pageIndex: number;
  readonly currentPage: IPage | null;
  readonly variables: Variables;
  readonly platform: IPlatformInfo | null;

  /** Message describing why the last open failed, if it did. */
  readonly error: string | null;

  /** Open the workshop in a directory relative to the JupyterLab root. */
  open(path: string): Promise<void>;

  /** Close the current workshop. */
  close(): Promise<void>;

  goTo(index: number): void;
  next(): void;
  previous(): void;

  /**
   * Resolve a path relative to the workshop directory to a path relative
   * to the JupyterLab root, refusing paths that escape the workshop.
   */
  resolvePath(path: string): string;
}

export const IWorkshopManager = new Token<IWorkshopManager>(
  '@educates/jupyterlab-workshop:IWorkshopManager',
  'Loads workshops and tracks the current page.'
);

/** A request to run one action. */
export interface IActionRequest {
  type: string;
  id: string;
  options: Record<string, string>;
  body: string;
}

/** The outcome of running an action. */
export interface IActionResult {
  status: 'ok' | 'error';
  message?: string;
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

/** Ids of the commands the extension registers. */
export namespace CommandIDs {
  export const open = 'workshop:open';
  export const close = 'workshop:close';
  export const nextPage = 'workshop:next-page';
  export const previousPage = 'workshop:previous-page';
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
