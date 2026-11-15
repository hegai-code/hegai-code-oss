#if DEBUG
import UIKit

/// A DEBUG-only audit of the fonts the design system is built on.
///
/// This exists because an unregistered custom font fails *silently*: `Font.custom`
/// falls back to the system face, the build stays green, and the screenshot looks
/// plausible — just in SF instead of Onest. There is no error, no warning, and no
/// visual cue unless you already know the shapes. The failure is cheap to cause
/// (a typo in UIAppFonts, a renamed file from `scripts/fetch-fonts.sh`) and
/// expensive to notice, so the app shouts about it on every debug launch.
///
/// It reports PostScript names via `UIFont.fontNames(forFamilyName:)`, NOT family
/// names, because the PostScript name is the string `Font.custom` actually takes
/// and it is frequently NOT the filename. IBM Plex Mono is the live example: the
/// files are `IBMPlexMono-Medium.ttf` / `-SemiBold.ttf` but the names inside them
/// are `IBMPlexMono-Medm` / `IBMPlexMono-SmBld`. Guessing here costs an afternoon.
enum BundledFonts {
    /// Family name -> the PostScript names it must expose. Keep in step with
    /// UIAppFonts in project.yml and the output of scripts/fetch-fonts.sh.
    static let expected: [(family: String, postScriptNames: [String])] = [
        ("Onest", ["Onest-Regular", "Onest-Medium", "Onest-SemiBold", "Onest-Bold"]),
        ("IBM Plex Mono", ["IBMPlexMono", "IBMPlexMono-Medm", "IBMPlexMono-SmBld"]),
        ("Source Serif 4", ["SourceSerif4-Regular", "SourceSerif4-It"]),
    ]

    /// Print what CoreText actually registered, and flag anything missing.
    static func audit() {
        var missing: [String] = []
        print("┌─ bundled fonts ────────────────────────────────────────────")
        for (family, wanted) in expected {
            let got = UIFont.fontNames(forFamilyName: family).sorted()
            if got.isEmpty {
                print("│ ✗ \(family) — FAMILY NOT REGISTERED")
                missing.append(contentsOf: wanted)
                continue
            }
            print("│ \(family)")
            for name in got {
                // A registered name that nobody expected is not an error — it is
                // usually a weight we shipped and have not wired up yet.
                print("│     \(wanted.contains(name) ? "✓" : "·") \(name)")
            }
            for name in wanted where !got.contains(name) {
                print("│     ✗ \(name) — MISSING")
                missing.append(name)
            }
        }
        if missing.isEmpty {
            print("│ all \(expected.reduce(0) { $0 + $1.postScriptNames.count }) faces registered")
        } else {
            print("│ ⚠️  \(missing.count) MISSING: \(missing.joined(separator: ", "))")
            print("│ → check UIAppFonts in project.yml, rerun scripts/fetch-fonts.sh,")
            print("│   and remember Font.custom takes the PostScript name, not the filename.")
        }
        print("└────────────────────────────────────────────────────────────")
    }
}
#endif
