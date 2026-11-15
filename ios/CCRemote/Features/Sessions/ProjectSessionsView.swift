import SwiftUI
import CCRemoteKit

/// Sessions belonging to one project, spanning every machine. Each row is tagged
/// with the server it lives on. Pushed from the Sessions tab and the Home grid.
struct ProjectSessionsView: View {
    let project: String
    @Environment(CentralClient.self) private var client

    private var items: [SessionItem] {
        ProjectGrouping.myItems(from: client.machines, viewerId: client.effectiveViewerId, runs: client.activeRuns)
            .filter { ($0.session.project ?? "—") == project }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                if items.isEmpty {
                    Text("В этом проекте нет сессий.")
                        .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.s4)
                } else {
                    ForEach(items) { item in
                        SessionRow(item: item, showServer: true)
                        Divider().overlay(Theme.border).padding(.leading, Theme.s3)
                    }
                }
            }
            .padding(.horizontal, Theme.s2)
            .padding(.vertical, Theme.s2)
        }
        .background(Theme.bg)
        .navigationTitle(project)
        .inlineTitle()
    }
}
