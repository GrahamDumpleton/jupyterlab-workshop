/**
 * Entry point of the Node bundle the `jupyter workshop` CLI runs. It
 * speaks JSON on stdout so the Python side can format results however it
 * likes, and exits non-zero when lint finds errors.
 */

import * as fs from 'fs';

import { lintWorkshop } from '../lint/rules';
import { ILintMessage, formatLintMessage } from '../lint/types';
import { WORKSHOP_SCHEMA } from '../schema';
import { renderWorkshopHtml } from './render';
import { loadWorkshopFiles } from './workshop';

/** The lint report the CLI prints as JSON. */
export interface ILintReport {
  directory: string;
  messages: ILintMessage[];
  errors: number;
  warnings: number;
}

/**
 * Lint a workshop directory.
 */
export function lintDirectory(directory: string): ILintReport {
  const workshop = loadWorkshopFiles(directory);
  const messages = lintWorkshop({
    manifest: workshop.manifest,
    pages: workshop.pages
  });

  return {
    directory,
    messages,
    errors: messages.filter(message => message.level === 'error').length,
    warnings: messages.filter(message => message.level === 'warning').length
  };
}

function usage(): string {
  return [
    'Usage: workshop-cli <command> [arguments]',
    '',
    '  lint <dir> [--json]        Report problems in a workshop',
    '  render <dir> [page] [--out <file>]',
    '                             Render pages to standalone HTML',
    '  schema                     Print the manifest JSON schema',
    '  pages <dir>                List page ids and titles as JSON'
  ].join('\n');
}

/**
 * Run the CLI with process-style arguments (without node and the script).
 */
export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  const outIndex = rest.indexOf('--out');
  const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;

  try {
    switch (command) {
      case 'lint': {
        if (!positional[0]) {
          throw new Error('lint needs a workshop directory');
        }

        const report = lintDirectory(positional[0]);

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
          loadWorkshopFiles(positional[0]),
          positional[1] === out ? undefined : positional[1]
        );

        if (out) {
          fs.writeFileSync(out, html);
        } else {
          process.stdout.write(html);
        }

        return 0;
      }

      case 'schema':
        process.stdout.write(`${JSON.stringify(WORKSHOP_SCHEMA, null, 2)}\n`);

        return 0;

      case 'pages': {
        if (!positional[0]) {
          throw new Error('pages needs a workshop directory');
        }

        const workshop = loadWorkshopFiles(positional[0]);

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
