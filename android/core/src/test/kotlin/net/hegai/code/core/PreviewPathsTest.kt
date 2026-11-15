package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

/** Copies ios/CCRemoteTests/PreviewPathsTests.swift (and web/test/file-paths.test.ts): rules change together. */
class PreviewPathsTest {
    private fun find(text: String) = PreviewPaths.find(text)

    @Test fun scratchpadScreenshotAfterLabel() {
        val path = "/tmp/agents-0/-srv-shop-app/296c3cd6-4e13-4628-b670-8e8d7d23976f/scratchpad/mail.png"
        assertEquals(listOf(path), find("Готово.\n\nСкриншот: $path"))
        assertEquals(listOf(path), find("Скриншот:$path"))
    }

    @Test fun backticksLinksAndTrailingPunctuation() {
        assertEquals(listOf("/srv/a/shot.PNG"), find("Смотри `/srv/a/shot.PNG`."))
        assertEquals(listOf("/srv/a/b.png"), find("[скрин](/srv/a/b.png)"))
        assertEquals(listOf("/srv/a/b.webp"), find("![](/srv/a/b.webp)"))
        assertEquals(listOf("/srv/a/NOTES.md"), find("(см. /srv/a/NOTES.md)"))
        assertEquals(listOf("/srv/a/b.jpg", "/srv/a/c.gif"), find("«/srv/a/b.jpg», потом /srv/a/c.gif;"))
        assertEquals(listOf("/srv/a/b.markdown"), find("**/srv/a/b.markdown**"))
        assertEquals(listOf("/srv/a/b.md"), find("файл /srv/a/b.md: готов"))
    }

    @Test fun relativeNeedsASlash() {
        assertEquals(listOf("docs/README.md", "./shots/a.jpeg", "../x/y.png"), find("см. docs/README.md и ./shots/a.jpeg и ../x/y.png"))
        assertEquals(emptyList<String>(), find("прочитай README.md и logo.png"))
    }

    @Test fun windowsPaths() {
        assertEquals(listOf("""C:\Users\owner\Desktop\shot.png"""), find("""Сохранил C:\Users\owner\Desktop\shot.png."""))
        assertEquals(listOf("D:/tmp/a.md"), find("D:/tmp/a.md"))
    }

    @Test fun ignoresUrlsAndOtherExtensions() {
        assertEquals(emptyList<String>(), find("https://example.com/a/b.png и [x](https://e.com/c.md)"))
        assertEquals(emptyList<String>(), find("HTTP://E.com/a.png"))
        assertEquals(emptyList<String>(), find("/srv/a/b.pdf /srv/a/c.png.bak /srv/a/.png /srv/a/d.txt"))
        assertEquals(emptyList<String>(), find("//srv/a/b.png"))
    }

    @Test fun spacesInsideDelimitedSpans() {
        assertEquals(listOf("/srv/my dir/скрин 1.png"), find("Лежит в `/srv/my dir/скрин 1.png`."))
        assertEquals(listOf("/tmp/a b/c.png"), find("[скрин](</tmp/a b/c.png>)"))
        assertEquals(listOf("/tmp/a b/plan.md", "docs/my notes/x.md"), find("Файл «/tmp/a b/plan.md» и \"docs/my notes/x.md\""))
        assertEquals(listOf("/tmp/x.png"), find("«смотри /tmp/x.png»"))
        assertEquals(listOf("out/a.png"), find("`npm run shot -- out/a.png`"))
    }

    @Test fun oneSpaceAfterARootedFragmentIsBridged() {
        assertEquals(listOf("/srv/my dir/a.png"), find("Скриншот: /srv/my dir/a.png"))
        assertEquals(listOf("/srv/my dir/a.png"), find("/srv/my dir/a.png"))
        assertEquals(listOf("docs/a.png"), find("в /srv/x и docs/a.png"))
        assertEquals(listOf("/tmp/a.png", "docs/b.png"), find("/tmp/a.png docs/b.png"))
        assertEquals(listOf("docs/a.png"), find("см. /srv/x, docs/a.png"))
        assertEquals(listOf("screenshots/home.png"), find("Сохранил в web/dist screenshots/home.png"))
        assertEquals(listOf("docs/plan.md"), find("Папка: /srv/app\ndocs/plan.md"))
        assertEquals(emptyList<String>(), find("`//host/a b.png`"))
        assertEquals(listOf("C:\\Users\\John Doe\\shot.png"), find("Скрин C:\\Users\\John Doe\\shot.png"))
    }

    @Test fun dedupeKeepsOrderAndCapsAtSix() {
        assertEquals(listOf("/a/1.png", "/a/2.png"), find("/a/1.png /a/2.png /a/1.png `/a/2.png`"))
        val many = (1..9).joinToString(" ") { "/a/$it.png" }
        assertEquals((1..6).map { "/a/$it.png" }, find(many))
    }

    @Test fun webTable() {
        assertEquals(emptyList<String>(), find("Обновил README.md и CHANGELOG.md"))
        assertEquals(listOf("docs/plan.md", "web/shots/a.png", "./notes/x.md"), find("См. docs/plan.md и web/shots/a.png, ещё ./notes/x.md"))
        assertEquals(listOf("/tmp/a/b.png", "shots/c.webp"), find("[скрин](/tmp/a/b.png) и ![x](shots/c.webp)"))
        assertEquals(listOf("/tmp/q/p.jpeg"), find("[Image: source: /tmp/q/p.jpeg]"))
        for (tail in listOf(".", ",", ";", ":", ")", "»", "\"", "'", "!", "?")) {
            assertEquals(tail, listOf("/tmp/x/shot.png"), find("Смотри /tmp/x/shot.png$tail"))
        }
        assertEquals(listOf("/tmp/x/shot.png"), find("(см. /tmp/x/shot.png)."))
        assertEquals(emptyList<String>(), find("https://x.com/a/b.png и http://h/c/d.md"))
        assertEquals(listOf("/tmp/ok.png"), find("[a](https://x.com/a/b.png) но /tmp/ok.png"))
        assertEquals(emptyList<String>(), find("www.example.com/a/b.png"))
        assertEquals(listOf("""C:\Users\p\shots\a.PNG"""), find("""Файл C:\Users\p\shots\a.PNG готов"""))
        assertEquals(listOf("D:/out/plan.md"), find("D:/out/plan.md."))
        assertEquals(listOf("/a/B.MD", "/a/c.markdown"), find("/a/b.txt /a/b.pdf /a/b.png.bak /a/b.pngx /a/B.MD /a/c.markdown"))
        assertEquals(listOf("/tmp/отчёт/итог.md"), find("/tmp/отчёт/итог.md и снова /tmp/отчёт/итог.md"))
    }

    @Test fun kindAndName() {
        assertTrue(PreviewPaths.isImage("/a/b.JPG"))
        assertFalse(PreviewPaths.isImage("/a/b.md"))
        assertTrue(PreviewPaths.isAbsolute("/a/b.md"))
        assertTrue(PreviewPaths.isAbsolute("""C:\a\b.md"""))
        assertFalse(PreviewPaths.isAbsolute("a/b.md"))
        assertEquals("c.png", PreviewPaths.fileName("/a/b/c.png"))
        assertEquals("b.md", PreviewPaths.fileName("""C:\a\b.md"""))
    }

    private fun win(offset: Int, n: Int, size: Long, mtime: Double = 1.0, eof: Boolean) =
        PeekWindow(offset, n, size, mtime, eof, ByteArray(n) { 1 })

    @Test fun peekAssemblerWindowsAndGuards() {
        val a = PeekAssembler(1000, clip = false, window = 600)
        assertEquals(0 to 600, a.next())
        a.accept(win(0, 600, 900, eof = false))
        assertEquals(600 to 600, a.next())
        a.accept(win(600, 300, 900, eof = true))
        assertEquals(900, a.result!!.size)
        assertThrows(PreviewReadException::class.java) { PeekAssembler(100, false).accept(win(0, 50, 5000, eof = false)) }
        val b = PeekAssembler(1000, false, 600); b.accept(win(0, 600, 900, eof = false))
        assertThrows(PreviewReadException::class.java) { b.accept(win(600, 300, 900, mtime = 2.0, eof = true)) }
        val c = PeekAssembler(1000, false, 600); c.accept(win(0, 600, 900, eof = false))
        assertThrows(PreviewReadException::class.java) { c.accept(win(500, 300, 900, eof = true)) }
        val d = PeekAssembler(1000, false, 600)
        assertThrows(PreviewReadException::class.java) { d.accept(win(0, 0, 900, eof = false)) }
    }

    @Test fun peekAssemblerClipsLongText() {
        val a = PeekAssembler(1000, clip = true, window = 600)
        a.accept(win(0, 600, 5000, eof = false))
        assertEquals(600 to 400, a.next())
        a.accept(win(600, 400, 5000, eof = false))
        assertEquals(1000, a.result!!.size)
    }
}
