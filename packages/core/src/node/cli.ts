/**
 * Entry point of the Node bundle the `jupyter workshop` CLI runs. It
 * speaks JSON on stdout so the Python side can format results however it
 * likes, and exits non-zero when lint finds errors.
 */

import * as fs from 'fs';

import { lintWorkshop } from '../lint/rules';
import { ILintMessage, formatLintMessage } from '../lint/types';
import { REGISTRY_SCHEMA, WORKSHOP_SCHEMA } from '../schema';
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

function usage(): string {
  return [
    'Usage: workshop-cli <command> [arguments]',
    '',
    '  lint <dir> [--json] [--platform <name>]',
    '                             Report problems in a workshop',
    '  render <dir> [page] [--out <file>] [--platform <name>]',
    '                             Render pages to standalone HTML',
    '  schema [--registry]        Print the manifest (or registry) JSON schema',
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
        const schema = flags.has('--registry')
          ? REGISTRY_SCHEMA
          : WORKSHOP_SCHEMA;

        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);

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
