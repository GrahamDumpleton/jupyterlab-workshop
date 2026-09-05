/** A requirement listed in page front matter, such as `verify:first-commit`. */
export interface IRequirement {
  kind: 'verify' | 'quiz' | 'form';
  id: string;
}

const KINDS: readonly IRequirement['kind'][] = ['verify', 'quiz', 'form'];

/**
 * Parse a `requires` entry, or return null when it is malformed.
 */
export function parseRequirement(text: string): IRequirement | null {
  const colon = text.indexOf(':');

  if (colon <= 0) {
    return null;
  }

  const kind = text.slice(0, colon);
  const id = text.slice(colon + 1).trim();

  if (!(KINDS as string[]).includes(kind) || id === '') {
    return null;
  }

  return { kind: kind as IRequirement['kind'], id };
}

/**
 * A short phrase describing an unmet requirement.
 */
export function describeRequirement(requirement: IRequirement): string {
  switch (requirement.kind) {
    case 'verify':
      return `Pass the check "${requirement.id}"`;
    case 'quiz':
      return `Answer the quiz "${requirement.id}"`;
    case 'form':
      return `Fill in the form "${requirement.id}"`;
  }
}
