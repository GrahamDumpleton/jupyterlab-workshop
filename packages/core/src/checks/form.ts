import { load } from 'js-yaml';

import { VariableType } from '../format/manifest';
import { isRecord } from '../util';

/** One field of a form. */
export interface IFormField {
  name: string;
  type: VariableType;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  default?: string;
  pattern?: string;
  min?: number;
  max?: number;
  options: string[];

  /** Whether choosing a value also chooses the track. */
  setTrack: boolean;
}

/** A parsed form. */
export interface IFormSpec {
  fields: IFormField[];
}

/** The parsed form, or the reasons it could not be parsed. */
export interface IParsedForm {
  form: IFormSpec | null;
  errors: string[];
}

const FIELD_TYPES: readonly VariableType[] = [
  'text',
  'number',
  'boolean',
  'select',
  'multiselect',
  'secret',
  'path',
  'url',
  'email'
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the YAML body of a `form` directive: either a mapping with a
 * `fields` list or the list itself.
 */
export function parseForm(body: string): IParsedForm {
  const errors: string[] = [];
  let data: unknown;

  try {
    data = load(body);
  } catch (error) {
    return { form: null, errors: [`Invalid YAML: ${String(error)}`] };
  }

  const list = isRecord(data) ? data.fields : data;

  if (!Array.isArray(list) || list.length === 0) {
    return { form: null, errors: ['The form needs a list of fields'] };
  }

  const fields: IFormField[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== 'string') {
      errors.push('Each field needs a "name"');

      continue;
    }

    const name = item.name;

    if (!NAME.test(name)) {
      errors.push(`Invalid field name "${name}"`);

      continue;
    }

    if (seen.has(name)) {
      errors.push(`Field "${name}" is listed twice`);

      continue;
    }

    seen.add(name);

    const type = typeof item.type === 'string' ? item.type : 'text';

    if (!(FIELD_TYPES as string[]).includes(type)) {
      errors.push(`Field "${name}" has unknown type "${type}"`);

      continue;
    }

    const options = Array.isArray(item.options) ? item.options.map(String) : [];

    if ((type === 'select' || type === 'multiselect') && options.length === 0) {
      errors.push(`Field "${name}" needs "options"`);

      continue;
    }

    const pattern = typeof item.pattern === 'string' ? item.pattern : undefined;

    if (pattern !== undefined) {
      try {
        new RegExp(pattern);
      } catch {
        errors.push(`Field "${name}" has an invalid pattern`);

        continue;
      }
    }

    fields.push({
      name,
      type: type as VariableType,
      label: typeof item.label === 'string' ? item.label : name,
      description:
        typeof item.description === 'string' ? item.description : undefined,
      placeholder:
        typeof item.placeholder === 'string' ? item.placeholder : undefined,
      required: item.required === true,
      default:
        item.default === undefined || item.default === null
          ? undefined
          : String(item.default),
      pattern,
      min: typeof item.min === 'number' ? item.min : undefined,
      max: typeof item.max === 'number' ? item.max : undefined,
      options,
      setTrack: item.set_track === true
    });
  }

  return { form: errors.length > 0 ? null : { fields }, errors };
}

/**
 * Validate submitted values, returning a message per field with a problem.
 */
export function validateForm(
  form: IFormSpec,
  values: Record<string, string>
): Record<string, string> {
  const problems: Record<string, string> = {};

  for (const field of form.fields) {
    const value = (values[field.name] ?? '').trim();
    const problem = validateField(field, value);

    if (problem) {
      problems[field.name] = problem;
    }
  }

  return problems;
}

function validateField(field: IFormField, value: string): string | null {
  if (value === '') {
    return field.required ? 'This field is required' : null;
  }

  switch (field.type) {
    case 'number': {
      const number = Number(value);

      if (Number.isNaN(number)) {
        return 'Enter a number';
      }

      if (field.min !== undefined && number < field.min) {
        return `Enter a number of at least ${field.min}`;
      }

      if (field.max !== undefined && number > field.max) {
        return `Enter a number of at most ${field.max}`;
      }

      break;
    }

    case 'boolean':
      if (value !== 'true' && value !== 'false') {
        return 'Enter true or false';
      }

      break;

    case 'select':
      if (!field.options.includes(value)) {
        return 'Choose one of the options';
      }

      break;

    case 'multiselect':
      for (const item of value.split(',')) {
        if (!field.options.includes(item.trim())) {
          return 'Choose from the options';
        }
      }

      break;

    case 'url':
      if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) {
        return 'Enter a URL';
      }

      break;

    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return 'Enter an email address';
      }

      break;

    default:
      break;
  }

  if (
    field.min !== undefined &&
    field.type !== 'number' &&
    value.length < field.min
  ) {
    return `Enter at least ${field.min} characters`;
  }

  if (
    field.max !== undefined &&
    field.type !== 'number' &&
    value.length > field.max
  ) {
    return `Enter at most ${field.max} characters`;
  }

  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
    return 'The value does not have the expected form';
  }

  return null;
}
