package io.gjessing.maily;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.Intent;
import org.junit.Test;

/**
 * Every way another app can ask for a message collapses to one mailto: URL — the only
 * shape the web composer parses — and whatever the other app supplied is percent-encoded
 * on the way, since it ends up inside a URL the WebView loads.
 */
public class MailyComposeLinkTest {
    private static String mailto(String action, String data, String[] to, String subject, String text) {
        return MailyComposeLink.mailtoFor(action, data, to, null, subject, text);
    }

    @Test
    public void passesATappedLinkThroughUntouched() {
        String link = "mailto:a@example.com?subject=Hi%20there";
        assertEquals(link, mailto(Intent.ACTION_VIEW, link, null, null, null));
        assertEquals("MAILTO:a@example.com", mailto(Intent.ACTION_SENDTO, "MAILTO:a@example.com", null, null, null));
    }

    @Test
    public void addsTheExtrasSentBesideABareMailto() {
        assertEquals(
            "mailto:?to=a%40example.com%2Cb%40example.com&cc=c%40example.com&subject=Hello%20%26%20bye&body=Line%201%0ALine%202",
            MailyComposeLink.mailtoFor(
                Intent.ACTION_SENDTO,
                "mailto:",
                new String[] { "a@example.com", " ", "b@example.com" },
                new String[] { "c@example.com" },
                "Hello & bye",
                "Line 1\nLine 2"
            )
        );
    }

    @Test
    public void keepsTheLinksOwnSubjectAndBodyOverExtras() {
        assertEquals(
            "mailto:a@example.com?Subject=Mine&body=Kept",
            mailto(Intent.ACTION_SENDTO, "mailto:a@example.com?Subject=Mine&body=Kept", null, "Theirs", "Dropped")
        );
    }

    @Test
    public void turnsASharedTextIntoAMessage() {
        assertEquals(
            "mailto:?subject=A%20page&body=https%3A%2F%2Fexample.com%2F%3Fq%3D1%2B1",
            mailto(Intent.ACTION_SEND, null, null, "A page", "https://example.com/?q=1+1")
        );
        // A share with nothing in it is not worth a blank composer.
        assertNull(mailto(Intent.ACTION_SEND, null, null, null, "  "));
    }

    @Test
    public void capsAnEnormousSharedText() {
        String huge = new String(new char[MailyComposeLink.MAX_BODY_CHARS + 500]).replace('\0', 'x');
        String result = mailto(Intent.ACTION_SEND, null, null, null, huge);
        assertEquals("mailto:?body=".length() + MailyComposeLink.MAX_BODY_CHARS, result.length());
    }

    @Test
    public void ignoresEverythingThatIsNotAComposeRequest() {
        assertNull(mailto(Intent.ACTION_MAIN, null, null, null, null));
        assertNull(mailto(Intent.ACTION_VIEW, "https://example.com/", null, null, null));
        assertNull(mailto(Intent.ACTION_VIEW, null, null, null, null));
        assertNull(mailto(null, "mailto:a@example.com", null, null, null));
    }

    @Test
    public void buildsTheComposerUrlOnTheConfiguredServer() {
        assertEquals(
            "https://mail.example.com/compose?mailto=mailto%3Aa%40example.com%3Fsubject%3DHi%2520there",
            MailyComposeLink.urlFor("https://mail.example.com/", "mailto:a@example.com?subject=Hi%20there")
        );
        assertNull(MailyComposeLink.urlFor(null, "mailto:a@example.com"));
        assertNull(MailyComposeLink.urlFor("https://mail.example.com", null));
    }
}
