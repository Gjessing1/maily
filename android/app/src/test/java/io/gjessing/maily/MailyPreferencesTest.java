package io.gjessing.maily;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class MailyPreferencesTest {
    @Test
    public void normalizesRootHttpsUrls() {
        assertEquals(
            "https://mail.gjessing.io",
            MailyPreferences.normalizeServerUrl(" https://mail.gjessing.io/ ")
        );
        assertEquals(
            "https://mail.gjessing.io:8443",
            MailyPreferences.normalizeServerUrl("https://mail.gjessing.io:8443")
        );
    }

    @Test
    public void rejectsInsecureOrNonRootUrls() {
        assertNull(MailyPreferences.normalizeServerUrl("http://mail.gjessing.io"));
        assertNull(MailyPreferences.normalizeServerUrl("https://mail.gjessing.io/maily"));
        assertNull(MailyPreferences.normalizeServerUrl("https://user@mail.gjessing.io"));
        assertNull(MailyPreferences.normalizeServerUrl("https://mail.gjessing.io?redirect=other"));
        assertNull(MailyPreferences.normalizeServerUrl("not a url"));
    }
}
