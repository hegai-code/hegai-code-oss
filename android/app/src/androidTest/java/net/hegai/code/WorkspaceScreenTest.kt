package net.hegai.code

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.serialization.json.JsonObject
import net.hegai.code.core.*
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import androidx.compose.ui.unit.dp

/** Run on an emulator/device; synthetic state never touches production sessions. */
class WorkspaceScreenTest {
    @get:Rule val compose = createComposeRule()
    @Test fun projectDrawerOpensAndSelectsSession() {
        val screen = mutableStateOf(HubState())
        val sent = mutableListOf<JsonObject>()
        val engine = HubEngine(send = { sent += it; true }, changed = { screen.value = it })
        engine.connected()
        engine.receive("""{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Mac mini"},"online":true,"canControl":true,"sessions":[{"sessionId":"s","title":"Android prototype","cwd":"/work/hegai","project":"hegai","source":"codex"}]}]}""")
        compose.setContent { HegaiTheme { WorkspaceScreen(screen.value, engine, {}, {}) } }
        compose.onNodeWithContentDescription("Открыть меню").performClick()
        // The start screen lists the same session; the drawer's entry is the navigation item (Role.Tab).
        compose.onNode(hasText("Android prototype") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Tab)).performClick()
        // Complete the history request, as the real transport does, so this test
        // exercises the loaded conversation and its enabled composer.
        compose.runOnUiThread {
            val requestId = sent.last { it.string("type") == "rpc_request" }.string("requestId")
            engine.receive("""{"type":"rpc_response","requestId":"$requestId","ok":true,"result":{"messages":[]}}""")
        }
        compose.runOnIdle { assertEquals("s", screen.value.target?.sessionId) }
        compose.onNodeWithText("Сообщение…").assertIsDisplayed()
    }
    /** The new home must use the drawer's ownership and automation filters, and opening a
     * recent conversation must remain a read until the person actually submits a message. */
    @Test fun recentHomeKeepsOwnershipAndOpensWithoutStartingAWriter() {
        val screen = mutableStateOf(HubState())
        val sent = mutableListOf<JsonObject>()
        val engine = HubEngine(send = { sent += it; true }, changed = { screen.value = it })
        engine.connected()
        engine.receive("""{"type":"snapshot","viewer":{"userId":"u"},"machines":[{"machine":{"machineId":"m","name":"Shared"},"shared":true,"online":true,"canControl":true,"sessions":[{"sessionId":"mine","title":"Мой разговор","cwd":"/work/app","owner":{"userId":"u"}},{"sessionId":"other","title":"Чужой разговор","cwd":"/work/other","owner":{"userId":"other"}},{"sessionId":"auto","title":"Автоматизация","cwd":"/tmp/job","owner":{"userId":"u"}}]}]}""")
        compose.setContent { HegaiTheme { WorkspaceScreen(screen.value, engine, {}, {}) } }
        compose.onNodeWithText("Недавние разговоры").assertIsDisplayed()
        compose.onNodeWithText("Чужой разговор").assertDoesNotExist()
        compose.onNodeWithText("Автоматизация").assertDoesNotExist()
        compose.onNode(hasText("Мой разговор") and !SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Tab)).performClick()
        compose.runOnIdle {
            assertEquals("mine", engine.state.target?.sessionId)
            assertEquals(emptyList<JsonObject>(), sent.filter { it.string("type") in listOf("new_session", "open", "input", "takeover") })
        }
    }
    @Test fun inactiveViewerGetsWaitingScreenWithoutComposer() {
        compose.setContent { HegaiTheme { WorkspaceScreen(
            HubState(connection = Connection.READY, viewer = Viewer("u", "u@test", access = Access("waitlist"))),
            HubEngine(send = { true }), {}, {},
        ) } }
        compose.onNodeWithText("Вы в списке ожидания").assertIsDisplayed()
        compose.onNodeWithContentDescription("Отправить").assertDoesNotExist()
    }
    @Test fun questionSupportsMultipleChoicesAndPlanHasTwoApprovalModes() {
        val screen = mutableStateOf(HubState())
        val sent = mutableListOf<JsonObject>()
        val engine = HubEngine(send = { sent += it; true }, changed = { screen.value = it })
        engine.connected()
        engine.receive("""{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Test"},"online":true,"canControl":true,"sessions":[{"sessionId":"s","title":"Chat","cwd":"/work"}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working"}]}""")
        engine.select(net.hegai.code.core.Target("m", "/work", "s"))
        engine.receive("""{"type":"tool_request","runId":"r","requestId":"q","tool":"AskUserQuestion","input":{"questions":[{"id":"pick","question":"Choose","multiSelect":true,"options":[{"label":"A"},{"label":"B"}]}]}}""")
        compose.setContent { HegaiTheme { WorkspaceScreen(screen.value, engine, {}, {}) } }
        compose.onNodeWithText("A").performClick(); compose.onNodeWithText("B").performClick()
        compose.onNodeWithText("Ответить").performClick()
        compose.runOnIdle {
            assertEquals("tool_decision", sent.last().string("type"))
            assertEquals("[\"A\",\"B\"]", sent.last().objectValue("updatedInput")?.objectValue("answers")?.get("pick").toString())
            engine.receive("""{"type":"tool_request","runId":"r","requestId":"plan","tool":"ExitPlanMode","input":{"plan":"# Plan"}}""")
        }
        compose.onNodeWithText("Подтвердить и принимать правки").performClick()
        compose.runOnIdle { assertEquals(sent.toString(), "acceptEdits", sent.lastOrNull { it.string("type") == "tool_decision" }.let { it?.string("permissionMode") }) }
    }
    /** Owner 26.09: on a narrow phone «Новый чат» wrapped to «Новый / чат»; the inbox count must stay announced. */
    @Test fun drawerBottomBarStaysOneLineOnNarrowPhone() {
        val screen = mutableStateOf(HubState())
        val engine = HubEngine(send = { true }, changed = { screen.value = it })
        engine.connected()
        engine.receive("""{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"stage"},"online":true,"canControl":true,"sessions":[{"sessionId":"s","title":"Встреча Орлов и Латыпов","cwd":"/work/hegai","project":"hegai"}]}]}""")
        val run = Run("r", "m", "s", "done")
        val state = screen.value.copy(notices = List(6) { Notice("n$it", run, 0) })
        compose.setContent {
            val narrow = android.content.res.Configuration(androidx.compose.ui.platform.LocalConfiguration.current).apply { screenWidthDp = 320 }
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalConfiguration provides narrow) {
                HegaiTheme { WorkspaceScreen(state, engine, {}, {}) }
            }
        }
        compose.onNodeWithContentDescription("Открыть меню").performClick()
        // The approved design keeps New chat in the scrollable area and settings in the header.
        compose.onAllNodesWithContentDescription("Новый чат").onFirst().assertIsDisplayed()
        compose.onNodeWithContentDescription("Входящие: 6").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Настройки").onFirst().assertIsDisplayed()
    }
    /** Owner 26.09: the drawer opened straight into the search keyboard, and a project listed every
     * session inline. Now nothing takes focus on open, and a project shows 4 + «Все сессии · N» → drill-in. */
    @Test fun drawerDoesNotFocusSearchAndDrillsIntoProject() {
        val screen = mutableStateOf(HubState())
        val engine = HubEngine(send = { true }, changed = { screen.value = it })
        engine.connected()
        val sessions = (1..6).joinToString(",") { """{"sessionId":"s$it","title":"Сессия $it","cwd":"/work/app","project":"app","lastModified":${1000 - it}}""" }
        engine.receive("""{"type":"snapshot","viewer":{"userId":"u"},"machines":[{"machine":{"machineId":"m","name":"Box"},"online":true,"canControl":true,"canStart":true,"sessions":[$sessions]}]}""")
        compose.setContent { HegaiTheme { WorkspaceScreen(screen.value, engine, {}, {}) } }
        compose.onNodeWithContentDescription("Открыть меню").performClick()
        compose.waitForIdle()
        compose.onAllNodes(isFocused()).assertCountEquals(0)
        val drawerItem = SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Tab)
        compose.onAllNodes(drawerItem and hasText("Сессия", substring = true)).assertCountEquals(4)
        compose.onNodeWithText("Все сессии · 6").performClick()
        compose.waitForIdle()
        // Sessions 5 and 6 exist only on the drill-in screen (the drawer behind it still shows 1–4).
        compose.onAllNodes(drawerItem and hasText("Сессия 5")).assertCountEquals(1)
        compose.onAllNodes(drawerItem and hasText("Сессия 6")).assertCountEquals(1)
    }

    @Test fun continueKeepsDraftAndCompactionWaitsForCompletion() {
        val screen = mutableStateOf(HubState())
        val sent = mutableListOf<JsonObject>()
        val engine = HubEngine(send = { sent += it; true }, changed = { screen.value = it })
        engine.connected()
        engine.receive("""{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Test"},"online":true,"canControl":true,"sessions":[{"sessionId":"s","title":"Parity chat","cwd":"/work"}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle"}]}""")
        engine.select(net.hegai.code.core.Target("m", "/work", "s"))
        val requestId = sent.last().string("requestId")
        engine.receive("""{"type":"rpc_response","requestId":"$requestId","ok":true,"result":{"messages":[]}}""")
        engine.receive("""{"type":"stream","runId":"r","event":{"kind":"result"}}""")
        engine.receive("""{"type":"context_usage","runId":"r","totalTokens":241884,"maxTokens":922000,"percentage":26}""")
        compose.setContent { HegaiTheme { WorkspaceScreen(screen.value, engine, {}, {}) } }
        compose.onNodeWithText("26%").performClick()
        compose.onNodeWithText("Сжать контекст").performClick()
        compose.onNodeWithText("Запросили сжатие…").assertIsDisplayed()
        compose.runOnUiThread { engine.receive("""{"type":"stream","runId":"r","event":{"kind":"status","code":"compact_done"}}""") }
        compose.onAllNodesWithText("Контекст сжат").onLast().assertIsDisplayed()
        compose.onNodeWithText("Закрыть").performClick()
        compose.runOnUiThread {
            // A quiet convergence read doesn't lock the composer.
            engine.editDraft("keep this draft")
        }
        compose.onNodeWithText("Продолжить").performClick()
        compose.runOnIdle {
            assertEquals("Продолжай", sent.last { it.string("type") == "input" }.string("text"))
            assertEquals("keep this draft", engine.state.draft)
        }
    }
}
