import {
  ActionDisposition,
  Capability,
  GatingPolicy,
  IDirectiveNode,
  ILintMessage,
  IPage,
  IVenvExports,
  ICatalog,
  ICollectionIndex,
  IRequirement,
  IVariableDefinition,
  IWorkshopManifest,
  TrustLevel,
  Variables
} from '@jupyterlab-workshop/core';
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

  /** The JupyterHub user name when running under a hub, else empty. */
  hub_user: string;

  /** The service hosting the session: binder, jupyterhub, local or lite. */
  host: string;

  /** Whether the server runs inside a container. */
  container: boolean;
}

/** Where a workshop came from. */
export interface IWorkshopSource {
  /** `local` for a directory used in place, else `git` or `archive`. */
  kind: 'local' | 'git' | 'archive';

  /** Repository or archive URL, or the directory for local workshops. */
  url: string;

  ref?: string;
  subdir?: string;
}

/** A capability as shown in the trust dialog. */
export interface ICapabilitySummary {
  capability: Capability;
  scopes: string[];

  /** Number of actions in the pages needing the capability. */
  count: number;

  /** Whether the manifest declares it. */
  declared: boolean;
}

/** What a learner is asked to trust. */
export interface ITrustSummary {
  name: string;
  title: string;
  version: string;
  source: IWorkshopSource;

  /** Stable key identifying the source for stored decisions. */
  sourceKey: string;

  /** Content hash (local) or archive hash (downloaded). */
  hash: string;

  capabilities: ICapabilitySummary[];

  /** Number of actions that run without a click. */
  automatic: number;

  /** The workspace, which the write-files workspace scope confines writes to. */
  workspace?: string;

  lint: ILintMessage[];

  /** URL the workshop asks to report progress to, if any. */
  analyticsSink?: string;
}

/** What the learner chose in the trust dialog. */
export interface ITrustChoice {
  level: TrustLevel;

  /** Whether progress may be reported to the workshop's analytics sink. */
  analytics: boolean;
}

/** A stored decision about a workshop at a particular hash. */
export interface ITrustDecision {
  level: TrustLevel;

  /** Capabilities allowed without asking again under the `ask` level. */
  allowed: string[];

  /** Whether the learner opted in to the workshop's analytics sink. */
  analytics?: boolean;

  decidedAt: string;
  sourceKey: string;
  hash: string;
  name: string;
}

/** Administrator policy from the settings. */
export interface ITrustPolicy {
  /** Level selected by default in the trust dialog. */
  defaultLevel: TrustLevel;

  /** Level applied to every workshop without asking, when set. */
  forcedLevel: TrustLevel | null;

  /** Source key prefixes that are trusted without asking. */
  trustedSources: string[];

  /** Capabilities that never run regardless of trust. */
  disabledCapabilities: string[];

  /** Sink every workshop's events are reported to, when set by an administrator. */
  analyticsSink: string;

  /** Whether events carry the JupyterHub user name. */
  analyticsIdentity: 'none' | 'hub';
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

  source: IWorkshopSource;

  /** What the learner was asked to trust. */
  trust: ITrustSummary;

  /** Whether the workshop was opened from a launch link. */
  launched: boolean;
}

/** Answer to a confirmation prompt. */
export type ConfirmAnswer = 'yes' | 'always' | 'no';

/** What a confirmation prompt shows. */
export interface IConfirmRequest {
  /** What the action will do, from `describe()`. */
  description: string;

  /** Why confirmation is needed. */
  reason: string;

  capability: Capability;

  /** Code, command or diff to show, when there is something to show. */
  detail: string;

  /** Whether to offer allowing the capability for the whole workshop. */
  offerAlways: boolean;
}

/** User interface hooks the manager needs for trust decisions. */
export interface ITrustPrompts {
  /** Ask which level to apply; null means do not open the workshop. */
  decide(
    summary: ITrustSummary,
    defaultLevel: TrustLevel
  ): Promise<ITrustChoice | null>;

  /** Ask whether one action may run. */
  confirm(request: IConfirmRequest): Promise<ConfirmAnswer>;
}

/** Persists trust decisions and exposes the administrator policy. */
export interface ITrustStore {
  readonly policy: ITrustPolicy;

  get(sourceKey: string, hash: string): Promise<ITrustDecision | null>;
  set(decision: ITrustDecision): Promise<void>;

  /** Forget every decision for a source, including that it is authored. */
  forget(sourceKey: string): Promise<void>;

  /** Whether a source is the learner's own work, trusted at any hash. */
  isAuthored(sourceKey: string): Promise<boolean>;

  /** Mark a source as the learner's own work, or stop treating it so. */
  setAuthored(sourceKey: string, authored: boolean): Promise<void>;
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

/** A setting an action changed, kept so it can be put back. */
export interface ISettingChange {
  plugin: string;
  key: string;

  /** The user value before the change; undefined when there was none. */
  previous?: unknown;
}

/** The outcome of running an action. */
export interface IActionResult {
  status: 'ok' | 'error' | 'skipped';
  message?: string;

  /** Variables captured by the action, stored with the `capture` source. */
  captured?: Record<string, string>;

  /** Source to store captured variables under; `capture` by default. */
  captureSource?: VariableSource;

  /** A setting the action changed, recorded for uninstall. */
  setting?: ISettingChange;
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
  '@jupyterlab-workshop/labextension:IActionRegistry',
  'Registry of workshop action implementations.'
);

/** How an action came to run; `trigger` is a verify re-run by an event. */
export type ActionTrigger =
  'click' | 'cascade' | 'auto' | 'role' | 'layout' | 'trigger';

/** Choices about one run of an action beyond how it was started. */
export interface IRunOptions {
  /**
   * Give a failing verify the time to settle that a trigger would, trying
   * it again over the next few seconds before the failure stands. The
   * self-test uses this for verifies that declare a trigger, so the run
   * matches what a learner sees.
   */
  settle?: boolean;
}

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

  /** Requirements that were unmet when the learner moved on anyway. */
  skipped?: string[];
}

/** Whether the learner may leave a page. */
export interface IGateStatus {
  policy: GatingPolicy;

  /** Requirements of the page not yet satisfied. */
  unmet: IRequirement[];

  /** Whether moving forward is blocked outright. */
  blocked: boolean;
}

/** What the preflight found about one required tool. */
export interface IPreflightResult {
  name: string;
  found: boolean;
  path?: string;
  version?: string;

  /** Whether the version requirement, if any, is satisfied. */
  satisfied: boolean;
  requirement?: string;
  optional: boolean;

  /** Installation hint for the platform, from the manifest. */
  hint?: string;
}

/** A progress event, as recorded in `_workshop/events.jsonl`. */
export interface IWorkshopEvent {
  kind: string;

  /** ISO time stamp. */
  ts: string;

  /** Random id of this open of the workshop. */
  session_id: string;
  workshop: string;
  version: string;
  platform: string;
  trust: string;

  /** Event specific fields. */
  [field: string]: unknown;
}

/** What the server reports about a workshop's isolated environment. */
export interface IEnvironmentStatus {
  kernel: string;
  ready: boolean;
  registered: boolean;
  python: string;

  /** The venv directory and its programs directory; empty until ready. */
  venv: string;
  bin: string;
  requirements: string;

  /** Whether the requirements changed since the environment was created. */
  stale: boolean;
  createdAt: string;
  log: string;

  /** Set by the manager while the environment is being created. */
  creating?: boolean;
  error?: string;
}

/** A workshop directory under the workshops directory. */
export interface IInstalledWorkshop {
  path: string;
  name: string;
  title: string;
  version: string;
  description: string;
  tags: string[];
  platforms: string[];
  source: IWorkshopSource | null;
  sha256: string;

  /** Location of the collection it was installed from, or null. */
  collection: string | null;

  /** Number of pages, and how many are marked done. */
  pages: number;
  done: number;
  currentPage: string;
  trust: string;

  /** Whether a state file exists, that is, the learner has opened it. */
  started: boolean;
}

/** Features an administrator can remove for a locked-down deployment. */
export const FEATURES = [
  'open-directory',
  'open-url',
  'collections',
  'catalogs',
  'available',
  'install-all',
  'remove',
  'close',
  'browse',
  'author'
] as const;

/** One of the removable features. */
export type Feature = (typeof FEATURES)[number];

/**
 * Which features the settings leave enabled. Loaded before the plugins
 * that depend on it activate, so the answers are available synchronously.
 */
export interface IFeaturePolicy {
  /** Emitted when the settings change which features are disabled. */
  readonly changed: ISignal<IFeaturePolicy, void>;

  /** The features currently disabled. */
  readonly disabled: readonly Feature[];

  /** Whether a feature is enabled. */
  enabled(feature: Feature): boolean;
}

/** Token for the feature policy. */
export const IFeaturePolicy = new Token<IFeaturePolicy>(
  '@jupyterlab-workshop/labextension:IFeaturePolicy',
  'Which parts of the workshop extension the settings disable.'
);

/** Options for opening a workshop. */
export interface IOpenOptions {
  /** Values applied over the manifest defaults, as a launch link provides. */
  variables?: Record<string, string>;

  /**
   * Whether the open comes from a launch link or a restart, which apply
   * the workshop layout even when it has been applied in this workspace
   * before.
   */
  launch?: boolean;
}

/** Loads workshops, tracks progress and runs actions. */
export interface IWorkshopManager {
  /** Emitted whenever the workshop, page, variables, error or progress change. */
  readonly changed: ISignal<IWorkshopManager, void>;

  /** Emitted for every progress event, for analytics. */
  readonly events: ISignal<IWorkshopManager, IWorkshopEvent>;

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

  /** Trust level of the open workshop. */
  readonly trust: TrustLevel | null;

  /** Results of checking the tools the manifest requires, once known. */
  readonly preflight: IPreflightResult[] | null;

  /** Names of the checkpoints taken in this workshop. */
  readonly checkpoints: readonly string[];

  /** State of the isolated environment, when the manifest declares one. */
  readonly environment: IEnvironmentStatus | null;

  /** Where events of the open workshop are reported, or an empty string. */
  readonly analyticsSink: string;

  /** Whether the open workshop is being edited rather than followed. */
  readonly authoring: boolean;

  /**
   * The open workshop's workspace, relative to the JupyterLab root, or
   * null when no workshop is open.
   */
  readonly workspacePath: string | null;

  /** Lint findings for the open workshop, refreshed on reload. */
  readonly lint: ILintMessage[];

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

  /** Where server-side work goes: the server extension or the browser. */
  readonly backend: IWorkshopBackend;

  /** Open the workshop in a directory relative to the JupyterLab root. */
  open(path: string, options?: IOpenOptions): Promise<void>;

  /** Record a progress event that the manager cannot observe itself. */
  track(kind: string, data?: Record<string, unknown>): void;

  /**
   * Turn author mode on or off. Turning it on marks the workshop as the
   * learner's own, so edits never prompt for trust again.
   */
  setAuthoring(on: boolean): Promise<void>;

  /** Re-read the manifest and pages from disk, keeping progress. */
  reload(): Promise<void>;

  /** Ask the server again about the environment. */
  refreshEnvironment(): Promise<void>;

  /**
   * Create the declared environment, or keep one that already matches
   * its requirements unless `force` is set.
   */
  createEnvironment(force?: boolean): Promise<IEnvironmentStatus>;

  /** The kernel of the environment once it is ready, else undefined. */
  environmentKernel(): string | undefined;

  /**
   * Make sure JupyterLab's cached kernel list has a kernel the server
   * registered, refreshing the list once, and fail with a message naming
   * it when it is still missing. Opening a notebook on a kernel the
   * list lacks would silently start the default kernel instead.
   */
  ensureKernelListed(name: string): Promise<void>;

  /**
   * The environment's directories for a terminal's PATH, once it is
   * ready and unless the manifest keeps terminals off it.
   */
  environmentVenv(): IVenvExports | undefined;

  /** List the workshops under a directory relative to the JupyterLab root. */
  installed(directory: string): Promise<IInstalledWorkshop[]>;

  /** Delete a downloaded workshop that is not open. */
  removeInstalled(path: string): Promise<void>;

  /** Read and validate a collection index, by URL or root-relative path. */
  fetchCollection(url: string): Promise<ICollectionIndex>;

  /** Read and validate a catalog, with its relative locations resolved. */
  fetchCatalog(url: string): Promise<ICatalog>;

  /**
   * Download a workshop from a git forge or archive URL into a directory
   * under the JupyterLab root and return the path it landed in.
   */
  fetch(request: IFetchRequest): Promise<IFetchResult>;

  /** Close the current workshop. */
  close(): Promise<void>;

  /** Change the trust level of the open workshop and remember it. */
  setTrust(level: TrustLevel): Promise<void>;

  /** Show the trust dialog again for the open workshop. */
  reviewTrust(): Promise<void>;

  /** What the trust policy will do with an action from a page. */
  disposition(node: IDirectiveNode): ActionDisposition;

  /** Describe what `uninstall()` would remove for the open workshop. */
  uninstallPlan(): IUninstallPlan | null;

  /**
   * Remove what the workshop created: its progress, settings it changed
   * and, for downloaded workshops, the directory itself.
   */
  uninstall(): Promise<void>;

  /** Forget progress and reopen the workshop from its first page. */
  reset(): Promise<void>;

  /**
   * Put the workshop's files back as they were when it was first opened,
   * forget its progress and, when it is the open workshop, reopen it from
   * the first page. Without a path the open workshop restarts.
   */
  restart(path?: string): Promise<void>;

  /** Whether the current page's requirements allow moving on. */
  gate(pageId?: string): IGateStatus;

  /** Record preflight results reported by the actions plugin. */
  setPreflight(results: IPreflightResult[] | null): void;

  /** Scroll the panel to an action and draw attention to it. */
  focusAction(id: string): void;

  /** Snapshot the workshop files and variables under a name. */
  checkpoint(name: string): Promise<void>;

  /** Put the files and variables of a checkpoint back. */
  restoreCheckpoint(name: string): Promise<void>;

  /** Show a page by index; `force` ignores gating. */
  goTo(index: number, force?: boolean): void;
  goToPage(id: string): void;
  next(): void;
  previous(): void;

  pageProgress(id: string): IPageProgress;

  /**
   * Mark the last page done, as the Finish button does. A page is
   * otherwise done when the learner leaves it forwards with its
   * requirements met.
   */
  finish(): void;

  /** Whether the last visible page is done. */
  readonly finished: boolean;

  /**
   * Identifies one opening of a workshop: new each time one is opened,
   * including a restart of the same one, and kept across a reload.
   */
  readonly sessionId: string;

  actionStatus(id: string): IActionStatus;

  /** Run an action from a page, recording its result and following cascades. */
  runAction(
    node: IDirectiveNode,
    trigger: ActionTrigger,
    argument?: string,
    options?: IRunOptions
  ): Promise<IActionResult>;

  /** Run an ad hoc request, such as from an inline role, recording it. */
  runRequest(
    request: IActionRequest,
    trigger: ActionTrigger,
    node?: IDirectiveNode,
    options?: IRunOptions
  ): Promise<IActionResult>;

  /** Cancel any pending cascade or auto-run. */
  stopChain(): void;

  /** Evaluate a `when` condition against the current variables. */
  evaluate(condition: string): boolean;

  /**
   * Resolve a path relative to the workshop directory to a path relative
   * to the JupyterLab root, refusing paths that escape the workshop.
   */
  resolvePath(path: string, base?: PathBase): string;

  /** Absolute path of the workshop directory on the server, when known. */
  absolutePath(path?: string, base?: PathBase): string;
}

/** A request to download a workshop. */
export interface IFetchRequest {
  /** Repository, forge tree or archive URL. */
  url: string;
  ref?: string;
  subdir?: string;

  /** Directory under the JupyterLab root to download into. */
  directory: string;

  /** Replace an existing directory of the same name. */
  overwrite?: boolean;

  /** Expected archive hash; the download fails when it differs. */
  sha256?: string;

  /** Treat the URL as an archive even without an archive extension. */
  archive?: boolean;

  /** Directory name to install under, instead of the manifest's name. */
  name?: string;

  /** Location of the collection the workshop comes from, recorded with it. */
  collection?: string;
}

/** What a download produced. */
export interface IFetchResult {
  /** Directory of the workshop relative to the JupyterLab root. */
  path: string;
  name: string;
  sha256: string;
}

/**
 * Where a relative path starts: the learner's workspace, or the
 * workshop directory itself for shipped files and state.
 */
export type PathBase = 'workspace' | 'workshop';

/** What a checkpoint records besides the files. */
export interface ICheckpointRecord {
  name: string;
  createdAt: string;

  /** The learner's variable values at the time, to put back on restore. */
  variables: Record<string, { value: string; source: VariableSource }>;

  /** The workspace the checkpoint covers, when it covers only that. */
  subdir?: string;
}

/** What running a verify script produced. */
export interface IScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What running a command through a shell produced. */
export interface IShellResult {
  /** Exit code; non-zero when the command failed or timed out. */
  code: number;

  /** Everything the command printed. */
  output: string;

  /** Why the run failed when there is more to say than the output. */
  error: string;
}

/** A batch of progress events to record. */
export interface IEventsBatch {
  workshop: string;
  events: IWorkshopEvent[];

  /** URL to forward the events to, or an empty string. */
  sink: string;

  /** Whether the JupyterHub user name is attached to each event. */
  identity: 'none' | 'hub';
}

/** A tool the preflight looks for. */
export interface IToolRequest {
  name: string;
  version: string;
  optional: boolean;
}

/** What creating an isolated environment needs. */
export interface IEnvironmentRequest {
  workshop: string;
  requirements: string;
  kernel: string;
  display: string;

  /** Rebuild an environment that already matches its requirements. */
  force?: boolean;
}

/** What running a verify script needs. */
export interface IScriptRequest {
  workshop: string;
  script: string;

  /** Working directory for the script, relative to the workshop. */
  cwd?: string;

  /** Seconds to allow. */
  timeout: number;
  environment: Record<string, string>;
}

/**
 * The work the frontend hands to the server extension, behind an interface
 * so that JupyterLite, which has no server, can do it in the browser.
 */
export interface IWorkshopBackend {
  /** `server` for the jupyter_server extension, `lite` for the browser. */
  readonly kind: 'server' | 'lite';

  /** Describe the platform workshops run on. */
  platform(): Promise<IPlatformInfo>;

  /** Download a workshop into a directory under the root. */
  fetch(request: IFetchRequest): Promise<IFetchResult>;

  /** Read a collection index; the manager validates it. */
  fetchCollection(url: string): Promise<unknown>;

  /** Read a catalog; the manager validates it. */
  fetchCatalog(url: string): Promise<unknown>;

  /** List the workshop directories directly under a directory. */
  installed(directory: string): Promise<IInstalledWorkshop[]>;

  /** Delete a workshop directory. */
  removeInstalled(path: string): Promise<void>;

  /** Snapshot a workshop's files and variables under a name. */
  checkpoint(
    workshop: string,
    name: string,
    variables: ICheckpointRecord['variables'],
    subdir?: string
  ): Promise<void>;

  /** Put a checkpoint's files back and return its record. */
  restoreCheckpoint(workshop: string, name: string): Promise<ICheckpointRecord>;

  environmentStatus(
    workshop: string,
    kernel: string
  ): Promise<IEnvironmentStatus>;
  createEnvironment(request: IEnvironmentRequest): Promise<IEnvironmentStatus>;
  removeEnvironment(workshop: string, kernel: string): Promise<void>;

  /** Run a verify script shipped with the workshop. */
  runScript(request: IScriptRequest): Promise<IScriptResult>;

  /** Look for the tools a workshop requires; `versions` runs them too. */
  preflight(
    tools: IToolRequest[],
    versions: boolean
  ): Promise<IPreflightResult[]>;

  /** Append events to the workshop's events file and forward them. */
  recordEvents(batch: IEventsBatch): Promise<void>;
}

/** Thrown when a download would replace a directory that exists. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** What uninstalling a workshop would do. */
export interface IUninstallPlan {
  /** Human readable descriptions of each step. */
  steps: string[];

  /** Whether the workshop directory itself will be deleted. */
  removesDirectory: boolean;
}

export const IWorkshopManager = new Token<IWorkshopManager>(
  '@jupyterlab-workshop/labextension:IWorkshopManager',
  'Loads workshops and tracks the current page.'
);

/** Ids of the commands the extension registers. */
export namespace CommandIDs {
  export const open = 'workshop:open';
  export const close = 'workshop:close';
  export const nextPage = 'workshop:next-page';
  export const previousPage = 'workshop:previous-page';
  export const finish = 'workshop:finish';
  export const variables = 'workshop:variables';
  export const about = 'workshop:about';
  export const welcome = 'workshop:welcome';
  export const showLog = 'workshop:show-log';
  export const stopChain = 'workshop:stop-chain';
  export const openPath = 'workshop:open-path';
  export const openSelected = 'workshop:open-selected';
  export const openUrl = 'workshop:open-url';
  export const trust = 'workshop:trust';
  export const uninstall = 'workshop:uninstall';
  export const reset = 'workshop:reset';
  export const restart = 'workshop:restart';
  export const runAll = 'workshop:run-all';
  export const selfTestProgress = 'workshop:self-test-progress';
  export const browse = 'workshop:browse';
  export const collections = 'workshop:collections';
  export const launch = 'workshop:launch';
  export const exportEvents = 'workshop:export-events';
  export const createEnvironment = 'workshop:create-environment';
  export const authorMode = 'workshop:author-mode';
  export const newWorkshop = 'workshop:new';
  export const applyLayout = 'workshop:apply-layout';
  export const editPage = 'workshop:edit-page';
  export const editManifest = 'workshop:edit-manifest';
  export const openSource = 'workshop:open-source';
  export const newPage = 'workshop:new-page';
  export const managePages = 'workshop:manage-pages';
  export const insertAction = 'workshop:insert-action';
  export const editAction = 'workshop:edit-action';
  export const deleteAction = 'workshop:delete-action';
  export const capture = 'workshop:capture';
  export const runPageActions = 'workshop:run-page-actions';
  export const runPageChecks = 'workshop:run-page-checks';
  export const runPage = 'workshop:run-page';
  export const showLint = 'workshop:lint';
  export const applyFix = 'workshop:apply-fix';
  export const trustPreview = 'workshop:trust-preview';
  export const publish = 'workshop:publish';
  export const record = 'workshop:record';
  export const recordPageBreak = 'workshop:record-page-break';
  export const bridgeOpen = 'workshop:bridge-open';
  export const bridgeStatus = 'workshop:bridge-status';
  export const bridgeRun = 'workshop:bridge-run';
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
