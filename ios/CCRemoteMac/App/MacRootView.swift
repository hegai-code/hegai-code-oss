import SwiftUI

/// The window: a permanent rail, then whichever destination it selects.
///
/// Sessions is the only destination with a contextual column, so it is the only
/// one wrapped in a `NavigationSplitView`; the rest are full-width panes. That
/// mirrors the web's nav model, where Board/Flow are lenses inside Sessions and
/// the other destinations stand alone.
struct MacRootView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        Group {
            if settings.isConfigured {
                ZStack(alignment: .bottom) {
                    HStack(spacing: 0) {
                        // Navigation targets set `router.destination` themselves
                        // (openSession, palette, menu commands), so the rail is a
                        // plain binding onto the shared truth — no onChange hacks.
                        MacRail(selection: $router.destination)
                        Divider()
                        content
                    }
                    HubStatusOverlay()
                        .padding(.bottom, Theme.s4)
                }
                .overlay {
                    if router.paletteOpen { MacCommandPalette() }
                }
            } else {
                MacSignInView()
            }
        }
        .background(Theme.bg)
    }

    @ViewBuilder
    private var content: some View {
        switch router.destination {
        case .home:
            MacHomePane()
        case .sessions:
            NavigationSplitView {
                MacSidebar()
                    .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 420)
            } detail: {
                sessionDetail
            }
        case .board:
            MacBoardPane()
        case .columns:
            MacColumnsPane()
        case .team:
            NavigationStack { TeamView() }
        case .hardware:
            NavigationStack { HardwareView() }
        case .memory:
            MacMemoryPane()
        case .profile:
            ProfileView()
        case .inbox:
            NavigationStack { NotificationCenterView() }
        }
    }

    @ViewBuilder
    private var sessionDetail: some View {
        if let route = router.selectedSession {
            // The same workspace the phone runs — history load, the convergence
            // pass, mirror + takeover, approvals. Sharing the view rather than a
            // model is what keeps those invariants literally identical.
            SessionDetailView(machineId: route.machineId, sessionId: route.sessionId)
                .id(route.id)
        } else if let project = router.selectedProject {
            ProjectSessionsView(project: project.project)
        } else {
            MacStartPane()
        }
    }
}
