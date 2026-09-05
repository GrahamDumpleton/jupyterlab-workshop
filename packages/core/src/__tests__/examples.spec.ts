import * as fs from 'fs';
import * as path from 'path';

import { parseManifest } from '../format/manifest';
import { parsePage } from '../format/page';
import { lintWorkshop } from '../lint/rules';

const EXAMPLES = path.resolve(__dirname, '../../../../examples');

describe('example workshops', () => {
  for (const name of fs.readdirSync(EXAMPLES)) {
    const directory = path.join(EXAMPLES, name);
    const manifestPath = path.join(directory, 'workshop.yaml');

    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    it(`${name} lints without errors`, () => {
      const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
      const pages = manifest.pages.map(pagePath =>
        parsePage(fs.readFileSync(path.join(directory, pagePath), 'utf8'), {
          path: pagePath,
          variables: {}
        })
      );
      const messages = lintWorkshop({ manifest, pages });

      expect(messages.filter(message => message.level === 'error')).toEqual([]);
    });
  }
});
