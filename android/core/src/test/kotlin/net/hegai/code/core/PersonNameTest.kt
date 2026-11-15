package net.hegai.code.core

import org.junit.Test
import org.junit.Assert.*
import kotlinx.serialization.json.*

// Accounts without an address exist (Telegram-only sign-in): the viewer must
// still decode, and a member's label must never be blank or "null".
class PersonNameTest {
    @Test fun viewerWithoutEmailDecodes() {
        val v = wireJson.decodeFromString<Viewer>("""{"userId":"tg-1","fullName":"Данис","platformAdmin":false}""")
        assertEquals("tg-1", v.userId)
        assertNull(v.email)
    }

    @Test fun personNameFallsBackFromNameToEmailToId() {
        fun p(json: String) = wireJson.parseToJsonElement(json).jsonObject
        assertEquals("Данис Латыпов", personName(p("""{"userId":"u","fullName":" Данис Латыпов ","email":"d@x"}""")))
        assertEquals("d@x", personName(p("""{"userId":"u","email":"d@x"}""")))
        assertEquals("Участник tg-abc", personName(p("""{"userId":"tg-abcdef"}""")))
        assertEquals("Без имени", personName(p("""{}""")))
    }
}
