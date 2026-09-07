/**
 * Entry point of the Node bundle the `jupyter workshop` CLI runs. It
 * speaks JSON on stdout so the Python side can format results however it
 * likes, and exits non-zero when lint finds errors.
 */

import * as fs from 'fs';

import { parseCatalog } from '../catalog';
import { parseCollectionIndex } from '../collection';
import { lintWorkshop } from '../lint/rules';
import { ILintMessage, formatLintMessage } from '../lint/types';
import { CATALOG_SCHEMA, COLLECTION_SCHEMA, WORKSHOP_SCHEMA } from '../schema';
import { draftToDirectory } from './draft';
import { renderWorkshopHtml } from './render';
import { ILoadOptions, loadWorkshopFiles } from './workshop';

/** The lint report the CLI prints as JSON. */
export interface ILintReport {
  directory: string;
  platform: string;
  messages: ILintMessage[];
  errors: number;
  warnings: number;
}

/**
 * Lint a workshop directory.
 */
export function lintDirectory(
  directory: string,
  options: ILoadOptions = {}
): ILintReport {
  const workshop = loadWorkshopFiles(directory, options);
  const messages = lintWorkshop({
    manifest: workshop.manifest,
    pages: workshop.pages
  });

  return {
    directory,
    platform: workshop.platform,
    messages,
    errors: messages.filter(message => message.level === 'error').length,
    warnings: messages.filter(message => message.level === 'warning').length
  };
}

/** What `check` reports about a collection or catalog file. */
export interface ICheckReport {
  file: string;
  kind: 'collection' | 'catalog';
  title: string;

  /** Workshops of a collection, or collections of a catalog. */
  entries: number;

  /** The locations a catalog names, as written, for the caller to resolve. */
  locations: string[];
}

/**
 * Parse a collection or catalog file, telling the two apart by their
 * lists, and report what it holds. A malformed file throws with the
 * parser's message.
 */
export function checkIndexFile(file: string): ICheckReport {
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};

  if (Array.isArray(record.collections)) {
    const catalog = parseCatalog(data);

    return {
      file,
      kind: 'catalog',
      title: catalog.title ?? '',
      entries: catalog.collections.length,
      locations: catalog.collections.map(entry => entry.url)
    };
  }

  const collection = parseCollectionIndex(data);

  return {
    file,
    kind: 'collection',
    title: collection.title ?? '',
    entries: collection.workshops.length,
    locations: []
  };
}

function usage(): string {
  return [
    'Usage: workshop-cli <command> [arguments]',
    '',
    '  lint <dir> [--json] [--platform <name>]',
    '                             Report problems in a workshop',
    '  render <dir> [page] [--out <file>] [--platform <name>]',
    '                             Render pages to standalone HTML',
    '  schema [--collection|--catalog]',
    '                             Print the manifest, collection or catalog JSON schema',
    '  check <file.json>          Validate a collection or catalog file, as JSON',
    '  pages <dir>                List page ids and titles as JSON',
    '  draft <recording> <dir> [--name <name>] [--title <title>] [--json]',
    '                             Write draft pages from a recorded session'
  ].join('\n');
}

/**
 * Run the CLI with process-style arguments (without node and the script).
 */
export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const out = valueOf(rest, '--out');
  const platform = valueOf(rest, '--platform');
  const valued = ['--out', '--platform', '--name', '--title'];
  const positional = rest.filter(
    (arg, index) => !arg.startsWith('--') && !valued.includes(rest[index - 1])
  );
  const options: ILoadOptions = { platform };

  try {
    switch (command) {
      case 'lint': {
        if (!positional[0]) {
          throw new Error('lint needs a workshop directory');
        }

        const report = lintDirectory(positional[0], options);

        if (flags.has('--json')) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          for (const message of report.messages) {
            process.stdout.write(`${formatLintMessage(message)}\n`);
          }

          process.stdout.write(
            `${report.errors} error(s), ${report.warnings} warning(s)\n`
          );
        }

        return report.errors > 0 ? 1 : 0;
      }

      case 'render': {
        if (!positional[0]) {
          throw new Error('render needs a workshop directory');
        }

        const html = renderWorkshopHtml(
          loadWorkshopFiles(positional[0], options),
          positional[1]
        );

        if (out) {
          fs.writeFileSync(out, html);
        } else {
          process.stdout.write(html);
        }

        return 0;
      }

      case 'schema': {
        const schema = flags.has('--collection')
          ? COLLECTION_SCHEMA
          : flags.has('--catalog')
            ? CATALOG_SCHEMA
            : WORKSHOP_SCHEMA;

        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);

        return 0;
      }

      case 'check': {
        if (!positional[0]) {
          throw new Error('check needs a collection or catalog file');
        }

        const report = checkIndexFile(positional[0]);

        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

        return 0;
      }

      case 'pages': {
        if (!positional[0]) {
          throw new Error('pages needs a workshop directory');
        }

        const workshop = loadWorkshopFiles(positional[0], options);

        process.stdout.write(
          `${JSON.stringify(
            workshop.pages.map(page => ({
              id: page.id,
              path: page.path,
              title: page.title,
              requires: page.frontmatter.requires
            })),
            null,
            2
          )}\n`
        );

        return 0;
      }

      case 'draft': {
        if (!positional[0] || !positional[1]) {
          throw new Error('draft needs a recording file and a directory');
        }

        const report = draftToDirectory(positional[0], positional[1], {
          name: valueOf(rest, '--name'),
          title: valueOf(rest, '--title')
        });

        if (flags.has('--json')) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          for (const file of report.files) {
            process.stdout.write(`wrote ${report.directory}/${file}\n`);
          }
        }

        return 0;
      }

      default:
        process.stderr.write(`${usage()}\n`);

        return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (flags.has('--json')) {
      process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    } else {
      process.stderr.write(`error: ${message}\n`);
    }

    return 2;
  }
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);

  return index >= 0 ? args[index + 1] : undefined;
}
