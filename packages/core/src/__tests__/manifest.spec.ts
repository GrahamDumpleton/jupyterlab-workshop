import { WorkshopFormatError } from '../errors';
import { parseManifest } from '../format/manifest';

const VALID = `
apiVersion: workshop.educates.dev/v1alpha1
name: git-basics
title: Git from the command line
version: 1.2.0
tags: [git, cli]
pages:
  - pages/01-init.md
variables:
  - { name: repo_dir, type: path, default: demo }
`;

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const manifest = parseManifest(VALID);

    expect(manifest.name).toBe('git-basics');
    expect(manifest.title).toBe('Git from the command line');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.tags).toEqual(['git', 'cli']);
    expect(manifest.authors).toEqual([]);
    expect(manifest.pages).toEqual(['pages/01-init.md']);
    expect(manifest.variables).toEqual([
      {
        name: 'repo_dir',
        type: 'path',
        description: undefined,
        default: 'demo',
        required: false,
        readonly: false
      }
    ]);
  });

  it('rejects missing or invalid fields', () => {
    expect(() => parseManifest('name: x')).toThrow(WorkshopFormatError);
    expect(() => parseManifest(VALID.replace('v1alpha1', 'v9'))).toThrow(
      /Unsupported apiVersion/
    );
    expect(() =>
      parseManifest(VALID.replace('git-basics', 'Git Basics'))
    ).toThrow(/Invalid name/);
    expect(() =>
      parseManifest(VALID.replace('  - pages/01-init.md\n', ''))
    ).toThrow(/pages/);
  });
});
