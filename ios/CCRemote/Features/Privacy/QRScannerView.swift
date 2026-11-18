#if canImport(UIKit)
import AVFoundation
import SwiftUI
import UIKit

/// Full-screen camera that reads one QR code (the pairing code a private machine
/// prints) and hands its text back. The camera is asked for only here, with the
/// reason in Info.plist (`NSCameraUsageDescription`).
struct QRScannerScreen: View {
    /// Which scanned texts count. Pairing codes are `hcp1.…`; the server-code
    /// scan (login screen) accepts anything and lets `HubLink.parse` judge.
    var accept: (String) -> Bool = { $0.hasPrefix("hcp1.") }
    var hint = "Наведите камеру на QR-код, который напечатала команда --pair"
    let onCode: (String) -> Void
    let onCancel: () -> Void
    @State private var failure: String?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            QRScannerRepresentable(accept: accept, onCode: onCode, onFailure: { failure = $0 })
                .ignoresSafeArea()
            if let failure {
                VStack(spacing: Theme.s3) {
                    Text(failure).font(SettingsStyle.body).foregroundStyle(.white).multilineTextAlignment(.center)
                    ActionButton("Закрыть", kind: .quiet) { onCancel() }
                }
                .padding(Theme.s5)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.opacity(0.85))
            } else {
                Text(hint)
                    .font(SettingsStyle.caption).foregroundStyle(.white)
                    .padding(Theme.s3).background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, Theme.s6)
            }
            Button { onCancel() } label: {
                Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    .background(Color.black.opacity(0.5), in: Circle())
            }
            .padding(Theme.s4)
            .accessibilityLabel("Закрыть камеру")
            .accessibilityIdentifier("pair.scan.close")
        }
        .background(Color.black)
    }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let accept: (String) -> Bool
    let onCode: (String) -> Void
    let onFailure: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let c = QRScannerController()
        c.accept = accept
        c.onCode = onCode
        c.onFailure = onFailure
        return c
    }
    func updateUIViewController(_ controller: QRScannerController, context: Context) {}
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var accept: (String) -> Bool = { $0.hasPrefix("hcp1.") }
    var onCode: ((String) -> Void)?
    var onFailure: ((String) -> Void)?
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "net.hegai.ccremote.qr")
    private var preview: AVCaptureVideoPreviewLayer?
    private var configured = false
    private var delivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.configure(); self?.startIfReady() }
                    else { self?.fail("Нет доступа к камере. Разрешите её в Настройках iPhone или вставьте код текстом.") }
                }
            }
        default:
            fail("Нет доступа к камере. Разрешите её в Настройках iPhone или вставьте код текстом.")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startIfReady()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        queue.async { if s.isRunning { s.stopRunning() } }
    }

    private func startIfReady() {
        guard configured else { return }
        let s = session
        queue.async { if !s.isRunning { s.startRunning() } }
    }

    private func configure() {
        guard !configured else { return }
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            fail("Камера недоступна на этом устройстве. Вставьте код текстом.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { fail("Не удалось включить распознавание QR."); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        configured = true
    }

    private func fail(_ text: String) { onFailure?(text) }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !delivered,
              let text = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue })
                .first(where: accept)
        else { return }
        delivered = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(text)
    }
}
#endif
