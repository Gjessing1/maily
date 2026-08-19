/**
 * FCM is the Android APK's only viable push transport (System WebView has no Push API),
 * so its failure modes are the ones that silently stop mail notifications on a phone:
 * a token FCM has retired must be pruned rather than retried forever, and a missing
 * service account must leave the channel inert instead of throwing into the signal bus.
 */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  delete process.env.FCM_SERVICE_ACCOUNT_FILE;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

test('no service account configured leaves the channel disabled', async () => {
  const { env } = await import('../env.js');
  assert.equal(env.fcm(), null);
});

test('a service account is read from inline JSON, with escaped newlines restored', async () => {
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: 'maily-test',
    client_email: 'push@maily-test.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n',
  });
  const { env } = await import('../env.js');
  const config = env.fcm();
  assert.equal(config?.projectId, 'maily-test');
  assert.equal(config?.clientEmail, 'push@maily-test.iam.gserviceaccount.com');
  // Env-inlined PEMs carry literal backslash-n; crypto needs real newlines or signing throws.
  assert.ok(config?.privateKey.includes('\n'));
  assert.ok(!config?.privateKey.includes('\\n'));
});

test('a service account missing required fields disables FCM rather than half-configuring it', async () => {
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'maily-test' });
  const { env } = await import('../env.js');
  assert.equal(env.fcm(), null);
});

test('malformed service-account JSON disables FCM instead of throwing at boot', async () => {
  process.env.FCM_SERVICE_ACCOUNT_JSON = '{ not json';
  const { env } = await import('../env.js');
  assert.equal(env.fcm(), null);
});

test('broadcasting with no service account is a no-op, never a throw', async () => {
  const { broadcastFcm } = await import('./fcm.js');
  await broadcastFcm({ title: 'a', body: 'b', messageId: 'id' });
});
