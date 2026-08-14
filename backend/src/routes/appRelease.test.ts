import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { appReleaseRoutes, readPublishedApp } from './appRelease.js';

test('readPublishedApp validates metadata and uses the APK size on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-app-release-'));
  try {
    const apk = Buffer.from('signed apk fixture');
    await writeFile(join(dir, 'maily-0.1.0.apk'), apk);
    await writeFile(
      join(dir, 'version.json'),
      JSON.stringify({
        versionCode: 1,
        versionName: '0.1.0',
        file: 'maily-0.1.0.apk',
        bytes: 999,
        sha256: 'a'.repeat(64),
      }),
    );

    const release = await readPublishedApp(dir);
    assert.equal(release.versionCode, 1);
    assert.equal(release.versionName, '0.1.0');
    assert.equal(release.bytes, apk.length);
    assert.equal(release.apkPath, join(dir, 'maily-0.1.0.apk'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readPublishedApp rejects path traversal in the APK filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-app-release-'));
  try {
    await writeFile(
      join(dir, 'version.json'),
      JSON.stringify({
        versionCode: 1,
        versionName: '0.1.0',
        file: '../maily-0.1.0.apk',
        sha256: 'a'.repeat(64),
      }),
    );
    await assert.rejects(() => readPublishedApp(dir), /invalid APK filename/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release endpoints expose stable metadata and APK download URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-app-release-'));
  const app = Fastify();
  try {
    await app.register(appReleaseRoutes, { appDir: dir });
    await app.ready();

    const missing = await app.inject({ method: 'GET', url: '/api/app/version' });
    assert.equal(missing.statusCode, 404);

    const apk = Buffer.from('signed apk fixture');
    await writeFile(join(dir, 'maily-0.1.0.apk'), apk);
    await writeFile(
      join(dir, 'version.json'),
      JSON.stringify({
        versionCode: 1,
        versionName: '0.1.0',
        file: 'maily-0.1.0.apk',
        sha256: 'b'.repeat(64),
      }),
    );

    const version = await app.inject({ method: 'GET', url: '/api/app/version' });
    assert.equal(version.statusCode, 200);
    assert.deepEqual(version.json(), {
      versionCode: 1,
      versionName: '0.1.0',
      sha256: 'b'.repeat(64),
      bytes: apk.length,
      apkUrl: '/api/app/download',
    });
    assert.equal(version.headers['cache-control'], 'no-cache');

    const download = await app.inject({ method: 'GET', url: '/api/app/download' });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'application/vnd.android.package-archive');
    assert.match(download.headers['content-disposition'] ?? '', /maily-0\.1\.0\.apk/);
    assert.deepEqual(download.rawPayload, apk);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
