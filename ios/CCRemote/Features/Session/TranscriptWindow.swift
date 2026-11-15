import Foundation

/// Mount a small, exactly measured tail first. Earlier rows remain available in
/// memory and are revealed on demand. Keep the first row's identity as new
/// replies arrive, so the visible document never slides out from under a reader.
struct TranscriptWindow {
    static let pageSize = 30
    /// Mounted rows past which a reader following the tail gets the window cut back to a page.
    static let trimLimit = pageSize * 3
    private(set) var firstID: String?

    func startIndex(in ids: [String]) -> Int {
        // Row ids are unique; the start sits near the tail, so search from there.
        if let firstID, let index = ids.lastIndex(of: firstID) { return index }
        return max(0, ids.count - Self.pageSize)
    }

    mutating func retainStart(in ids: [String]) {
        guard !ids.isEmpty else { return }
        firstID = ids[startIndex(in: ids)]
    }

    mutating func revealEarlier(in ids: [String]) {
        guard !ids.isEmpty else { return }
        firstID = ids[max(0, startIndex(in: ids) - Self.pageSize)]
    }

    /// The reader follows the tail, so rows far above are not being read: cut the window back
    /// to one page once it has grown past `trimLimit`. Without it the window only ever grows,
    /// with every reply mounted eagerly. Call only while the reader is at the bottom and
    /// following; "Показать более ранние" brings the rest back.
    mutating func trimToTail(in ids: [String]) {
        guard !ids.isEmpty, ids.count - startIndex(in: ids) > Self.trimLimit else { return }
        firstID = ids[max(0, ids.count - Self.pageSize)]
    }
}
