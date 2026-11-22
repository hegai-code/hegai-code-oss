package net.hegai.code.core

/** Web `canEditSession`: the owner of the machine, or the person who owns the session on a shared one. */
fun HubState.canDeleteSession(machine: Machine, session: Session): Boolean =
    machine.canControl || (session.owner != null && session.owner.userId == viewer?.userId)
