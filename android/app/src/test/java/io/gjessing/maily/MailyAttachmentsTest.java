package io.gjessing.maily;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * A sender chooses the filename, and it becomes a path in the app's cache. Everything
 * pinned here is that reduction, because a mistake in it is a write outside the download
 * folder rather than a visible bug.
 */
public class MailyAttachmentsTest {
    @Test
    public void keepsAnOrdinaryFilenameIntact() {
        assertEquals("247201_002657536.pdf", MailyAttachments.safeFilename("247201_002657536.pdf"));
        assertEquals("Faktura-2026.pdf", MailyAttachments.safeFilename("  Faktura-2026.pdf  "));
    }

    @Test
    public void stripsDirectoriesAndTraversal() {
        assertEquals("passwd", MailyAttachments.safeFilename("../../../etc/passwd"));
        assertEquals("report.pdf", MailyAttachments.safeFilename("C:\\Users\\me\\report.pdf"));
        // Only a name is left, so a bare traversal has nothing to name the file with.
        assertEquals("attachment", MailyAttachments.safeFilename("../"));
    }

    @Test
    public void replacesOnlyTheCharactersThatWouldNotSurviveAFilesystem() {
        assertEquals("a_b_c.txt", MailyAttachments.safeFilename("a:b*c.txt"));
        assertEquals("kvittering_.pdf", MailyAttachments.safeFilename("kvittering\u0000.pdf"));
        // A sender's own alphabet is not a hazard — mangling it would be the bug.
        assertEquals("faktura års rapport.pdf", MailyAttachments.safeFilename("faktura års rapport.pdf"));
    }

    @Test
    public void namesTheUnnamedAndUnhidesTheHidden() {
        assertEquals("attachment", MailyAttachments.safeFilename(null));
        assertEquals("attachment", MailyAttachments.safeFilename("   "));
        assertEquals("bashrc", MailyAttachments.safeFilename(".bashrc"));
    }

    @Test
    public void truncatesLongNamesWithoutLosingTheExtension() {
        String name = MailyAttachments.safeFilename("x".repeat(300) + ".pdf");
        assertEquals(100, name.length());
        assertTrue(name.endsWith(".pdf"));
    }

    @Test
    public void prefersTheTypeTheServerDeclared() {
        assertEquals("application/pdf", MailyAttachments.resolveMimeType("Application/PDF", "invoice.pdf"));
        // Nothing to improve on: no declared type worth keeping and no extension to read.
        assertEquals(
            "application/octet-stream",
            MailyAttachments.resolveMimeType("application/octet-stream", "attachment")
        );
    }
}
