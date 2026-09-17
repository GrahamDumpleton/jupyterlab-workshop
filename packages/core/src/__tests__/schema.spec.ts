import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';

import { COLLECTION_SCHEMA, EVENTS_SCHEMA, WORKSHOP_SCHEMA } from '../schema';

const EXAMPLES = path.resolve(__dirname, '../../../../examples');

const PANEL_SETTINGS = path.resolve(
  __dirname,
  '../../../labextension/schema/panel.json'
);

describe('workshop schema', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(WORKSHOP_SCHEMA);

  for (const name of fs.readdirSync(EXAMPLES)) {
    const manifest = path.join(EXAMPLES, name, 'workshop.yaml');

    if (!fs.existsSync(manifest)) {
      continue;
    }

    it(`accepts the ${name} example`, () => {
      const data = load(fs.readFileSync(manifest, 'utf8'));

      expect(validate(data)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
    });
  }

  it('rejects unknown fields and capabilities', () => {
    expect(
      validate({
        apiVersion: 'jupyterlab-workshop/v1alpha1',
        name: 'x',
        title: 'X',
        pages: ['a.md'],
        colour: 'red'
      })
    ).toBe(false);
    expect(
      validate({
        apiVersion: 'jupyterlab-workshop/v1alpha1',
        name: 'x',
        title: 'X',
        pages: ['a.md'],
        capabilities: ['teleport']
      })
    ).toBe(false);
  });

  it('knows the frontend axis and the resumable flag', () => {
    const base = {
      apiVersion: 'jupyterlab-workshop/v1alpha1',
      name: 'x',
      title: 'X',
      pages: ['a.md']
    };

    expect(
      validate({
        ...base,
        platforms: ['linux'],
        frontends: ['jupyterlab', 'jupyterlite'],
        resumable: true,
        analytics: {
          sink: 'https://a/events',
          token: 't',
          labels: { course: 'x' }
        }
      })
    ).toBe(true);
    expect(validate({ ...base, platforms: ['lite'] })).toBe(false);
    expect(validate({ ...base, frontends: ['vscode'] })).toBe(false);
  });

  it('takes strings only for version, env and action defaults', () => {
    const base = {
      apiVersion: 'jupyterlab-workshop/v1alpha1',
      name: 'x',
      title: 'X',
      pages: ['a.md']
    };

    expect(
      validate({
        ...base,
        version: '1.10',
        env: { PAGER: 'cat', RETRIES: '3' },
        defaults: { actions: { delay: '1s', scroll: 'false' } }
      })
    ).toBe(true);
    expect(validate({ ...base, version: 1.1 })).toBe(false);
    expect(validate({ ...base, env: { RETRIES: 3 } })).toBe(false);
    expect(validate({ ...base, env: { DEBUG: true } })).toBe(false);
    expect(
      validate({ ...base, defaults: { actions: { scroll: false } } })
    ).toBe(false);
  });

  it('knows tool platforms and frontends and no longer a hint', () => {
    const base = {
      apiVersion: 'jupyterlab-workshop/v1alpha1',
      name: 'x',
      title: 'X',
      pages: ['a.md']
    };
    const tools = (tool: Record<string, unknown>) => ({
      ...base,
      requires: { tools: [{ name: 'git', ...tool }] }
    });

    expect(validate(tools({ platforms: ['windows'] }))).toBe(true);
    expect(validate(tools({ frontends: ['jupyterlab'], optional: true }))).toBe(
      true
    );
    expect(validate(tools({ platforms: ['lite'] }))).toBe(false);
    expect(validate(tools({ hint: 'brew install git' }))).toBe(false);
    expect(validate(tools({ hint: { macos: 'brew install git' } }))).toBe(
      false
    );
  });

  it('takes variants of env and defaults keyed by marker name', () => {
    const base = {
      apiVersion: 'jupyterlab-workshop/v1alpha1',
      name: 'x',
      title: 'X',
      pages: ['a.md']
    };

    expect(
      validate({
        ...base,
        variants: {
          windows: { env: { PAGER: 'more' } },
          jupyterlite: { defaults: { actions: { timeout: '5m' } } }
        }
      })
    ).toBe(true);
    expect(validate({ ...base, variants: { lite: { env: {} } } })).toBe(false);
    expect(
      validate({ ...base, variants: { windows: { requires: { shell: 'x' } } } })
    ).toBe(false);
    expect(
      validate({ ...base, variants: { windows: { env: { RETRIES: 3 } } } })
    ).toBe(false);
    expect(
      validate({
        ...base,
        analytics: { sink: 'https://a', labels: { A: 'x' } }
      })
    ).toBe(false);
  });
});

describe('the shared analytics definition', () => {
  const definition = (WORKSHOP_SCHEMA.definitions as Record<string, unknown>)
    .analytics;

  it('is the same in the collection schema', () => {
    const collection = (
      COLLECTION_SCHEMA.definitions as Record<string, unknown>
    ).analytics;

    expect(collection).toEqual(definition);
  });

  it('is what the settings schema declares, plus identity', () => {
    const panel = JSON.parse(fs.readFileSync(PANEL_SETTINGS, 'utf8')) as {
      properties: {
        analytics: { properties: Record<string, Record<string, unknown>> };
      };
    };
    const shared = (definition as { properties: Record<string, unknown> })
      .properties;
    const settings = panel.properties.analytics.properties;

    expect(Object.keys(settings)).toEqual([
      'sink',
      'token',
      'labels',
      'identity'
    ]);

    // The settings editor needs titles and defaults the shared definition
    // has no use for, so the comparison is of what constrains a value.
    for (const key of ['sink', 'token', 'labels']) {
      const { title, default: _default, description, ...rest } = settings[key];
      const {
        pattern: _pattern,
        minLength: _minLength,
        description: sharedDescription,
        ...sharedRest
      } = shared[key] as Record<string, unknown>;

      expect(typeof title).toBe('string');
      expect(String(description)).toContain(String(sharedDescription));
      expect(rest).toEqual(sharedRest);
    }
  });
});

describe('events schema', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });

  addFormats(ajv);

  const validate = ajv.compile(EVENTS_SCHEMA);
  const kinds = (
    EVENTS_SCHEMA.definitions as { kinds: Record<string, unknown> }
  ).kinds;
  const base = {
    ts: '2026-09-15T10:00:00.000Z',
    session_id: 'mfx1-abc',
    instance_id: 'i-1',
    workshop: 'workshops/git-basics',
    name: 'git-basics',
    version: '1.2.0',
    source: 'local:workshops/git-basics',
    collection: 'https://example.org/collection.json',
    seq: 1,
    labels: { course: 'intro' },
    frontend: 'jupyterlab',
    frontend_version: '0.2.0',
    host: 'binder',
    platform: 'linux',
    trust: 'trusted'
  };
  const page = { id: '01-init', path: 'pages/01-init.md', title: 'Init' };
  const listed = {
    ...page,
    directives: [
      { id: '01-init-1', type: 'execute', trigger: 'click' },
      { id: 'check', type: 'verify', trigger: 'trigger', conditional: true }
    ]
  };
  const samples: Record<string, Record<string, unknown>> = {
    'workshop-start': {
      page: '01-init',
      pages: [listed],
      restarted_from: 'old'
    },
    'workshop-resume': { page: '01-init', pages: [page], resumed_from: 'old' },
    'workshop-finish': { pages: 3 },
    'workshop-abandon': { page: '01-init' },
    'page-enter': { page: '01-init' },
    'page-leave': { page: '01-init', active_ms: 1200 },
    heartbeat: { page: '01-init', hidden: false },
    'gate-skipped': { page: '01-init', requirements: ['verify:check'] },
    'action-executed': {
      id: 'a',
      type: 'execute',
      status: 'ok',
      trigger: 'click',
      downgraded: false
    },
    'verify-result': { id: 'v', status: 'ok', attempt: 1, trigger: 'click' },
    'quiz-answered': { id: 'q', correct: true, attempt: 2 },
    'form-submitted': { id: 'f', fields: ['name'] },
    'hint-opened': { id: 'h' },
    'checkpoint-restored': { name: 'start' },
    'preflight-result': {
      tools: [{ name: 'git', found: true, satisfied: true, version: '2.4' }]
    },
    'environment-created': { kernel: 'workshop-x' }
  };

  it('describes every kind the extension emits', () => {
    expect(Object.keys(kinds).sort()).toEqual(Object.keys(samples).sort());
  });

  for (const [kind, extra] of Object.entries(samples)) {
    it(`accepts a ${kind} event`, () => {
      const event = { ...base, kind, ...extra };
      const validateKind = ajv.compile({
        ...(kinds[kind] as Record<string, unknown>),
        definitions: EVENTS_SCHEMA.definitions
      });

      expect(validate(event)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
      expect(validateKind(event)).toBe(true);
      expect(validateKind.errors ?? []).toEqual([]);
    });
  }

  it('keeps the open fields as plain strings and pins the shapes', () => {
    const properties = EVENTS_SCHEMA.properties as Record<
      string,
      Record<string, unknown>
    >;

    for (const field of ['frontend', 'host', 'platform', 'kind']) {
      expect(properties[field].type).toBe('string');
      expect(properties[field].enum).toBeUndefined();
    }

    expect(validate({ ...base, kind: 'page-enter', page: 'x', seq: 0 })).toBe(
      false
    );
    expect(
      validate({ ...base, kind: 'page-enter', page: 'x', version: 1 })
    ).toBe(false);
    expect(
      validate({ ...base, kind: 'page-enter', page: 'x', labels: { A: 'x' } })
    ).toBe(false);
    expect(validate({ ...base, kind: 'something-new' })).toBe(true);
    expect(JSON.stringify(EVENTS_SCHEMA)).not.toMatch(/"oneOf"|"anyOf"/);
  });
});
