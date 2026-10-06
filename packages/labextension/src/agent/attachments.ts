/**
 * Files attached to a message before it is sent: what is pasted or
 * dropped into the message box, chosen with the Attach button, or
 * dragged from the file browser. Each is checked and made ready here,
 * and sent with the message as base64; the server saves it beside the
 * conversation and shows it to the agent.
 */

/** A file ready to send with a message. */
export interface IAttachment {
  /** The file's name, which the server keeps it under. */
  name: string;

  /** Its media type. */
  type: string;

  /** Its content, as base64. */
  data: string;
}

/** An attachment as the composer shows it before sending. */
export interface IPendingAttachment extends IAttachment {
  /** How many bytes it holds, after any shrinking. */
  size: number;

  /** An object URL for an image's thumbnail, to be revoked when done. */
  preview?: string;
}

/** The images the agent is shown as images. */
export const IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
];

/** Documents the agent reads from the file. */
export const DOCUMENT_TYPES: readonly string[] = ['application/pdf'];

/** Types besides text/* that hold text. */
export const TEXT_TYPES: readonly string[] = [
  'application/json',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/xml',
  'application/javascript',
  'application/x-sh',
  'application/x-ipynb+json'
];

/** The largest an image may be once sent: the model's own limit. */
export const IMAGE_LIMIT = 5 * 1024 * 1024;

/** The largest a document may be. */
export const DOCUMENT_LIMIT = 10 * 1024 * 1024;

/** The largest a text file may be. */
export const TEXT_LIMIT = 1024 * 1024;

/** The most one message may carry in all. */
export const MESSAGE_LIMIT = 24 * 1024 * 1024;

/** How many files one message may carry. */
export const COUNT_LIMIT = 20;

/**
 * The longest side an image is sent at. The model scales anything larger
 * down itself, so sending more only costs time.
 */
export const IMAGE_SIDE = 1568;

/**
 * Pasted text this long, or with this many lines, is attached as a file
 * rather than put in the message box, as Claude Code does.
 */
export const LONG_PASTE_CHARS = 2000;
export const LONG_PASTE_LINES = 40;

/** Extensions whose files are text when the browser gives them no type. */
const TEXT_EXTENSIONS: readonly string[] = [
  'txt',
  'md',
  'markdown',
  'rst',
  'yaml',
  'yml',
  'json',
  'toml',
  'csv',
  'tsv',
  'py',
  'js',
  'ts',
  'tsx',
  'jsx',
  'sh',
  'bash',
  'html',
  'css',
  'xml',
  'ini',
  'cfg',
  'conf',
  'log',
  'ipynb',
  'sql',
  'r',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'rb',
  'dockerfile'
];

/** Why a file could not be attached. */
export class AttachmentError extends Error {}

/** Whether pasted text is long enough to go as a file. */
export function isLongPaste(text: string): boolean {
  return (
    text.length > LONG_PASTE_CHARS || text.split('\n').length > LONG_PASTE_LINES
  );
}

/** How the agent is shown a type: an image, a document or text. */
export function kindOf(type: string): 'image' | 'document' | 'text' | null {
  if (IMAGE_TYPES.includes(type)) {
    return 'image';
  }

  if (DOCUMENT_TYPES.includes(type)) {
    return 'document';
  }

  if (type.startsWith('text/') || TEXT_TYPES.includes(type)) {
    return 'text';
  }

  return null;
}

/**
 * The media type of a file: the browser's, or one worked out from the
 * name when the browser gives none, as it does for many text files.
 */
export function typeOf(name: string, given: string): string {
  const type = given.split(';')[0].trim().toLowerCase();

  if (type && type !== 'application/octet-stream') {
    return type;
  }

  const extension = name.toLowerCase().split('.').pop() ?? '';

  if (
    name.toLowerCase() === 'dockerfile' ||
    TEXT_EXTENSIONS.includes(extension)
  ) {
    return extension === 'md' || extension === 'markdown'
      ? 'text/markdown'
      : extension === 'json' || extension === 'ipynb'
        ? 'application/json'
        : 'text/plain';
  }

  return type;
}

/** A size in words. */
export function describeSize(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${size} bytes`;
}

/**
 * Make a file ready to send: check its type and size, and shrink an
 * image that is larger than the model would look at anyway.
 */
export async function prepareAttachment(
  blob: Blob,
  name: string
): Promise<IPendingAttachment> {
  const type = typeOf(name, blob.type);
  const kind = kindOf(type);

  if (kind === null) {
    throw new AttachmentError(
      `${name} cannot be attached: only images, PDFs and text files can.`
    );
  }

  let content: Blob = blob;

  if (kind === 'image' && type !== 'image/gif') {
    content = await shrinkImage(blob, type);
  }

  const limit =
    kind === 'image'
      ? IMAGE_LIMIT
      : kind === 'document'
        ? DOCUMENT_LIMIT
        : TEXT_LIMIT;

  if (content.size > limit) {
    throw new AttachmentError(
      `${name} is too large: ${describeSize(content.size)}, and a ${kind} can be at most ${describeSize(limit)}.`
    );
  }

  // A browser that cannot encode the image's own format shrinks it to
  // another, which the blob then says.
  const attachment: IPendingAttachment = {
    name,
    type: kind === 'image' && content.type ? content.type : type,
    data: await toBase64(content),
    size: content.size
  };

  if (kind === 'image') {
    attachment.preview = URL.createObjectURL(content);
  }

  return attachment;
}

/** Pasted text as a file to attach. */
export function pastedText(
  text: string,
  number: number
): Promise<IPendingAttachment> {
  return prepareAttachment(
    new Blob([text], { type: 'text/plain' }),
    `pasted-text-${number}.txt`
  );
}

/**
 * Check that one more file fits in the message: the count, and the size
 * of everything together.
 */
export function checkRoom(
  pending: readonly IPendingAttachment[],
  next: IPendingAttachment
): void {
  if (pending.length >= COUNT_LIMIT) {
    throw new AttachmentError(
      `At most ${COUNT_LIMIT} files can be attached to one message.`
    );
  }

  const total = pending.reduce((sum, item) => sum + item.size, next.size);

  if (total > MESSAGE_LIMIT) {
    throw new AttachmentError(
      `One message can carry at most ${describeSize(MESSAGE_LIMIT)} of attachments.`
    );
  }
}

/** Let go of an attachment's thumbnail. */
export function releaseAttachment(attachment: IPendingAttachment): void {
  if (attachment.preview) {
    URL.revokeObjectURL(attachment.preview);
  }
}

/**
 * An image no larger than IMAGE_SIDE on its longest side, in the same
 * format. One already small enough, or one the browser cannot decode,
 * is sent as it is.
 */
async function shrinkImage(blob: Blob, type: string): Promise<Blob> {
  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }

  const scale = IMAGE_SIDE / Math.max(bitmap.width, bitmap.height);

  if (scale >= 1) {
    bitmap.close();

    return blob;
  }

  const canvas = document.createElement('canvas');

  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const shrunk = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, type, 0.9)
  );

  return shrunk ?? blob;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      // A data URL: the base64 follows the first comma.
      const url = String(reader.result);

      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
