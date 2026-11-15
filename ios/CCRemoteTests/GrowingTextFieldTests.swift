import XCTest
import SwiftUI
@testable import CCRemote

@MainActor
final class GrowingTextFieldTests: XCTestCase {
    private final class Draft: ObservableObject {
        @Published var text = ""
        @Published var height: CGFloat = 0
    }

    private struct Field: View {
        @ObservedObject var draft: Draft
        var body: some View {
            GrowingTextField(text: $draft.text, height: $draft.height,
                             maxHeight: GrowingTextField.height(lines: 6))
                .frame(width: 313, height: max(draft.height, GrowingTextField.height(lines: 1)))
        }
    }

    /// Runs the loop until the field stops moving. A fixed 30 ms was enough on
    /// an idle machine and not on the CI runner sharing the mini with a build:
    /// 24.09.2026 one of 286 went red on a commit and green on the next with the
    /// same code. The height travels @Published → SwiftUI frame → UIKit layout,
    /// and how long that takes is the machine's business, not the test's.
    private func settle(_ field: UITextView? = nil) {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03))
        guard let field else { return }
        var last = (field.bounds, field.contentSize, field.contentOffset)
        for _ in 0..<30 {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03))
            let now = (field.bounds, field.contentSize, field.contentOffset)
            if now == last { return }
            last = now
        }
    }

    private func withField(_ body: (UITextView, Draft) -> Void) {
        let draft = Draft()
        let host = UIHostingController(rootView: Field(draft: draft))
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 375, height: 667)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        settle()
        func find(_ view: UIView) -> UITextView? {
            if let field = view as? UITextView { return field }
            return view.subviews.lazy.compactMap(find).first
        }
        guard let field = find(host.view) else { return XCTFail("Missing composer") }
        field.becomeFirstResponder()
        settle(field)
        body(field, draft)
        window.isHidden = true
    }

    func testEveryWrappedLineKeepsCaretVisible() {
        withField { field, draft in
            for index in 1...80 {
                field.insertText("слово ")
                settle(field)
                let caret = field.caretRect(for: field.selectedTextRange!.end)
                XCTAssertLessThanOrEqual(caret.maxY, field.bounds.maxY + 1,
                    "Word \(index), caret \(caret), bounds \(field.bounds), content \(field.contentSize), height \(draft.height)")
                XCTAssertGreaterThanOrEqual(caret.minY, field.bounds.minY - 1)
                XCTAssertLessThanOrEqual(field.contentSize.width, field.bounds.width + 1)
            }
        }
    }

    func testNewlinesGrowImmediatelyAndDeletionShrinks() {
        withField { field, draft in
            for line in 1...10 {
                field.insertText(line == 1 ? "строка" : "\n")
                settle(field)
                XCTAssertEqual(draft.height, GrowingTextField.height(lines: min(line, 6)), accuracy: 1)
                let caret = field.caretRect(for: field.selectedTextRange!.end)
                XCTAssertLessThanOrEqual(caret.maxY, field.bounds.maxY + 1, "Line \(line)")
            }
            field.selectedRange = NSRange(location: 0, length: (field.text as NSString).length)
            field.insertText("Коротко")
            settle(field)
            XCTAssertEqual(draft.text, "Коротко")
            XCTAssertEqual(draft.height, GrowingTextField.height(lines: 1), accuracy: 1)
            XCTAssertEqual(field.contentOffset.y, 0, accuracy: 1)
        }
    }

    func testRapidTypingKeepsWrappingAfterHeightLimit() {
        withField { field, draft in
            for _ in 0..<10 {
                for character in "Ещё несколько слов в длинном сообщении. " {
                    field.insertText(String(character))
                }
                settle(field)
                let caret = field.caretRect(for: field.selectedTextRange!.end)
                XCTAssertLessThanOrEqual(caret.maxY, field.bounds.maxY + 1)
                XCTAssertGreaterThanOrEqual(caret.minY, field.bounds.minY - 1)
            }
        }
    }

    func testLongDraftCanBeScrolledUpWithoutSnappingBack() {
        withField { field, draft in
            draft.text = (1...30).map { "Строка \($0)" }.joined(separator: "\n")
            settle(field)
            field.selectedRange = NSRange(location: (field.text as NSString).length, length: 0)
            settle(field)
            field.contentOffset.y = 0
            field.setNeedsLayout()
            field.layoutIfNeeded()
            settle(field)
            XCTAssertEqual(field.contentOffset.y, 0, accuracy: 1)
        }
    }
}
