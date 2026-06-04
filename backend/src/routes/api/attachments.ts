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

      reply.header('Content-Type', att.mimeType ?? 'application/octet-stream');
      if (att.filename) {
        reply.header('Content-Disposition', `inline; filename="${att.filename.replace(/"/g, '')}"`);
      }
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
