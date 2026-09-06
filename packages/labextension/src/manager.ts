import {
  ActionDisposition,
  Capability,
  IDirectiveNode,
  ILintMessage,
  IPage,
  IRegistryIndex,
  IWorkshopManifest,
  PRISTINE_CHECKPOINT,
  TrustLevel,
  Variables,
  parseRegistryIndex,
  parseRequirement,
  actionCapability,
  decideAction,
  declaredCapabilities,
  declaredVariables,
  formatDiff,
  isAutomatic,
  lineDiff,
  parseManifest,
  parsePage,
  renderEnvCmd,
  renderEnvPs1,
  renderEnvSh
} from '@jupyterlab-workshop/core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { PartialJSONValue } from '@lumino/coreutils';
import { Debouncer } from '@lumino/polling';
import { ISignal, Signal } from '@lumino/signaling';

import {
  deleteTree,
  readIfExists,
  readTextFile,
  writeTextFile
} from './actions/contents';
import { STATE_FILE, StateStore, WORKSHOP_STATE_DIR } from './state';
import {
  ActionTrigger,
  IActionLogEntry,
  IActionRegistry,
  IActionRequest,
  IActionResult,
  IActionStatus,
  IEnvironmentStatus,
  IFetchRequest,
  IFeaturePolicy,
  IFetchResult,
  IGateStatus,
  IInstalledWorkshop,
  ILoadedWorkshop,
  IOpenOptions,
  IPreflightResult,
  IPageProgress,
  IRestartResult,
  IPlatformInfo,
  ITrustDecision,
  ITrustPrompts,
  ITrustStore,
  ITrustSummary,
  IUninstallPlan,
  IWorkshopBackend,
  IWorkshopEvent,
  IWorkshopManager,
  IWorkshopSource,
  errorMessage
} from './tokens';
import { buildTrustSummary, readSourceRecord } from './trust/summary';
import {
  conditionHolds,
  parseDuration,
  sleep,
  visibleDirectives
} from './util';
import { VariableStore } from './variables';

const STATE_KEY = '@jupyterlab-workshop/labextension:state';

/**
 * Pauses between the attempts of a verify fired by a trigger that has not
 * passed yet, since the action that fired it may still be finishing.
 */
const SETTLE_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];

const MANIFEST_FILE = 'workshop.yaml';

interface IStoredState {
  workshopPath: string;
}

interface IQueued {
  node: IDirectiveNode;
  trigger: ActionTrigger;
  delayMs: number;
}

/**
 * Loads a workshop through the contents API, tracks progress and runs
 * actions, including cascades and automatic runs.
 */
export class WorkshopManager implements IWorkshopManager {
  constructor(options: WorkshopManager.IOptions) {
    this._contents = options.contents;
    this._backend = options.backend;
    this._stateDB = options.stateDB;
    this._trustStore = options.trustStore;
    this._prompts = options.prompts;
    this._settings = options.settings ?? null;
    this._features = options.features ?? null;
    this._state = new StateStore(options.contents);
    this._envWriter = new Debouncer(() => this._writeEnvFiles(), 300);
    this._reloader = new Debouncer(() => this.reload(), 300);

    this._store.changed.connect(this._onVariablesChanged, this);
    this._contents.fileChanged.connect(this._onFileChanged, this);
  }

  registry: IActionRegistry | null = null;

  get backend(): IWorkshopBackend {
    return this._backend;
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get actionChanged(): ISignal<this, string> {
    return this._actionChanged;
  }

  get events(): ISignal<this, IWorkshopEvent> {
    return this._events;
  }

  get actionFocused(): ISignal<this, string> {
    return this._actionFocused;
  }

  get environmentChanged(): ISignal<this, void> {
    return this._environmentChanged;
  }

  get workshop(): ILoadedWorkshop | null {
    return this._workshop;
  }

  get variables(): VariableStore {
    return this._store;
  }

  get platform(): IPlatformInfo | null {
    return this._platform;
  }

  get error(): string | null {
    return this._error;
  }

  get trust(): TrustLevel | null {
    return this._decision?.level ?? null;
  }

  get preflight(): IPreflightResult[] | null {
    return this._preflight;
  }

  get checkpoints(): readonly string[] {
    return this._state.state?.checkpoints ?? [];
  }

  get environment(): IEnvironmentStatus | null {
    return this._environment;
  }

  get analyticsSink(): string {
    // The workshop's own sink needs the learner's opt-in; an administrator's
    // sink applies to every workshop.
    const own = this._workshop?.manifest.analytics?.sink ?? '';

    if (own && this._decision?.analytics) {
      return own;
    }

    return this._trustStore.policy.analyticsSink;
  }

  get authoring(): boolean {
    return this._authoring && this._features?.enabled('author') !== false;
  }

  get lint(): ILintMessage[] {
    return this._workshop?.trust.lint ?? [];
  }

  get visiblePages(): IPage[] {
    if (!this._workshop) {
      return [];
    }

    const values = this._store.values;

    return this._workshop.pages.filter(page =>
      conditionHolds(page.frontmatter.when, values)
    );
  }

  get pageIndex(): number {
    const index = this.visiblePages.findIndex(
      page => page.id === this._currentPageId
    );

    return index < 0 ? 0 : index;
  }

  get currentPage(): IPage | null {
    return this.visiblePages[this.pageIndex] ?? null;
  }

  get chainRunning(): boolean {
    return this._queue.length > 0 || this._pumping;
  }

  get log(): readonly IActionLogEntry[] {
    return this._state.state?.log ?? [];
  }

  async open(path: string, options: IOpenOptions = {}): Promise<void> {
    const workshopPath = normalizeWorkshopPath(path);

    // Leaving a workshop that is open counts as abandoning it.
    if (this._workshop && this._workshop.path !== workshopPath) {
      this._leaveWorkshop();
    }

    this.stopChain();
    this._error = null;
    this._preflight = null;
    this._environment = null;
    this._loading = true;

    try {
      const platform = await this._ensurePlatform();
      const manifestPath = PathExt.join(workshopPath, MANIFEST_FILE);
      const manifestSource = await readTextFile(this._contents, manifestPath);
      const manifest = parseManifest(manifestSource, manifestPath);

      // Read every page up front so navigation is instant.
      const sources: Record<string, string> = {};

      await Promise.all(
        manifest.pages.map(async pagePath => {
          sources[pagePath] = await readTextFile(
            this._contents,
            PathExt.join(workshopPath, pagePath)
          );
        })
      );

      // Work out where the workshop came from and what it asks for, then
      // settle the trust level before anything else happens.
      const record = await readSourceRecord(this._contents, workshopPath);
      const source: IWorkshopSource = record?.source ?? {
        kind: 'local',
        url: workshopPath
      };
      // The preview used for the trust summary and lint renders with the
      // built-ins and manifest defaults, as the learner will first see it.
      const pathSep = platform.path_sep;
      const declared = this._collectDeclared(manifest, sources);
      const defaults: Variables = { ...buildBuiltins(workshopPath, platform) };

      for (const definition of manifest.variables) {
        if (definition.default !== undefined) {
          defaults[definition.name] = definition.default;
        }
      }

      const preview = manifest.pages.map(pagePath =>
        parsePage(sources[pagePath], {
          path: pagePath,
          variables: defaults,
          pathSep,
          declared,
          platform: platform.os
        })
      );
      const trust = buildTrustSummary({
        manifest,
        manifestSource,
        pages: preview,
        sources,
        source,
        hash: record?.sha256
      });
      const decision = await this._resolveTrust(trust);

      if (!decision) {
        this._workshop = null;
        this._currentPageId = '';
        this._decision = null;
        this._authoring = false;
        this._loading = false;
        await this._saveStateDB();
        this._changed.emit();

        return;
      }

      // A workshop marked as the learner's own reopens in author mode.
      this._authoring = await this._trustStore.isAuthored(trust.sourceKey);

      // The first time a workshop opens, before any action can touch its
      // files, they are snapshotted so that "Restart" can put them back.
      const fresh =
        (await readIfExists(
          this._contents,
          PathExt.join(workshopPath, WORKSHOP_STATE_DIR, STATE_FILE)
        )) === null;

      if (fresh) {
        await this._snapshotPristine(workshopPath);
      }

      const state = await this._state.load(
        workshopPath,
        manifest.name,
        manifest.version ?? ''
      );

      state.trust = decision.level;
      state.workshop.hash = trust.hash;
      state.workshop.source = source;

      this._decision = decision;
      this._workshop = {
        path: workshopPath,
        manifest,
        sources,
        pages: [],
        source,
        trust,
        launched: options.launch === true
      };
      this._store.load(
        buildBuiltins(workshopPath, platform),
        manifest.variables,
        state.variables
      );

      // Values from a launch link sit above the manifest defaults but
      // below anything the learner sets.
      for (const [name, value] of Object.entries(options.variables ?? {})) {
        this._store.set(name, value, 'override');
      }

      this._renderPages();

      // Return to the saved page when it is still visible.
      const visible = this.visiblePages;
      const saved = visible.find(page => page.id === state.currentPage);
      const first = saved ?? visible[0];
      const resumed = Object.values(state.pages).some(
        page => page.enteredAt !== undefined
      );

      this._sessionId = randomId();
      this._finished = false;
      this._emit(resumed ? 'workshop-resume' : 'workshop-start', {
        page: first?.id ?? ''
      });

      if (first) {
        this._enterPage(
          first.id,
          saved === undefined || !state.pages[first.id]?.enteredAt
        );
      }

      if (manifest.environment?.requirements) {
        void this.refreshEnvironment();
      }
    } catch (error) {
      this._workshop = null;
      this._currentPageId = '';
      this._decision = null;
      this._authoring = false;
      this._error = `Unable to open workshop "${workshopPath}": ${errorMessage(error)}`;
    }

    this._loading = false;

    // The files must exist before the layout opens a terminal that
    // sources them, so the first write is not debounced.
    await this._writeEnvFiles();
    await this._saveStateDB();
    this._changed.emit();
  }

  async setAuthoring(on: boolean): Promise<void> {
    const workshop = this._workshop;

    if (!workshop || this._authoring === on) {
      return;
    }

    if (on && this._features?.enabled('author') === false) {
      return;
    }

    // The author's own workshop is trusted at every hash from now on, so
    // saving a page never brings the trust dialog back.
    if (on) {
      await this._trustStore.setAuthored(workshop.trust.sourceKey, true);

      if (this._decision?.level !== 'trusted') {
        await this.setTrust('trusted');
      }
    }

    this._authoring = on;
    this._changed.emit();
  }

  async reload(): Promise<void> {
    const workshop = this._workshop;
    const platform = this._platform;

    if (!workshop || !platform || this._loading) {
      return;
    }

    try {
      const manifestPath = PathExt.join(workshop.path, MANIFEST_FILE);
      const manifestSource = await readTextFile(this._contents, manifestPath);
      const manifest = parseManifest(manifestSource, manifestPath);
      const sources: Record<string, string> = {};

      await Promise.all(
        manifest.pages.map(async pagePath => {
          sources[pagePath] = await readTextFile(
            this._contents,
            PathExt.join(workshop.path, pagePath)
          );
        })
      );

      // The trust summary carries the lint findings and the content hash,
      // so it is rebuilt; the decision itself stands.
      const declared = this._collectDeclared(manifest, sources);
      const defaults: Variables = { ...buildBuiltins(workshop.path, platform) };

      for (const definition of manifest.variables) {
        if (definition.default !== undefined) {
          defaults[definition.name] = definition.default;
        }
      }

      const preview = manifest.pages.map(pagePath =>
        parsePage(sources[pagePath], {
          path: pagePath,
          variables: defaults,
          pathSep: platform.path_sep,
          declared,
          platform: platform.os
        })
      );

      if (this._workshop !== workshop) {
        return;
      }

      workshop.manifest = manifest;
      workshop.sources = sources;
      workshop.trust = buildTrustSummary({
        manifest,
        manifestSource,
        pages: preview,
        sources,
        source: workshop.source,
        hash: workshop.source.kind === 'local' ? undefined : workshop.trust.hash
      });

      const state = this._state.state;

      if (state) {
        state.workshop.hash = workshop.trust.hash;
      }

      this._store.load(
        buildBuiltins(workshop.path, platform),
        manifest.variables,
        this._store.persistable()
      );
      this._renderPages();
      this._error = null;

      // Keep the page the author is looking at, unless it went away.
      if (!this.visiblePages.some(page => page.id === this._currentPageId)) {
        const first = this.visiblePages[0];

        if (first) {
          this._enterPage(first.id, false);
        }
      }
    } catch (error) {
      this._error = `Unable to reload workshop "${workshop.path}": ${errorMessage(error)}`;
    }

    await this._writeEnvFiles();
    this._changed.emit();
  }

  async fetch(request: IFetchRequest): Promise<IFetchResult> {
    return this._backend.fetch(request);
  }

  track(kind: string, data: Record<string, unknown> = {}): void {
    this._emit(kind, data);
  }

  async refreshEnvironment(): Promise<void> {
    const workshop = this._workshop;
    const environment = workshop?.manifest.environment;

    if (!workshop || !environment?.requirements) {
      this._environment = null;

      return;
    }

    try {
      const status = await this._backend.environmentStatus(
        workshop.path,
        this._environmentName()
      );

      if (this._workshop === workshop) {
        this._environment = { ...status, creating: false };
        this._changed.emit();
      }
    } catch (error) {
      console.warn('Unable to read the workshop environment', error);
    }
  }

  async createEnvironment(): Promise<IEnvironmentStatus> {
    const workshop = this._workshop;
    const environment = workshop?.manifest.environment;

    if (!workshop || !environment?.requirements) {
      throw new Error('The workshop does not declare an environment');
    }

    const kernel = this._environmentName();

    this._environment = {
      ...(this._environment ?? emptyEnvironment(kernel)),
      creating: true,
      error: undefined
    };
    this._changed.emit();

    try {
      const status = await this._backend.createEnvironment({
        workshop: workshop.path,
        requirements: environment.requirements,
        kernel,
        display: `${workshop.manifest.title} (workshop)`
      });

      if (this._workshop === workshop) {
        this._environment = { ...status, creating: false };
        this._changed.emit();
      }

      this._emit('environment-created', { kernel: status.kernel });

      return status;
    } catch (error) {
      if (this._workshop === workshop) {
        this._environment = {
          ...(this._environment ?? emptyEnvironment(kernel)),
          creating: false,
          error: errorMessage(error)
        };
        this._changed.emit();
      }

      throw error;
    }
  }

  environmentKernel(): string | undefined {
    const status = this._environment;

    return status?.ready && status.registered ? status.kernel : undefined;
  }

  async installed(directory: string): Promise<IInstalledWorkshop[]> {
    return this._backend.installed(directory);
  }

  async removeInstalled(path: string): Promise<void> {
    const target = normalizeWorkshopPath(path);

    if (this._workshop?.path === target) {
      await this.uninstall();

      return;
    }

    await this._backend.removeInstalled(target);
  }

  async fetchRegistry(url: string): Promise<IRegistryIndex> {
    return parseRegistryIndex(await this._backend.fetchRegistry(url));
  }

  async close(): Promise<void> {
    this._leaveWorkshop();
    this.stopChain();
    await this._state.flush();
    await this._state.unload();

    this._workshop = null;
    this._currentPageId = '';
    this._decision = null;
    this._environment = null;
    this._error = null;
    this._authoring = false;
    this._store.load({}, []);

    await this._saveStateDB();
    this._changed.emit();
  }

  async setTrust(level: TrustLevel): Promise<void> {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const decision: ITrustDecision = {
      level,
      allowed: [],
      analytics: this._decision?.analytics,
      decidedAt: new Date().toISOString(),
      sourceKey: workshop.trust.sourceKey,
      hash: workshop.trust.hash,
      name: workshop.manifest.name
    };

    await this._trustStore.set(decision);

    this._decision = decision;

    const state = this._state.state;

    if (state) {
      state.trust = level;
      this._state.save();
    }

    // Anything queued under the old level should not run under the new.
    this.stopChain();
    this._changed.emit();
  }

  async reviewTrust(): Promise<void> {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const choice = await this._prompts.decide(
      workshop.trust,
      this._decision?.level ?? this._trustStore.policy.defaultLevel
    );

    if (choice) {
      if (this._decision) {
        this._decision.analytics = choice.analytics;
      }

      await this.setTrust(choice.level);
    }
  }

  disposition(node: IDirectiveNode): ActionDisposition {
    return this._decide(node.name, isAutomatic(node), node.options);
  }

  uninstallPlan(): IUninstallPlan | null {
    const workshop = this._workshop;

    if (!workshop) {
      return null;
    }

    const steps: string[] = [];
    const settings = this._state.state?.installed.settings ?? [];
    const removesDirectory = workshop.source.kind !== 'local';

    if (removesDirectory) {
      steps.push(
        `Delete the workshop directory ${workshop.path} and everything in it`
      );
    } else {
      steps.push(
        `Delete the progress and environment files in ${PathExt.join(workshop.path, WORKSHOP_STATE_DIR)}`
      );
      steps.push(
        'Leave the workshop directory in place because it was opened from a local directory'
      );
    }

    for (const change of settings) {
      steps.push(`Restore the setting ${change.plugin} ${change.key}`);
    }

    if (this._environment?.ready) {
      steps.push(
        `Remove the kernel "${this._environment.kernel}" and the environment it runs in`
      );
    }

    steps.push('Forget the trust decision for this workshop');

    return { steps, removesDirectory };
  }

  async uninstall(): Promise<void> {
    const workshop = this._workshop;
    const plan = this.uninstallPlan();

    if (!workshop || !plan) {
      return;
    }

    this.stopChain();

    const settings = this._state.state?.installed.settings ?? [];
    const sourceKey = workshop.trust.sourceKey;
    const path = workshop.path;
    const stateDir = PathExt.join(path, WORKSHOP_STATE_DIR);

    // Put settings back first while the registry still knows about them,
    // and unregister the environment's kernel before its files go.
    await this._restoreSettings(settings);

    if (this._environment?.ready) {
      try {
        await this._backend.removeEnvironment(path, this._environment.kernel);
      } catch (error) {
        console.warn('Unable to remove the workshop environment', error);
      }
    }

    this._leaveWorkshop();

    // Drop the workshop before touching files so nothing writes them back.
    await this._state.unload();

    this._workshop = null;
    this._currentPageId = '';
    this._decision = null;
    this._environment = null;
    this._error = null;
    this._authoring = false;
    this._store.load({}, []);

    await this._saveStateDB();
    this._changed.emit();

    if (plan.removesDirectory) {
      await this._backend.removeInstalled(path);
    } else {
      await deleteTree(this._contents, stateDir);
    }

    await this._trustStore.forget(sourceKey);
  }

  async reset(): Promise<void> {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const path = workshop.path;
    const settings = this._state.state?.installed.settings ?? [];

    this.stopChain();
    await this._restoreSettings(settings);
    await this._state.unload();
    await deleteTree(this._contents, PathExt.join(path, WORKSHOP_STATE_DIR));

    this._workshop = null;
    this._currentPageId = '';
    this._store.load({}, []);

    await this.open(path);
  }

  async restart(path?: string): Promise<IRestartResult> {
    const workshop = this._workshop;
    const target =
      path === undefined ? workshop?.path : normalizeWorkshopPath(path);

    if (target === undefined) {
      throw new Error('No workshop is open');
    }

    const open = workshop !== null && workshop.path === target;

    // Leave the open workshop first so nothing writes state back while
    // the files change underneath it.
    if (open) {
      const settings = this._state.state?.installed.settings ?? [];

      this.stopChain();
      await this._restoreSettings(settings);
      await this._state.unload();

      this._workshop = null;
      this._currentPageId = '';
      this._store.load({}, []);
    }

    // Put the files back, then drop the state directory, snapshot
    // included: reopening takes a fresh one of the restored files.
    let files = true;

    try {
      await this._backend.restoreCheckpoint(target, PRISTINE_CHECKPOINT);
    } catch (error) {
      console.warn('No pristine snapshot to restore', error);
      files = false;
    }

    await deleteTree(this._contents, PathExt.join(target, WORKSHOP_STATE_DIR));

    if (open) {
      await this.open(target);
    }

    return { files };
  }

  /**
   * Reopen the workshop that was open in a previous session.
   *
   * Returns whether a workshop was restored.
   */
  async restore(): Promise<boolean> {
    if (!this._stateDB) {
      return false;
    }

    const stored = await this._stateDB.fetch(STATE_KEY);

    if (!isStoredState(stored) || stored.workshopPath === '') {
      return false;
    }

    await this.open(stored.workshopPath);

    return this._workshop !== null;
  }

  goTo(index: number, force = false): void {
    const visible = this.visiblePages;
    const page = visible[Math.max(0, Math.min(index, visible.length - 1))];

    if (!page || page.id === this._currentPageId) {
      return;
    }

    // Moving forward past unmet requirements is refused under strict
    // gating and recorded as a skip under soft gating, unless forced by
    // the self-test harness.
    if (index > this.pageIndex && !force) {
      const gate = this.gate();

      if (gate.blocked) {
        return;
      }

      if (gate.unmet.length > 0) {
        const state = this._state.state;
        const skipped = gate.unmet.map(item => `${item.kind}:${item.id}`);

        if (state) {
          const current = this._currentPageId;

          state.pages[current] = {
            ...state.pages[current],
            done: state.pages[current]?.done ?? false,
            skipped
          };
        }

        this._emit('gate-skipped', {
          page: this._currentPageId,
          requirements: skipped
        });
      }
    }

    this._enterPage(page.id, true);
    this._changed.emit();
  }

  gate(pageId?: string): IGateStatus {
    const policy = this._workshop?.manifest.gating ?? 'off';
    const id = pageId ?? this._currentPageId;
    const page = this._workshop?.pages.find(item => item.id === id);
    const unmet = [];

    if (policy !== 'off' && page) {
      for (const text of page.frontmatter.requires) {
        const requirement = parseRequirement(text);

        if (requirement && this.actionStatus(requirement.id).status !== 'ok') {
          unmet.push(requirement);
        }
      }
    }

    return { policy, unmet, blocked: policy === 'strict' && unmet.length > 0 };
  }

  setPreflight(results: IPreflightResult[] | null): void {
    this._preflight = results;
    this._changed.emit();

    if (results) {
      this._emit('preflight-result', {
        tools: results.map(result => ({
          name: result.name,
          found: result.found,
          satisfied: result.satisfied,
          version: result.version ?? ''
        }))
      });
    }
  }

  focusAction(id: string): void {
    this._actionFocused.emit(id);
  }

  async checkpoint(name: string): Promise<void> {
    const workshop = this._workshop;
    const state = this._state.state;

    if (!workshop || !state) {
      throw new Error('No workshop is open');
    }

    await this._backend.checkpoint(
      workshop.path,
      name,
      this._store.persistable()
    );

    if (!state.checkpoints.includes(name)) {
      state.checkpoints.push(name);
      this._state.save();
    }

    this._changed.emit();
  }

  async restoreCheckpoint(name: string): Promise<void> {
    const workshop = this._workshop;

    if (!workshop) {
      throw new Error('No workshop is open');
    }

    const record = await this._backend.restoreCheckpoint(workshop.path, name);

    // Put the learner's values back as they were at the checkpoint.
    for (const entry of this._store.entries()) {
      if (!entry.readonly) {
        this._store.reset(entry.name);
      }
    }

    for (const [variable, { value, source }] of Object.entries(
      record.variables ?? {}
    )) {
      this._store.set(variable, value, source);
    }

    this._emit('checkpoint-restored', { name });
    this._changed.emit();
  }

  goToPage(id: string): void {
    const index = this.visiblePages.findIndex(page => page.id === id);

    if (index >= 0) {
      this.goTo(index);
    }
  }

  next(): void {
    this.goTo(this.pageIndex + 1);
  }

  previous(): void {
    this.goTo(this.pageIndex - 1);
  }

  pageProgress(id: string): IPageProgress {
    return this._state.state?.pages[id] ?? { done: false };
  }

  markDone(id?: string, done = true): void {
    const state = this._state.state;
    const pageId = id ?? this._currentPageId;

    if (!state || !pageId) {
      return;
    }

    state.pages[pageId] = { ...state.pages[pageId], done };
    this._state.save();
    this._changed.emit();

    // Pages that ask for it are checkpointed when marked done.
    const page = this._workshop?.pages.find(item => item.id === pageId);

    if (done && page?.frontmatter.checkpoint) {
      this.checkpoint(pageId).catch(error => {
        console.warn(`Unable to checkpoint page ${pageId}`, error);
      });
    }

    // Finishing the last page finishes the workshop, once.
    const visible = this.visiblePages;
    const allDone =
      visible.length > 0 &&
      visible.every(item => state.pages[item.id]?.done === true);

    if (done && allDone && !this._finished) {
      this._finished = true;
      this._emit('workshop-finish', { pages: visible.length });
    }
  }

  actionStatus(id: string): IActionStatus {
    return (
      this._running.get(id) ??
      this._state.state?.actions[id] ?? { status: 'idle', runs: 0 }
    );
  }

  async runAction(
    node: IDirectiveNode,
    trigger: ActionTrigger,
    argument?: string
  ): Promise<IActionResult> {
    return this.runRequest(this._toRequest(node, argument), trigger, node);
  }

  async runRequest(
    request: IActionRequest,
    trigger: ActionTrigger,
    node?: IDirectiveNode
  ): Promise<IActionResult> {
    const registry = this.registry;

    if (!registry) {
      return { status: 'error', message: 'No action registry is available' };
    }

    // A click while a chain is pending cancels the chain first.
    if (trigger === 'click' || trigger === 'role') {
      this.stopChain();
    }

    this._running.set(request.id, {
      status: 'running',
      runs: this.actionStatus(request.id).runs
    });
    this._actionChanged.emit(request.id);

    // A body chosen from platform variants that came out empty means the
    // action has nothing to do on this platform.
    const automatic = trigger === 'auto' || trigger === 'cascade';
    const disposition = this._decide(request.type, automatic, request.options);
    const result =
      node?.variants && request.body.trim() === ''
        ? {
            status: 'skipped' as const,
            message: `Nothing to do on ${this._platform?.os ?? 'this platform'}`
          }
        : await this._runSettled(registry, request, trigger);

    if (result.captured) {
      for (const [name, value] of Object.entries(result.captured)) {
        this._store.set(name, value, result.captureSource ?? 'capture');
      }
    }

    this._record(request, result, trigger, registry.describe(request));
    this._running.delete(request.id);
    this._actionChanged.emit(request.id);
    this._emitActionEvent(request, result, trigger, disposition.kind);

    // Gating is shown outside the page body, which only redraws on the
    // broader change signal.
    const requires = this.currentPage?.frontmatter.requires ?? [];

    if (requires.some(text => text.endsWith(`:${request.id}`))) {
      this._changed.emit();
    }

    if (node && request.page) {
      if (result.status === 'ok') {
        this._queueFollowers(node, request.page);
      } else if (
        result.status === 'error' &&
        request.options['on-error'] !== 'continue'
      ) {
        this.stopChain();
      }
    }

    return result;
  }

  /**
   * Run a request, giving a verify fired by a trigger time to settle.
   *
   * A trigger such as `after:<action>` fires as soon as the action
   * reports completion, which for a terminal command is when it has been
   * typed, so a check of the command's results can run too early. A
   * failing triggered verify is tried again over the next few seconds,
   * staying in the running state, before the failure stands. Clicking
   * Check runs once, as before.
   */
  private async _runSettled(
    registry: IActionRegistry,
    request: IActionRequest,
    trigger: ActionTrigger
  ): Promise<IActionResult> {
    let result = await this._runGated(registry, request, trigger);

    if (request.type !== 'verify' || trigger !== 'trigger') {
      return result;
    }

    const workshop = this._workshop;
    const page = this._currentPageId;

    for (const delay of SETTLE_DELAYS_MS) {
      if (result.status !== 'error') {
        break;
      }

      this._running.set(request.id, {
        status: 'running',
        message: 'Not yet; checking again',
        runs: this.actionStatus(request.id).runs
      });
      this._actionChanged.emit(request.id);

      await sleep(delay);

      // Leaving the page or the workshop ends the attempts.
      if (this._workshop !== workshop || this._currentPageId !== page) {
        break;
      }

      result = await this._runGated(registry, request, trigger);
    }

    return result;
  }

  stopChain(): void {
    this._queue = [];
    this._abort?.abort();
    this._abort = null;
  }

  evaluate(condition: string): boolean {
    return conditionHolds(condition, this._store.values);
  }

  resolvePath(path: string): string {
    if (!this._workshop) {
      throw new Error('No workshop is open');
    }

    const root = this._workshop.path;
    const resolved = PathExt.normalize(PathExt.join(root, path));
    const inside =
      root === ''
        ? !resolved.startsWith('..')
        : resolved === root || resolved.startsWith(`${root}/`);

    // A wider write scope lets paths reach anywhere JupyterLab can serve,
    // but never above its root.
    if (!inside) {
      const scopes = declaredCapabilities(this._workshop.manifest).get(
        'write-files'
      );
      const wide = scopes?.some(scope => scope === 'home' || scope === 'any');

      if (!wide || resolved.startsWith('..')) {
        throw new Error(`Path "${path}" is outside the workshop directory`);
      }
    }

    return resolved;
  }

  absolutePath(path = ''): string {
    if (!this._workshop) {
      throw new Error('No workshop is open');
    }

    const root = this._platform?.root_dir ?? '';
    const relative = path
      ? PathExt.join(this._workshop.path, path)
      : this._workshop.path;
    const separator = this._platform?.path_sep ?? '/';

    return [root, ...relative.split('/')]
      .filter(part => part !== '')
      .join(separator);
  }

  private _toRequest(node: IDirectiveNode, argument?: string): IActionRequest {
    const defaults = this._workshop?.manifest.defaults ?? {};

    return {
      type: node.name,
      id: node.id,
      argument: argument ?? node.argument,
      options: { ...defaults, ...node.options },
      body: node.body,
      page: this._currentPageId
    };
  }

  private _record(
    request: IActionRequest,
    result: IActionResult,
    trigger: ActionTrigger,
    description: string
  ): void {
    const state = this._state.state;

    if (!state) {
      return;
    }

    const previous = state.actions[request.id];
    const status: IActionStatus = {
      status: result.status,
      message: result.message,
      runs: (previous?.runs ?? 0) + 1
    };

    state.actions[request.id] = status;

    // Keep the first pre-change value of a setting for uninstall.
    if (result.setting && result.status === 'ok') {
      const { plugin, key } = result.setting;
      const known = state.installed.settings.some(
        change => change.plugin === plugin && change.key === key
      );

      if (!known) {
        state.installed.settings.push(result.setting);
      }
    }

    this._state.appendLog({
      time: new Date().toISOString(),
      page: request.page ?? '',
      id: request.id,
      type: request.type,
      text: `${description}${request.body ? `: ${firstLine(request.body)}` : ''}`,
      status: result.status,
      message: result.message,
      trigger
    });

    this._state.save();
  }

  private _enterPage(id: string, runAutos: boolean): void {
    this.stopChain();
    this._leavePage();
    this._currentPageId = id;
    this._pageEnteredAt = Date.now();

    const state = this._state.state;

    if (state) {
      state.currentPage = id;
      state.pages[id] = {
        ...state.pages[id],
        enteredAt: new Date().toISOString()
      };
      this._state.save();
    }

    this._emit('page-enter', { page: id });

    if (runAutos) {
      const page = this.currentPage;

      if (page) {
        const autos = visibleDirectives(page, this._store.values).filter(
          node => node.options.auto === 'page-enter'
        );

        this._enqueue(
          autos.map(node => ({
            node,
            trigger: 'auto' as const,
            delayMs: this._delayFor(node)
          }))
        );
      }
    }
  }

  private _leavePage(): void {
    if (this._currentPageId && this._pageEnteredAt > 0) {
      this._emit('page-leave', {
        page: this._currentPageId,
        active_ms: Date.now() - this._pageEnteredAt
      });
    }

    this._pageEnteredAt = 0;
  }

  private _leaveWorkshop(): void {
    if (!this._workshop) {
      return;
    }

    this._leavePage();

    if (!this._finished) {
      this._emit('workshop-abandon', { page: this._currentPageId });
    }
  }

  private _environmentName(): string {
    const workshop = this._workshop;

    return (
      workshop?.manifest.environment?.kernel ??
      `workshop-${workshop?.manifest.name ?? 'unknown'}`
    );
  }

  private _emit(kind: string, data: Record<string, unknown>): void {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    this._events.emit({
      ...data,
      kind,
      ts: new Date().toISOString(),
      session_id: this._sessionId,
      workshop: workshop.path,
      version: workshop.manifest.version ?? '',
      platform: this._platform?.os ?? '',
      trust: this._decision?.level ?? ''
    });
  }

  private _emitActionEvent(
    request: IActionRequest,
    result: IActionResult,
    trigger: ActionTrigger,
    disposition: ActionDisposition['kind']
  ): void {
    const attempt = this.actionStatus(request.id).runs;

    switch (request.type) {
      case 'verify':
        this._emit('verify-result', {
          id: request.id,
          status: result.status,
          attempt,
          trigger
        });
        break;

      case 'quiz':
        this._emit('quiz-answered', {
          id: request.id,
          correct: result.status === 'ok',
          attempt
        });
        break;

      case 'form':
        this._emit('form-submitted', {
          id: request.id,
          fields: Object.keys(result.captured ?? {})
        });
        break;

      default:
        this._emit('action-executed', {
          id: request.id,
          type: request.type,
          status: result.status,
          trigger,
          downgraded: disposition === 'downgrade'
        });
        break;
    }
  }

  private _queueFollowers(node: IDirectiveNode, pageId: string): void {
    const page = this.currentPage;

    if (!page || page.id !== pageId) {
      return;
    }

    const directives = visibleDirectives(page, this._store.values);
    const followers: IQueued[] = [];

    // Cascade from the producer: the next action in document order, or a
    // named one, optionally with its own delay.
    const cascade =
      node.options.cascade ?? this._workshop?.manifest.defaults.cascade;

    if (cascade && cascade !== 'false') {
      let target: IDirectiveNode | undefined;
      let delayMs: number | undefined;

      if (cascade === 'true') {
        const index = directives.findIndex(item => item.id === node.id);

        target = index >= 0 ? directives[index + 1] : undefined;
      } else {
        const link = /^(\S+)(?:\s+after\s+(\S+))?$/.exec(cascade.trim());

        target = link
          ? directives.find(item => item.id === link[1])
          : undefined;
        delayMs = link?.[2] ? parseDuration(link[2], 0) : undefined;
      }

      if (target) {
        followers.push({
          node: target,
          trigger: 'cascade',
          delayMs: delayMs ?? this._delayFor(target)
        });
      }
    }

    // Triggers on consumers waiting for this action.
    for (const item of directives) {
      if (item.options.auto === `after:${node.id}` && item.id !== node.id) {
        followers.push({
          node: item,
          trigger: 'auto',
          delayMs: this._delayFor(item)
        });
      }
    }

    this._enqueue(followers);
  }

  private _delayFor(node: IDirectiveNode): number {
    const fallback = parseDuration(this._workshop?.manifest.defaults.delay, 0);

    return parseDuration(node.options.delay, fallback);
  }

  private _enqueue(items: IQueued[]): void {
    if (items.length === 0) {
      return;
    }

    this._queue.unshift(...items);
    void this._pump();
  }

  private async _pump(): Promise<void> {
    if (this._pumping) {
      return;
    }

    this._pumping = true;
    this._changed.emit();

    try {
      while (this._queue.length > 0) {
        const item = this._queue.shift() as IQueued;
        const abort = new AbortController();

        this._abort = abort;

        if (!(await sleep(item.delayMs, abort.signal))) {
          break;
        }

        if (abort.signal.aborted) {
          break;
        }

        if (item.node.options.scroll !== 'false') {
          this._actionFocused.emit(item.node.id);
        }

        await this.runRequest(
          this._toRequest(item.node),
          item.trigger,
          item.node
        );
      }
    } finally {
      this._pumping = false;
      this._abort = null;
      this._changed.emit();
    }
  }

  private _collectDeclared(
    manifest: IWorkshopManifest,
    sources: Record<string, string>
  ): Set<string> {
    // Names set by captures, choices and env-set anywhere in the workshop
    // render as placeholders rather than warnings before they have values.
    const declared = new Set<string>(
      manifest.variables.map(definition => definition.name)
    );

    for (const pagePath of manifest.pages) {
      const page = parsePage(sources[pagePath], {
        path: pagePath,
        variables: {}
      });

      for (const name of declaredVariables(page.nodes)) {
        declared.add(name);
      }
    }

    this._declared = declared;

    return declared;
  }

  private _renderPages(): void {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const variables = this._store.values;
    const pathSep = this._platform?.path_sep ?? '/';

    workshop.pages = workshop.manifest.pages.map(pagePath =>
      parsePage(workshop.sources[pagePath], {
        path: pagePath,
        variables,
        pathSep,
        declared: this._declared,
        platform: this._platform?.os
      })
    );
  }

  private _onFileChanged(
    _: Contents.IManager,
    change: Contents.IChangedArgs
  ): void {
    const workshop = this._workshop;

    // Saving the manifest or a page while authoring re-renders the panel.
    if (!workshop || !this._authoring || change.type !== 'save') {
      return;
    }

    const saved = change.newValue?.path ?? '';
    const prefix = workshop.path === '' ? '' : `${workshop.path}/`;

    if (!saved.startsWith(prefix)) {
      return;
    }

    const relative = saved.slice(prefix.length);

    if (
      relative === MANIFEST_FILE ||
      workshop.manifest.pages.includes(relative)
    ) {
      void this._reloader.invoke();
    }
  }

  private _onVariablesChanged(): void {
    // While opening, the caller renders pages and writes files itself.
    if (!this._workshop || this._loading) {
      return;
    }

    this._renderPages();

    const state = this._state.state;

    if (state) {
      state.variables = this._store.persistable();
      this._state.save();
    }

    void this._envWriter.invoke();
    this._changed.emit();
  }

  private async _writeEnvFiles(): Promise<void> {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const values = this._store.values;
    const directory = PathExt.join(workshop.path, WORKSHOP_STATE_DIR);

    try {
      await writeTextFile(
        this._contents,
        PathExt.join(directory, 'env.sh'),
        renderEnvSh(values)
      );
      await writeTextFile(
        this._contents,
        PathExt.join(directory, 'env.ps1'),
        renderEnvPs1(values)
      );
      await writeTextFile(
        this._contents,
        PathExt.join(directory, 'env.cmd'),
        renderEnvCmd(values)
      );
    } catch (error) {
      console.warn('Unable to write workshop environment files', error);

      return;
    }

    // Open terminals source the files again to pick up the new values.
    this._environmentChanged.emit();
  }

  private async _ensurePlatform(): Promise<IPlatformInfo> {
    if (this._platform) {
      return this._platform;
    }

    try {
      this._platform = await this._backend.platform();
    } catch (error) {
      // Without the server extension fall back to generic values.
      console.warn(
        'Workshop server extension unavailable, assuming defaults',
        error
      );

      this._platform = {
        os: 'linux',
        shell: 'sh',
        home: '',
        user: '',
        path_sep: '/',
        root_dir: '',
        hub_user: '',
        host: 'local',
        container: false
      };
    }

    return this._platform;
  }

  private _decide(
    type: string,
    automatic: boolean,
    options: Record<string, string> = {}
  ): ActionDisposition {
    const workshop = this._workshop;
    const decision = this._decision;

    if (!workshop || !decision) {
      return { kind: 'reject', reason: 'No workshop is open' };
    }

    return decideAction({
      type,
      options,
      level: decision.level,
      automatic,
      declared: workshop.manifest.capabilities,
      allowed: decision.allowed,
      disabled: this._trustStore.policy.disabledCapabilities
    });
  }

  private async _runGated(
    registry: IActionRegistry,
    request: IActionRequest,
    trigger: ActionTrigger
  ): Promise<IActionResult> {
    const automatic = trigger === 'auto' || trigger === 'cascade';
    const disposition = this._decide(request.type, automatic, request.options);

    switch (disposition.kind) {
      case 'run':
        return registry.run(request);

      case 'reject':
        return { status: 'error', message: disposition.reason };

      case 'skip':
        return { status: 'skipped', message: disposition.reason };

      case 'downgrade': {
        const result = await registry.run({
          ...request,
          type: disposition.type
        });

        return result.status === 'ok'
          ? { ...result, message: disposition.reason }
          : result;
      }

      case 'confirm': {
        const capability = actionCapability(request.type) ?? 'none';
        const answer = await this._prompts.confirm({
          description: registry.describe(request),
          reason: disposition.reason,
          capability,
          detail: await this._confirmDetail(request),
          offerAlways: this._decision?.level === 'ask'
        });

        if (answer === 'no') {
          return { status: 'skipped', message: 'Not allowed by the learner' };
        }

        if (answer === 'always') {
          await this._allowCapability(capability);
        }

        return registry.run(request);
      }
    }
  }

  private async _confirmDetail(request: IActionRequest): Promise<string> {
    // A file write shows what will change; everything else shows its body.
    if (request.type === 'file-write' && request.options.path) {
      try {
        const target = this.resolvePath(request.options.path);
        const existing = (await readIfExists(this._contents, target)) ?? '';
        const content = request.options.from
          ? await readTextFile(
              this._contents,
              this.resolvePath(request.options.from)
            )
          : request.body;
        const next =
          request.options.mode === 'append' ? existing + content : content;

        return formatDiff(lineDiff(existing, next));
      } catch (error) {
        return `${request.body}\n\n(${errorMessage(error)})`;
      }
    }

    return request.body;
  }

  private async _allowCapability(capability: Capability): Promise<void> {
    const decision = this._decision;

    if (!decision || decision.allowed.includes(capability)) {
      return;
    }

    decision.allowed = [...decision.allowed, capability];

    await this._trustStore.set(decision);
  }

  private async _resolveTrust(
    summary: ITrustSummary
  ): Promise<ITrustDecision | null> {
    const policy = this._trustStore.policy;
    const stored = await this._trustStore.get(summary.sourceKey, summary.hash);
    const decision = (
      level: TrustLevel,
      analytics = stored?.analytics ?? false
    ): ITrustDecision => ({
      level,
      allowed: stored?.allowed ?? [],
      analytics,
      decidedAt: new Date().toISOString(),
      sourceKey: summary.sourceKey,
      hash: summary.hash,
      name: summary.name
    });

    // Administrator policy comes first, then the learner's earlier choice.
    if (policy.forcedLevel) {
      return decision(policy.forcedLevel);
    }

    if (
      policy.trustedSources.some(prefix => summary.sourceKey.startsWith(prefix))
    ) {
      return decision('trusted');
    }

    // The learner's own workshop changes with every edit; its hash is not
    // what makes it trustworthy.
    if (await this._trustStore.isAuthored(summary.sourceKey)) {
      return decision('trusted');
    }

    if (stored) {
      return stored;
    }

    const choice = await this._prompts.decide(summary, policy.defaultLevel);

    if (!choice) {
      return null;
    }

    const chosen = decision(choice.level, choice.analytics);

    await this._trustStore.set(chosen);

    return chosen;
  }

  /**
   * Archive the workshop's files as the reserved pristine checkpoint. A
   * failure is logged rather than raised: the workshop still opens, and
   * a restart then keeps the files.
   */
  private async _snapshotPristine(path: string): Promise<void> {
    try {
      await this._backend.checkpoint(path, PRISTINE_CHECKPOINT, {});
    } catch (error) {
      console.warn('Unable to snapshot the workshop files', error);
    }
  }

  private async _restoreSettings(
    changes: { plugin: string; key: string; previous?: unknown }[]
  ): Promise<void> {
    if (!this._settings) {
      return;
    }

    for (const change of changes) {
      try {
        if (change.previous === undefined) {
          await this._settings.remove(change.plugin, change.key);
        } else {
          await this._settings.set(
            change.plugin,
            change.key,
            change.previous as PartialJSONValue
          );
        }
      } catch (error) {
        console.warn(`Unable to restore ${change.plugin} ${change.key}`, error);
      }
    }
  }

  private async _saveStateDB(): Promise<void> {
    if (!this._stateDB) {
      return;
    }

    const state: IStoredState = {
      workshopPath: this._workshop ? this._workshop.path : ''
    };

    try {
      await this._stateDB.save(STATE_KEY, { ...state });
    } catch (error) {
      console.warn('Unable to save workshop state', error);
    }
  }

  private _changed = new Signal<this, void>(this);
  private _actionChanged = new Signal<this, string>(this);
  private _events = new Signal<this, IWorkshopEvent>(this);
  private _actionFocused = new Signal<this, string>(this);
  private _environmentChanged = new Signal<this, void>(this);
  private _contents: Contents.IManager;
  private _backend: IWorkshopBackend;
  private _stateDB: IStateDB | null;
  private _trustStore: ITrustStore;
  private _prompts: ITrustPrompts;
  private _settings: ISettingRegistry | null;
  private _decision: ITrustDecision | null = null;
  private _preflight: IPreflightResult[] | null = null;
  private _environment: IEnvironmentStatus | null = null;
  private _sessionId = '';
  private _finished = false;
  private _pageEnteredAt = 0;
  private _state: StateStore;
  private _store = new VariableStore();
  private _envWriter: Debouncer;
  private _reloader: Debouncer;
  private _authoring = false;
  private _features: IFeaturePolicy | null;
  private _workshop: ILoadedWorkshop | null = null;
  private _currentPageId = '';
  private _platform: IPlatformInfo | null = null;
  private _error: string | null = null;
  private _running = new Map<string, IActionStatus>();
  private _queue: IQueued[] = [];
  private _pumping = false;
  private _loading = false;
  private _declared = new Set<string>();
  private _abort: AbortController | null = null;
}

export namespace WorkshopManager {
  export interface IOptions {
    contents: Contents.IManager;

    /** Where server-side work goes: the server extension or the browser. */
    backend: IWorkshopBackend;
    stateDB: IStateDB | null;

    /** Where trust decisions and the administrator policy live. */
    trustStore: ITrustStore;

    /** Dialogs used to decide trust and confirm actions. */
    prompts: ITrustPrompts;

    /** Setting registry, used to restore settings on uninstall. */
    settings?: ISettingRegistry | null;

    /** Which features the settings disable; author mode may be one. */
    features?: IFeaturePolicy | null;
  }
}

/** Trim a workshop path and strip its surrounding slashes. */
export function normalizeWorkshopPath(path: string): string {
  return PathExt.normalize(path.trim()).replace(/^\/+|\/+$/g, '');
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyEnvironment(kernel: string): IEnvironmentStatus {
  return {
    kernel,
    ready: false,
    registered: false,
    python: '',
    requirements: '',
    stale: false,
    createdAt: '',
    log: ''
  };
}

function buildBuiltins(
  workshopPath: string,
  platform: IPlatformInfo
): Variables {
  return {
    platform: platform.os,
    shell: platform.shell,
    path_sep: platform.path_sep,
    workshop_dir: workshopPath,
    home: platform.home,
    user: platform.user,
    host: platform.host,
    container: platform.container ? 'true' : 'false'
  };
}

function isStoredState(value: unknown): value is IStoredState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IStoredState).workshopPath === 'string'
  );
}

function firstLine(text: string): string {
  const line = text.split('\n')[0];

  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
