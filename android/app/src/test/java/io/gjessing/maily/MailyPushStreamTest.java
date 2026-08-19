package io.gjessing.maily;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

/**
 * The SSE frame parse — the one place where a break costs a *missing* notification
 * rather than a crash, which is exactly the failure nobody notices until mail has been
 * silently arriving unannounced for a week.
 */
public class MailyPushStreamTest {
    private static class Recorder implements MailyPushStream.Listener {
        final List<String> mail = new ArrayList<>();
        boolean connected;

        @Override
        public void onConnected() {
            connected = true;
        }

        @Override
        public void onMail(String messageId, String title, String body) {
            mail.add(messageId + "|" + title + "|" + body);
        }
    }

    private static Recorder read(String stream) throws Exception {
        Recorder recorder = new Recorder();
        MailyPushStream.consume(
            new BufferedReader(new StringReader(stream)),
            new AtomicBoolean(true),
            recorder
        );
        return recorder;
    }

    @Test
    public void readsOneEventPerFrame() throws Exception {
        Recorder recorder = read(
            ": connected\n\n"
            + "event: mail\n"
            + "data: {\"messageId\":\"id-1\",\"title\":\"Alice\",\"body\":\"Lunch?\"}\n\n"
            + ": ping\n\n"
            + "event: mail\n"
            + "data: {\"messageId\":\"id-2\",\"title\":\"Bob\",\"body\":\"Invoice\"}\n\n"
        );
        assertEquals(2, recorder.mail.size());
        assertEquals("id-1|Alice|Lunch?", recorder.mail.get(0));
        assertEquals("id-2|Bob|Invoice", recorder.mail.get(1));
    }

    @Test
    public void ignoresHeartbeatsAndUnterminatedTrailingFrames() throws Exception {
        // A dropped connection mid-frame: the socket dies before the blank line, and half
        // an event must never be posted as a notification.
        Recorder recorder = read(": ping\n\n: ping\n\ndata: {\"messageId\":\"id-3\"");
        assertTrue(recorder.mail.isEmpty());
    }

    @Test
    public void skipsEventsWithoutAMessageId() throws Exception {
        // Nothing to deep-link to, so a notification would open the app on nothing.
        Recorder recorder = read("data: {\"title\":\"Alice\"}\n\ndata: not json\n\n");
        assertTrue(recorder.mail.isEmpty());
    }

    @Test
    public void stopsWhenTheServiceIsShuttingDown() throws Exception {
        Recorder recorder = new Recorder();
        MailyPushStream.consume(
            new BufferedReader(new StringReader("data: {\"messageId\":\"id-4\"}\n\n")),
            new AtomicBoolean(false),
            recorder
        );
        assertTrue(recorder.mail.isEmpty());
    }
}
