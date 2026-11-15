import SwiftUI
import UIKit
import CCRemoteKit

/// Thin bridge to `UIImagePickerController` in camera mode — PhotosPicker covers
/// the library, but there is no first-party SwiftUI camera capture yet. Returns
/// a downscaled `ImageAttachment` (or nothing on cancel). Camera is unavailable
/// on the Simulator; callers gate on `UIImagePickerController.isSourceTypeAvailable`.
struct CameraPicker: UIViewControllerRepresentable {
    var onCapture: (ImageAttachment) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage,
               let att = ImageAttachment.make(from: image) {
                parent.onCapture(att)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
