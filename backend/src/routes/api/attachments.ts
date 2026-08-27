/**
 * Attachment serving + composer upload staging. Bytes are lazy (ARCHITECTURE §4):
 * materialised from IMAP on first GET, streamed to/from disk, never buffered.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { UploadDto } from '@maily/shared';
import { env } from '../../env.js';
import { getAttachment } from '../../db/queries.js';
import { ensureAttachmentOnDisk } from '../../storage/attachments.js';
import { deleteUpload } from '../../storage/uploads.js';

/**
 * Types a browser would execute rather than merely display, if it rendered them: the
 * HTML and XML families, the latter because an XML document can carry an XSLT stylesheet
 * and SVG can carry `<script>` outright. `application/xml` counts alongside `text/xml` —
 * they name the same thing, and the pair is why this matches by family rather than by
 * an exhaustive list.
 */
function rendersAsScript(mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return (
    type === 'text/html' ||
    type === 'text/xml' ||
    type === 'application/xml' ||
    type.endsWith('+xml')
  );
}

/**
 * The `Content-Disposition` for one served attachment.
 *
 * `inline` so a browser can render the file in a tab of its own — the desktop "open"
 * path (frontend `ui/openAttachment.ts`) navigates straight here rather than downloading
 * megabytes into a blob. Scriptable types are the exception: this is a stranger's file
 * served from maily's own origin, so an HTML or SVG attachment rendered here would run
 * *as* maily. Those download instead, and `nosniff` stops a browser promoting anything
 * else into them.
 *
 * The sender named the file, so the name is quoted with its own quotes stripped rather
 * than trusted into the header.
 */
export function contentDisposition(mimeType: string, filename: string | null): string {
  const disposition = rendersAsScript(mimeType) ? 'attachment' : 'inline';
  return filename ? `${disposition}; filename="${filename.replace(/"/g, '')}"` : disposition;
}

/** Cap on a single composer attachment upload (streamed straight to disk). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  // Raw binary uploads (composer attachments) arrive as octet-stream; pass the
  // request stream straight through so the route can pipe it to disk unbuffered.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  app.get<{ Params: { id: string; attId: string } }>(
    '/api/messages/:id/attachments/:attId',
    async (req, reply) => {
      const att = getAttachment(req.params.attId);
      if (!att || att.messageId !== req.params.id) {
        return reply.code(404).send({ error: 'not found' });
      }

      // Lazy fetch: materialise the bytes on disk (from IMAP) if not yet downloaded.
      const path = await ensureAttachmentOnDisk(att);
      if (!path) return reply.code(409).send({ error: 'attachment bytes unavailable' });

      const mimeType = att.mimeType ?? 'application/octet-stream';
      reply.header('Content-Type', mimeType);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', contentDisposition(mimeType, att.filename));
      return reply.send(createReadStream(path));
    },
  );

  // Stage a composer attachment: stream the raw body to the uploads dir, capped at
  // MAX_UPLOAD_BYTES, returning a handle the send route resolves by uploadId.
  app.post<{ Querystring: { filename?: string; type?: string } }>(
    '/api/uploads',
    async (req, reply): Promise<UploadDto | undefined> => {
      const uploadId = randomUUID();
      const path = join(env.uploadsDir, uploadId);
      const filename = (req.query.filename ?? 'attachment').slice(0, 255);
      const mimeType = req.query.type ?? null;

      let total = 0;
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          total += chunk.length;
          if (total > MAX_UPLOAD_BYTES) cb(new Error('upload too large'));
          else cb(null, chunk);
        },
      });

      try {
        await pipeline(req.body as NodeJS.ReadableStream, limiter, createWriteStream(path));
      } catch (err) {
        await unlink(path).catch(() => undefined);
        return reply.code(413).send({ error: (err as Error).message });
      }
      return { uploadId, filename, mimeType, sizeBytes: total };
    },
  );

  // Discard a staged upload (user removed the chip before sending).
  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async (req) => {
    await deleteUpload(req.params.id);
    return { ok: true };
  });
}
