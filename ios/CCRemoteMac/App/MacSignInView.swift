import SwiftUI
import CCRemoteKit

/// First run: pick the hub, sign in with Google.
///
/// The SSO flow is the iOS one unchanged — `/api/auth/google/start?native=1` ends at
/// `ccremote://auth?session=…`, `ASWebAuthenticationSession` catches it, and the
/// token goes to the Keychain. Only the presentation anchor differs, and that
/// lives in CCRemoteKit behind a `canImport` branch.
struct MacSignInView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @Environment(HegaiAuth.self) private var auth

    var body: some View {
        @Bindable var settings = settings
        VStack(spacing: Theme.s5) {
            VStack(spacing: Theme.s3) {
                HegaiMark(size: 52).foregroundStyle(Theme.primary)
                Text("Hegai Code")
                    .font(.ui(24, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("Ваши агенты на всех машинах — в одном окне.")
                    .font(.ui(14))
                    .foregroundStyle(Theme.text2)
            }

            VStack(alignment: .leading, spacing: Theme.s2) {
                SectionLabel(text: "Хаб")
                TextField("wss://…", text: $settings.hubURL)
                    .textFieldStyle(.roundedBorder)
                    .font(.mono(12))
                    .frame(width: 380)
                    .autocorrectionDisabled()
            }

            // Not `.borderedProminent`: AppKit inks a prominent button white, and
            // ivory on ember measures 2.7:1. DESIGN.md is explicit — on ember, ink
            // only. So the fill is drawn here and `onPrimary` stays authoritative.
            Button {
                Task { await signIn() }
            } label: {
                HStack(spacing: Theme.s2) {
                    if auth.signingIn {
                        ProgressView().controlSize(.small).tint(Theme.onPrimary)
                    }
                    Text(auth.signingIn ? "Открываем вход…" : "Войти через Google")
                        .font(.ui(14, weight: .semibold))
                }
                .foregroundStyle(Theme.onPrimary)
                .frame(width: 240, height: 38)
                .background(Theme.primary, in: RoundedRectangle(cornerRadius: Theme.radius))
            }
            .buttonStyle(.plain)
            .disabled(auth.signingIn || settings.hubURL.isEmpty)

            if let error = auth.lastError {
                Text(error)
                    .font(.ui(12))
                    .foregroundStyle(Theme.negative)
            }
        }
        .padding(Theme.s8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }

    private func signIn() async {
        guard let session = await auth.signIn(hubURL: settings.hubURL) else { return }
        settings.token = session
        client.connect(endpoint: settings.hubURL, token: session,
                       workspaceId: settings.workspaceId.isEmpty ? nil : settings.workspaceId)
    }
}
