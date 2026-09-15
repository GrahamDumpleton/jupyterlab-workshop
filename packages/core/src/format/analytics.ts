/**
 * The `analytics` block: where progress events are reported, the token
 * they are posted with and the labels stamped on them. The same block
 * appears in a workshop manifest, in a collection index and in the
 * extension's settings, so its shape and its rules live in one place.
 */

import { isRecord } from '../util';

/** Where progress events are reported, and how they are labelled. */
export interface IAnalyticsBlock {
  /** URL that receives batches of events as JSON lines by POST. */
  sink?: string;

  /** Token sent as a bearer credential with every batch; opaque here. */
  token?: string;

  /** Key and value pairs stamped on every event for slicing reports. */
  labels: Record<string, string>;
}

/** What a label key may look like. */
export const LABEL_KEY_PATTERN = /^[a-z0-9_.-]+$/;

/** Longest label key accepted. */
export const MAX_LABEL_KEY_LENGTH = 63;

/** Longest label value accepted. */
export const MAX_LABEL_VALUE_LENGTH = 128;

/** Most labels one block may declare. */
export const MAX_LABELS = 16;

/**
 * The problems with a set of labels, as messages; none for a valid set.
 * Keys are lower case letters, digits, underscore, dot and hyphen up to
 * 63 characters, values are strings up to 128 characters, and a block
 * carries at most 16 of them.
 */
export function labelProblems(labels: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const keys = Object.keys(labels);

  if (keys.length > MAX_LABELS) {
    problems.push(
      `at most ${MAX_LABELS} labels are allowed, not ${keys.length}`
    );
  }

  for (const key of keys) {
    const value = labels[key];

    if (!LABEL_KEY_PATTERN.test(key) || key.length > MAX_LABEL_KEY_LENGTH) {
      problems.push(
        `label key "${key}" must be lower case letters, digits, underscore, dot or hyphen, up to ${MAX_LABEL_KEY_LENGTH} characters`
      );
    }

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      problems.push(`label "${key}" must have a string value`);
    } else if (String(value).length > MAX_LABEL_VALUE_LENGTH) {
      problems.push(
        `label "${key}" has a value longer than ${MAX_LABEL_VALUE_LENGTH} characters`
      );
    }
  }

  return problems;
}

/**
 * Parse an `analytics` block from a manifest, index or settings value.
 * Returns undefined for an absent block and throws an `Error` naming the
 * problem for a malformed one; callers wrap the error as they see fit.
 * A block with no sink is accepted, since labels alone are meaningful
 * once a sink is supplied by another level.
 */
export function parseAnalyticsBlock(
  value: unknown
): IAnalyticsBlock | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error('Field "analytics" must be a mapping');
  }

  const block: IAnalyticsBlock = { labels: {} };

  if (value.sink !== undefined && value.sink !== null) {
    if (typeof value.sink !== 'string' || !/^https?:\/\//.test(value.sink)) {
      throw new Error('Field "analytics.sink" must be an http or https URL');
    }

    block.sink = value.sink;
  }

  if (value.token !== undefined && value.token !== null) {
    if (typeof value.token !== 'string' || value.token === '') {
      throw new Error('Field "analytics.token" must be a non-empty string');
    }

    block.token = value.token;
  }

  if (value.labels !== undefined && value.labels !== null) {
    if (!isRecord(value.labels)) {
      throw new Error('Field "analytics.labels" must be a mapping of strings');
    }

    const problems = labelProblems(value.labels);

    if (problems.length > 0) {
      throw new Error(`Field "analytics.labels": ${problems.join('; ')}`);
    }

    for (const [key, label] of Object.entries(value.labels)) {
      block.labels[key] = String(label);
    }
  }

  return block;
}
