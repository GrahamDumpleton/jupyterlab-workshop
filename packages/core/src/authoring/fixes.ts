/**
 * Quick fixes: apply the mechanical change a lint finding suggests to
 * the manifest or a page, returning the new file content.
 */

import { ILintMessage } from '../lint/types';
import { directiveExtent } from './directive';
import { addManifestCapability, removeManifestCapability } from './manifest';

/** The files a fix may change. */
export interface IFixableFiles {
  /** Path of the manifest, `workshop.yaml` by default. */
  manifestPath?: string;
  manifest: string;

  /** Page sources keyed by path. */
  pages: Record<string, string>;
}

/** One file rewritten by a fix. */
export interface IFileEdit {
  path: string;
  source: string;
  description: string;
}

/**
 * Whether a finding has a fix that can be applied.
 */
export function hasFix(message: ILintMessage): boolean {
  return message.fix !== undefined;
}

/**
 * Apply the fix of a finding, or return null when it has none or the
 * file it refers to is not available.
 */
export function applyFix(
  message: ILintMessage,
  files: IFixableFiles
): IFileEdit | null {
  const fix = message.fix;

  if (!fix) {
    return null;
  }

  const manifestPath = files.manifestPath ?? 'workshop.yaml';

  switch (fix.kind) {
    case 'add-capability':
      return {
        path: manifestPath,
        source: addManifestCapability(files.manifest, fix.capability),
        description: `Declare the ${fix.capability} capability`
      };

    case 'remove-capability':
      return {
        path: manifestPath,
        source: removeManifestCapability(files.manifest, fix.capability),
        description: `Remove the ${fix.capability} capability`
      };

    case 'remove-option': {
      const path = message.path ?? '';
      const source = files.pages[path];

      if (source === undefined || !message.line) {
        return null;
      }

      const edited = removeOptionLine(source, message.line, fix.option);

      return edited === null
        ? null
        : {
            path,
            source: edited,
            description: `Remove the ${fix.option} option`
          };
    }
  }
}

function removeOptionLine(
  source: string,
  line: number,
  option: string
): string | null {
  const extent = directiveExtent(source, line);

  if (!extent) {
    return null;
  }

  // Options are the leading `:name:` lines of the block.
  const lines = source.split('\n');
  const pattern = new RegExp(`^:${option}:(\\s|$)`);

  for (let index = extent.start; index < extent.end - 1; index += 1) {
    const text = lines[index];

    if (!/^:[A-Za-z][A-Za-z0-9_-]*:/.test(text)) {
      break;
    }

    if (pattern.test(text)) {
      lines.splice(index, 1);

      return lines.join('\n');
    }
  }

  return null;
}
