package io.gjessing.maily;

import static org.junit.Assert.assertEquals;

import android.content.res.Configuration;
import org.junit.Test;

/**
 * The night bit is the whole input, and the script is the whole output — a page that
 * never installed the global must be left alone rather than thrown an error.
 */
public class MailyThemeTest {
    @Test
    public void readsTheNightBitOutOfUiMode() {
        assertEquals("dark", MailyTheme.themeName(Configuration.UI_MODE_NIGHT_YES));
        assertEquals("light", MailyTheme.themeName(Configuration.UI_MODE_NIGHT_NO));
        // uiMode carries the device type in its other bits; only the night mask counts.
        assertEquals(
            "dark",
            MailyTheme.themeName(Configuration.UI_MODE_TYPE_NORMAL | Configuration.UI_MODE_NIGHT_YES)
        );
        // Undefined (an emulator that has never been told) is not night.
        assertEquals("light", MailyTheme.themeName(Configuration.UI_MODE_NIGHT_UNDEFINED));
    }

    @Test
    public void guardsTheGlobalItCalls() {
        assertEquals(
            "window.mailySystemTheme && window.mailySystemTheme('dark')",
            MailyTheme.script("dark")
        );
    }
}
