import { IVariableDefinition, Variables } from '@jupyterlab-workshop/core';
import { ISignal, Signal } from '@lumino/signaling';

import { IVariableEntry, IVariableStore, VariableSource } from './tokens';

/** Sources in precedence order, lowest first. */
const PRECEDENCE: readonly VariableSource[] = [
  'builtin',
  'manifest',
  'override',
  'form',
  'capture',
  'manual'
];

/** Sources a learner can clear with reset. */
const LEARNER_SOURCES: readonly VariableSource[] = [
  'form',
  'capture',
  'manual'
];

interface IRecord {
  values: Partial<Record<VariableSource, string>>;
  definition: IVariableDefinition | null;
}

/**
 * Ordered store of workshop variables with per-source values.
 *
 * Each variable keeps one value per source and reports the value from the
 * highest precedence source present, so a learner's manual edit wins over
 * a captured value, which wins over a manifest default.
 */
export class VariableStore implements IVariableStore {
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get values(): Variables {
    const values: Variables = {};

    for (const [name, record] of this._records) {
      const value = effective(record);

      if (value !== undefined) {
        values[name] = value;
      }
    }

    return values;
  }

  /**
   * Replace all contents: built-ins, manifest definitions and any values
   * restored from saved state. Emits a single change.
   */
  load(
    builtins: Variables,
    definitions: IVariableDefinition[],
    restored: Record<string, { value: string; source: VariableSource }> = {}
  ): void {
    this._records.clear();

    for (const [name, value] of Object.entries(builtins)) {
      this._records.set(name, { values: { builtin: value }, definition: null });
    }

    for (const definition of definitions) {
      const record = this._record(definition.name);

      record.definition = definition;

      if (definition.default !== undefined) {
        record.values.manifest = definition.default;
      }
    }

    for (const [name, { value, source }] of Object.entries(restored)) {
      this._record(name).values[source] = value;
    }

    this._changed.emit();
  }

  entries(): IVariableEntry[] {
    const entries: IVariableEntry[] = [];

    for (const [name, record] of this._records) {
      const value = effective(record);
      const definition = record.definition;

      entries.push({
        name,
        value: value ?? '',
        source: effectiveSource(record) ?? 'manifest',
        definition,
        secret: definition?.secret ?? false,
        readonly:
          (definition?.readonly ?? false) || record.values.builtin !== undefined
      });
    }

    return entries;
  }

  get(name: string): string | undefined {
    const record = this._records.get(name);

    return record ? effective(record) : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  set(name: string, value: string, source: VariableSource = 'manual'): void {
    const record = this._record(name);

    if (record.values[source] === value) {
      return;
    }

    record.values[source] = value;
    this._changed.emit();
  }

  reset(name: string): void {
    const record = this._records.get(name);

    if (!record) {
      return;
    }

    let changed = false;

    for (const source of LEARNER_SOURCES) {
      if (record.values[source] !== undefined) {
        delete record.values[source];
        changed = true;
      }
    }

    if (changed) {
      this._changed.emit();
    }
  }

  /**
   * Learner-provided values worth persisting, excluding secrets.
   */
  persistable(): Record<string, { value: string; source: VariableSource }> {
    const result: Record<string, { value: string; source: VariableSource }> =
      {};

    for (const [name, record] of this._records) {
      if (record.definition?.secret) {
        continue;
      }

      for (const source of LEARNER_SOURCES) {
        const value = record.values[source];

        if (value !== undefined) {
          result[name] = { value, source };
        }
      }
    }

    return result;
  }

  private _record(name: string): IRecord {
    let record = this._records.get(name);

    if (!record) {
      record = { values: {}, definition: null };
      this._records.set(name, record);
    }

    return record;
  }

  private _records = new Map<string, IRecord>();
  private _changed = new Signal<this, void>(this);
}

function effectiveSource(record: IRecord): VariableSource | undefined {
  for (let index = PRECEDENCE.length - 1; index >= 0; index -= 1) {
    if (record.values[PRECEDENCE[index]] !== undefined) {
      return PRECEDENCE[index];
    }
  }

  return undefined;
}

function effective(record: IRecord): string | undefined {
  const source = effectiveSource(record);

  return source === undefined ? undefined : record.values[source];
}
