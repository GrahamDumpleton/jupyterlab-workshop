import { TRUST_LEVELS, TrustLevel } from '@jupyterlab-workshop/core';
import { IStateDB } from '@jupyterlab/statedb';
import { ReadonlyPartialJSONValue } from '@lumino/coreutils';

import { fetchForServer, saveForServer } from '../statedb';
import { ITrustDecision, ITrustPolicy, ITrustStore } from '../tokens';

const DECISIONS_KEY = '@jupyterlab-workshop/labextension:trust';

const AUTHORED_KEY = '@jupyterlab-workshop/labextension:authored';

/** The policy applied when settings are unavailable. */
export const DEFAULT_POLICY: ITrustPolicy = {
  defaultLevel: 'restricted',
  forcedLevel: null,
  trustedSources: [],
  disabledCapabilities: [],
  analyticsSink: '',
  analyticsIdentity: 'none'
};

interface IStoredDecisions {
  decisions: Record<string, ITrustDecision>;
}

/**
 * Trust decisions keyed by source and hash, persisted in the state
 * database so they survive reloads.
 *
 * Decisions and the authored list are kept per server: a local source key
 * is a path relative to the server root, so a workshop marked as the
 * user's own under one root must not be trusted at the same path under
 * another.
 */
export class TrustStore implements ITrustStore {
  constructor(stateDB: IStateDB | null) {
    this._stateDB = stateDB;
  }

  get policy(): ITrustPolicy {
    return this._policy;
  }

  set policy(value: ITrustPolicy) {
    this._policy = value;
  }

  async get(sourceKey: string, hash: string): Promise<ITrustDecision | null> {
    const decisions = await this._load();

    return decisions[decisionKey(sourceKey, hash)] ?? null;
  }

  async set(decision: ITrustDecision): Promise<void> {
    const decisions = await this._load();

    decisions[decisionKey(decision.sourceKey, decision.hash)] = decision;

    await this._save(decisions);
  }

  async forget(sourceKey: string): Promise<void> {
    const decisions = await this._load();

    for (const key of Object.keys(decisions)) {
      if (decisions[key].sourceKey === sourceKey) {
        delete decisions[key];
      }
    }

    await this._save(decisions);
    await this.setAuthored(sourceKey, false);
  }

  async isAuthored(sourceKey: string): Promise<boolean> {
    const authored = await this._loadAuthored();

    return authored.includes(sourceKey);
  }

  async setAuthored(sourceKey: string, authored: boolean): Promise<void> {
    const current = await this._loadAuthored();
    const next = current.filter(key => key !== sourceKey);

    if (authored) {
      next.push(sourceKey);
    }

    this._authored = next;

    if (!this._stateDB) {
      return;
    }

    try {
      await saveForServer(this._stateDB, AUTHORED_KEY, { authored: next });
    } catch (error) {
      console.warn('Unable to save the authored workshops', error);
    }
  }

  private async _loadAuthored(): Promise<string[]> {
    if (this._authored) {
      return this._authored;
    }

    this._authored = [];

    if (this._stateDB) {
      try {
        const stored = await fetchForServer(this._stateDB, AUTHORED_KEY);
        const list = (stored as { authored?: unknown } | undefined)?.authored;

        if (Array.isArray(list)) {
          this._authored = list.filter(
            (item): item is string => typeof item === 'string'
          );
        }
      } catch (error) {
        console.warn('Unable to read the authored workshops', error);
      }
    }

    return this._authored;
  }

  private async _load(): Promise<Record<string, ITrustDecision>> {
    if (this._cache) {
      return this._cache;
    }

    this._cache = {};

    if (this._stateDB) {
      try {
        const stored = await fetchForServer(this._stateDB, DECISIONS_KEY);

        if (isStoredDecisions(stored)) {
          this._cache = stored.decisions;
        }
      } catch (error) {
        console.warn('Unable to read workshop trust decisions', error);
      }
    }

    return this._cache;
  }

  private async _save(
    decisions: Record<string, ITrustDecision>
  ): Promise<void> {
    this._cache = decisions;

    if (!this._stateDB) {
      return;
    }

    try {
      const value: IStoredDecisions = { decisions };

      await saveForServer(
        this._stateDB,
        DECISIONS_KEY,
        value as unknown as ReadonlyPartialJSONValue
      );
    } catch (error) {
      console.warn('Unable to save workshop trust decisions', error);
    }
  }

  private _stateDB: IStateDB | null;
  private _policy: ITrustPolicy = DEFAULT_POLICY;
  private _cache: Record<string, ITrustDecision> | null = null;
  private _authored: string[] | null = null;
}

function decisionKey(sourceKey: string, hash: string): string {
  return `${sourceKey}#${hash}`;
}

function isStoredDecisions(value: unknown): value is IStoredDecisions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const decisions = (value as { decisions?: unknown }).decisions;

  return typeof decisions === 'object' && decisions !== null;
}

/**
 * Read a trust level from an unknown value, or return null.
 */
export function asTrustLevel(value: unknown): TrustLevel | null {
  return typeof value === 'string' && (TRUST_LEVELS as string[]).includes(value)
    ? (value as TrustLevel)
    : null;
}

/**
 * Build the policy from the raw settings values.
 */
export function policyFromSettings(values: {
  defaultTrustLevel?: unknown;
  trustPolicy?: unknown;
  analytics?: unknown;
}): ITrustPolicy {
  const raw =
    typeof values.trustPolicy === 'object' && values.trustPolicy !== null
      ? (values.trustPolicy as Record<string, unknown>)
      : {};
  const analytics =
    typeof values.analytics === 'object' && values.analytics !== null
      ? (values.analytics as Record<string, unknown>)
      : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];

  return {
    defaultLevel:
      asTrustLevel(values.defaultTrustLevel) ?? DEFAULT_POLICY.defaultLevel,
    forcedLevel: asTrustLevel(raw.forcedLevel),
    trustedSources: strings(raw.trustedSources),
    disabledCapabilities: strings(raw.disabledCapabilities),
    analyticsSink:
      typeof analytics.sink === 'string' && /^https?:\/\//.test(analytics.sink)
        ? analytics.sink
        : '',
    analyticsIdentity: analytics.identity === 'hub' ? 'hub' : 'none'
  };
}
