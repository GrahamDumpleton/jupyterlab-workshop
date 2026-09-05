import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';
import { load } from 'js-yaml';

import { WORKSHOP_SCHEMA } from '../schema';

const EXAMPLES = path.resolve(__dirname, '../../../../examples');

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
});
