package io.gjessing.maily;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

/**
 * The poll response parser. Everything else about background notifications is Android
 * plumbing that only means anything on a device; this is the one piece where a silent
 * break costs a missed notification rather than a crash, and it runs off-device.
 */
public class MailyPushPollTest {
    @Test
    public void readsEveryMailInTheAnswer() {
        List<MailyPushPoll.Mail> mail = MailyPushPoll.parse(
            "{\"mail\":["
                + "{\"messageId\":\"one\",\"title\":\"Ada\",\"body\":\"Re: engines\"},"
                + "{\"messageId\":\"two\",\"title\":\"Grace\",\"body\":\"Re: compilers\"}"
                + "]}"
        );
        assertEquals(2, mail.size());
        assertEquals("one", mail.get(0).messageId);
        assertEquals("Ada", mail.get(0).title);
        assertEquals("Re: compilers", mail.get(1).body);
    }

    @Test
    public void anEmptyAnswerIsTheCommonCase() {
        assertTrue(MailyPushPoll.parse("{\"mail\":[]}").isEmpty());
    }

    @Test
    public void skipsEntriesWithNothingToDeepLinkTo() {
        // A notification with no message id would open the app at whatever it was last
        // showing, which is worse than not posting it.
        List<MailyPushPoll.Mail> mail = MailyPushPoll.parse(
            "{\"mail\":[{\"title\":\"Ada\"},{\"messageId\":\"two\",\"title\":\"Grace\"}]}"
        );
        assertEquals(1, mail.size());
        assertEquals("two", mail.get(0).messageId);
    }

    @Test
    public void survivesAnAnswerItCannotRead() {
        // A gateway error page, a truncated body: never a crash inside a broadcast
        // receiver, which the system would report as the app misbehaving.
        assertTrue(MailyPushPoll.parse("<html>gateway timeout</html>").isEmpty());
        assertTrue(MailyPushPoll.parse("").isEmpty());
        assertTrue(MailyPushPoll.parse("{}").isEmpty());
    }

    @Test
    public void fillsInAMissingSubject() {
        List<MailyPushPoll.Mail> mail = MailyPushPoll.parse(
            "{\"mail\":[{\"messageId\":\"one\"}]}"
        );
        assertEquals("New mail", mail.get(0).title);
        assertEquals("", mail.get(0).body);
    }
}
