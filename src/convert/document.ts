/**
 * Document adapter — PDFs, images, Office files, spreadsheets via Workers AI `toMarkdown`.
 * Images are described by a vision model, PDFs keep their text layout, sheets become tables.
 */
import { ConvertError, countWords, type ConvertContext, type ConvertResult, type SourceKind } from './types';

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const DOCUMENT_TYPES: Record<string, SourceKind> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/svg+xml': 'image',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'document',
  'application/vnd.oasis.opendocument.spreadsheet': 'document',
  'application/vnd.oasis.opendocument.text': 'document',
  'text/csv': 'document',
  'application/xml': 'document',
  'text/xml': 'document',
};

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  csv: 'text/csv',
};

export function mimeFor(contentType: string, url: URL): string | null {
  const base = contentType.split(';')[0].trim();
  if (DOCUMENT_TYPES[base]) return base;
  if (base === '' || base === 'application/octet-stream' || base === 'binary/octet-stream') {
    const ext = url.pathname.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_TYPES[ext] ?? null;
  }
  return null;
}

export function isDocumentContentType(contentType: string, url: URL): boolean {
  return mimeFor(contentType, url) !== null;
}

/** Credits charged per document kind (see pricing). */
export function documentCreditCost(kind: SourceKind): number {
  return kind === 'image' ? 5 : kind === 'pdf' || kind === 'document' ? 3 : 1;
}

export async function convertBlobToMarkdown(
  blob: Blob,
  name: string,
  mime: string,
  ctx: ConvertContext,
): Promise<{ markdown: string; kind: SourceKind }> {
  if (blob.size > MAX_DOCUMENT_BYTES) throw new ConvertError('Document too large (max 20 MB)', 413, 'too_large');
  const typed = blob.type === mime ? blob : new Blob([await blob.arrayBuffer()], { type: mime });
  const out = await ctx.tracer.span('ai.toMarkdown', () => ctx.env.AI.toMarkdown({ name, blob: typed }), { mime, bytes: blob.size });
  if (out.format === 'error' || !('data' in out)) {
    throw new ConvertError(`Could not convert this ${mime} file`, 422, 'document_failed');
  }
  return { markdown: (out as { data: string }).data.trim(), kind: DOCUMENT_TYPES[mime] ?? 'document' };
}

export async function convertDocumentResponse(
  response: Response,
  url: URL,
  contentType: string,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  const mime = mimeFor(contentType, url);
  if (!mime) throw new ConvertError(`Unsupported content type: ${contentType}`, 415, 'unsupported_type');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new ConvertError('Document too large (max 20 MB)', 413, 'too_large');
  const blob = await ctx.tracer.span('download', () => response.blob(), { mime });
  const name = decodeURIComponent(url.pathname.split('/').pop() || 'document') || 'document';
  const { markdown, kind } = await convertBlobToMarkdown(blob, name, mime, ctx);
  const firstHeading = markdown.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  return {
    title: firstHeading || name,
    author: '',
    published: '',
    description: '',
    domain: url.hostname.replace(/^www\./, ''),
    content: kind === 'image' ? `![${name}](${url.href})\n\n${markdown}` : markdown,
    wordCount: countWords(markdown),
    source: url.href,
    sourceKind: kind,
  };
}
