package net.hegai.code.core

/** OpenCode is not a runtime: on the wire it is a Codex session whose model id starts with `pool-go/`
 * (agent/src/opencode-go.ts). The client-local choice is `Target.agent == OPENCODE`; it is never a `source`. */
object OpenCode {
    const val AGENT = "opencode"
    const val GO_PREFIX = "pool-go/"
    const val DEFAULT_MODEL = "pool-go/glm-5.3"

    fun isGo(model: String?): Boolean = model != null && model.startsWith(GO_PREFIX)
    fun isGo(row: ModelChoice): Boolean = isGo(row.id)

    /** The Codex model list carries at least one Go row. */
    fun available(codexModels: List<ModelChoice>): Boolean = codexModels.any(::isGo)

    /** The explicit model an OpenCode start sends: the remembered pick while it is still a listed Go row,
     * else glm-5.3 when listed, else the first Go row. An empty/unknown list still yields a Go model. */
    fun startModel(remembered: String?, codexModels: List<ModelChoice>): String {
        val go = codexModels.filter(::isGo).map { it.id }
        if (isGo(remembered) && (go.isEmpty() || remembered in go)) return remembered!!
        if (go.isEmpty() || DEFAULT_MODEL in go) return DEFAULT_MODEL
        return go.first()
    }

    /** Whether the model picker for this chat is the Go list: an OpenCode start target, or a live/resumed
     * session whose running model (else option model) is a Go row. The agent refuses switching across. */
    fun isOpenCodeChat(target: Target?, activeModel: String?, optionsModel: String?): Boolean {
        if (target == null || target.source != "codex") return false
        return if (target.sessionId == null) target.isOpenCode else isGo(activeModel ?: optionsModel)
    }

    /** Rows the picker may offer for a Codex chat; the account-default row is dropped by the caller for Go. */
    fun rowsFor(codexModels: List<ModelChoice>, openCode: Boolean): List<ModelChoice> =
        codexModels.filter { it.id != "default" && isGo(it) == openCode }
}

val Target.isOpenCode: Boolean get() = source == "codex" && agent == OpenCode.AGENT
