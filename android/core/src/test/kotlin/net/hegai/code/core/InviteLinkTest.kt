package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class InviteLinkTest {
    @Test fun setupUrlWins() = assertEquals("https://h.io/setup?t=1", InviteLink.build("https://h.io", "tok", "https://h.io/setup?t=1"))
    @Test fun fallsBackToInviteParam() {
        assertEquals("https://h.io/?invite=tok", InviteLink.build("https://h.io", "tok", null))
        assertEquals("https://h.io/?invite=tok", InviteLink.build("https://h.io", "tok", " "))
        assertEquals("https://h.io/?invite=a%2Bb", InviteLink.build("https://h.io", "a+b", null))
    }
    @Test fun nothingToShare() = assertNull(InviteLink.build("https://h.io", null, null))
}
