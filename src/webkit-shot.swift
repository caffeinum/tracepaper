import AppKit
import WebKit

// Offscreen WKWebView snapshot, the same idea as webkit-cli's shot (Mac/Browser.swift
// snapshotPNG + a window parked at -20000,-20000). Size comes from the caller so a tall
// frame is the whole page, not the 1280×800 viewport webkit-cli hardcodes.
//
//   webkit-shot <url> <cssWidth> <cssHeight> <out.png>

let args = CommandLine.arguments
guard args.count == 5, let width = Int(args[2]), let height = Int(args[3]), width > 0, height > 0,
      let url = URL(string: args[1]) else {
  fputs("usage: webkit-shot <url> <cssWidth> <cssHeight> <out.png>\n", stderr)
  exit(2)
}
let out = args[4]

final class Shot: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  let out: String

  init(url: URL, width: Int, height: Int, out: String) {
    self.out = out
    let size = NSSize(width: width, height: height)
    web = WKWebView(frame: NSRect(origin: .zero, size: size))
    window = NSWindow(
      contentRect: NSRect(origin: NSPoint(x: -20000, y: -20000), size: size),
      styleMask: .borderless,
      backing: .buffered,
      defer: false
    )
    super.init()
    window.contentView = web
    window.orderFrontRegardless()
    web.navigationDelegate = self
    web.load(URLRequest(url: url))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // give layout and webfonts a beat; webkit-cli waits for the load, we add a short settle
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      guard let self else { return }
      let config = WKSnapshotConfiguration()
      config.rect = self.web.bounds
      // backing store is already the screen scale (2× on retina). don't multiply again.
      self.web.takeSnapshot(with: config) { image, error in
        guard let image, let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
          fputs("snapshot failed: \(error?.localizedDescription ?? "no image")\n", stderr)
          exit(1)
        }
        do {
          try png.write(to: URL(fileURLWithPath: self.out))
          exit(0)
        } catch {
          fputs("\(error)\n", stderr)
          exit(1)
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    fputs("load failed: \(error.localizedDescription)\n", stderr)
    exit(1)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    fputs("load failed: \(error.localizedDescription)\n", stderr)
    exit(1)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let shot = Shot(url: url, width: width, height: height, out: out)
DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
  fputs("webkit-shot timed out\n", stderr)
  exit(1)
}
app.run()
_ = shot
