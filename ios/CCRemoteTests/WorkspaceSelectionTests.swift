import XCTest
@testable import CCRemoteKit

final class WorkspaceSelectionTests: XCTestCase {
    private func viewer(selected: String = "personal", teams: String = "") throws -> ViewerContext {
        let personal = #"{"workspaceId":"personal","name":"My Workspace","kind":"personal","role":"owner"}"#
        let data = """
        {"userId":"olya","platformAdmin":false,
         "workspace":\(selected == "personal" ? personal : selected),
         "workspaces":[\(personal)\(teams.isEmpty ? "" : "," + teams)]}
        """
        return try JSONDecoder().decode(ViewerContext.self, from: Data(data.utf8))
    }

    private let team = #"{"workspaceId":"hegai","name":"Hegai Team","kind":"organization","role":"member"}"#
    private let own = #"{"workspaceId":"own","name":"Own Team","kind":"organization","role":"owner"}"#

    func testPersonalWorkspaceIsNotListedAsTeam() throws {
        XCTAssertEqual(try viewer(teams: team).teams.map(\.id), ["hegai"])
    }

    func testFirstTelegramLoginSelectsSharedTeam() throws {
        XCTAssertEqual(try viewer(teams: team).preferredWorkspace(rememberedId: "").id, "hegai")
    }

    func testSavedPersonalSelectionMigratesToSharedTeam() throws {
        XCTAssertEqual(try viewer(teams: team).preferredWorkspace(rememberedId: "personal").id, "hegai")
    }

    func testQueuedPersonalMessagesDelayMigrationUntilSafe() throws {
        let context = try viewer(teams: team)
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "personal", hasQueuedMessages: true).id, "personal")
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "personal", hasQueuedMessages: false).id, "hegai")
    }

    func testQueuedMessagesPreserveCurrentlySelectedTeam() throws {
        let context = try viewer(selected: team, teams: own + "," + team)
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "own", hasQueuedMessages: true).id, "hegai")
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "own", hasQueuedMessages: false).id, "own")
    }

    func testExplicitTeamSurvivesAnotherOwnedTeam() throws {
        let context = try viewer(teams: own + "," + team)
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "hegai").id, "hegai")
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "removed").id, "own")
    }

    func testPersonalOnlyAccountStillWorks() throws {
        let context = try viewer()
        XCTAssertTrue(context.teams.isEmpty)
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "removed").id, "personal")
    }

    func testSelectedOrganizationWorksWithoutWorkspaceList() throws {
        let context = try JSONDecoder().decode(ViewerContext.self, from: Data("""
        {"userId":"olya","platformAdmin":false,"workspace":\(team),"workspaces":[]}
        """.utf8))
        XCTAssertEqual(context.teams.map(\.id), ["hegai"])
        XCTAssertEqual(context.preferredWorkspace(rememberedId: "").id, "hegai")
    }

    func testSwitcherHiddenWithOneTeamOrNone() throws {
        XCTAssertTrue(try viewer().switcherChoices.isEmpty)
        XCTAssertTrue(try viewer(teams: team).switcherChoices.isEmpty)
    }

    func testSwitcherOffersOnlyTeamsNeverPersonal() throws {
        let choices = try viewer(teams: team + "," + own).switcherChoices
        XCTAssertEqual(choices.map(\.id).sorted(), ["hegai", "own"])
    }

    func testRememberedPersonalNotHonouredWithTeams() throws {
        XCTAssertNotEqual(try viewer(teams: team + "," + own).preferredWorkspace(rememberedId: "personal").id, "personal")
    }
}
