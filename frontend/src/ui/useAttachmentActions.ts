import { useState } from 'react';
import type { AttachmentDto } from '@maily/shared';
import { showNotice } from '../state/undo';
import { useOnlineStatus } from '../state/connectivity';
import {
  canShareAttachment,
  openAttachment,
  saveAttachment,
  shareAttachment,
} from './openAttachment';

export type AttachmentAction = 'open' | 'share' | 'download';

/**
 * The three things a received attachment offers — Open, Share, Download — wired to the
 * platform through `openAttachment` (a browser tab or download on the web, the phone's
 * viewer / share sheet / Downloads in the Android app), with the busy and failure
 * handling every attachment control needs. `cached` is the bytes if the caller already
 * holds them (an image preview), so no action fetches twice.
 */
export function useAttachmentActions(
  messageId: string,
  attachment: AttachmentDto,
  cached?: Blob | null,
) {
  const online = useOnlineStatus();
  const [busy, setBusy] = useState<AttachmentAction | null>(null);
  const [failed, setFailed] = useState(false);

  async function run(action: AttachmentAction, work: () => Promise<void>): Promise<void> {
    if (!online || busy) return;
    setBusy(action);
    setFailed(false);
    try {
      await work();
    } catch (e) {
      setFailed(true);
      const verb = action === 'download' ? 'download' : action;
      showNotice((e as Error).message || `Couldn’t ${verb} this attachment`);
    } finally {
      setBusy(null);
    }
  }

  return {
    online,
    busy,
    failed,
    /** Hidden where neither the shell nor the browser can share files. */
    canShare: canShareAttachment(attachment),
    open: () => run('open', () => openAttachment(messageId, attachment, cached)),
    share: () => run('share', () => shareAttachment(messageId, attachment, cached)),
    download: () =>
      run('download', async () => {
        const outcome = await saveAttachment(messageId, attachment, cached);
        // A browser shows its own download UI; the Android save is otherwise silent.
        if (outcome.kind === 'saved') showNotice(`Saved to Downloads as ${outcome.name}`);
      }),
  };
}
