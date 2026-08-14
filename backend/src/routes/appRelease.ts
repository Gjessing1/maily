import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

interface PublishedApp {
  versionCode: number;
  versionName: string;
  file: string;
  sha256: string;
  bytes: number;
  apkPath: string;
}

/** Read and validate the Android release atomically published by the host. */
export async function readPublishedApp(appDir: string): Promise<PublishedApp> {
  const metadata = JSON.parse(await readFile(join(appDir, 'version.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const { versionCode, versionName, file, sha256 } = metadata;

  if (!Number.isSafeInteger(versionCode) || (versionCode as number) < 1) {
    throw new Error('version.json has an invalid versionCode');
  }
  if (typeof versionName !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(versionName)) {
    throw new Error('version.json has an invalid versionName');
  }
  if (
    typeof file !== 'string' ||
    file !== basename(file) ||
    !/^maily-[0-9A-Za-z._-]+\.apk$/.test(file)
  ) {
    throw new Error('version.json has an invalid APK filename');
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('version.json has an invalid sha256');
  }

  const apkPath = join(appDir, file);
  const apkStat = await stat(apkPath);
  if (!apkStat.isFile()) throw new Error('published APK is not a file');

  return {
    versionCode: versionCode as number,
    versionName,
    file,
    sha256,
    bytes: apkStat.size,
    apkPath,
  };
}

/** Public metadata and stable direct-download URL for the current signed APK. */
export async function appReleaseRoutes(
  app: FastifyInstance,
  options: { appDir?: string } = {},
): Promise<void> {
  const appDir = options.appDir ?? env.androidAppDir;
  app.get('/api/app/version', async (_req, reply) => {
    try {
      const { versionCode, versionName, sha256, bytes } = await readPublishedApp(appDir);
      return reply.header('Cache-Control', 'no-cache').send({
        versionCode,
        versionName,
        sha256,
        bytes,
        apkUrl: '/api/app/download',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        app.log.error(error, 'published Android app is unreadable');
      }
      return reply.code(404).send({ error: 'No Android app has been published' });
    }
  });

  app.get('/api/app/download', async (_req, reply) => {
    try {
      const published = await readPublishedApp(appDir);
      return reply
        .header('Cache-Control', 'no-cache')
        .header('Content-Type', 'application/vnd.android.package-archive')
        .header('Content-Length', published.bytes)
        .header('Content-Disposition', `attachment; filename="${published.file}"`)
        .send(createReadStream(published.apkPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        app.log.error(error, 'published Android app is unreadable');
      }
      return reply.code(404).send({ error: 'No Android app has been published' });
    }
  });
}
