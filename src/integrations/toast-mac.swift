// The macOS notification that carries the agent's own words, with a click that opens that
// session's sheet on the board. The counterpart of toast.ps1; entrypoints/toast.ts runs it:
//   --title <text> --subtitle <text> --body <text> --id <herdr pane id>
//   --click-exe <program> --click-arg <argument>...   what a click runs (toast.ts click <pane>)
//   --wait <seconds>                                  how long it stays to catch the click
//   --frontmost                                       prints the frontmost app's bundle path
// The notification replaces the pane's earlier one (the id is the pane). A click runs the
// program without a shell and the process exits; a notification whose click came too late does
// nothing, and toast.ts then wakes it again with the next one.
//
// It is built into an .app bundle by integrations/toast-mac.ts: macOS shows notifications only
// for an app LaunchServices knows, and asks the user once to allow them.
import AppKit
import Foundation
import UserNotifications

func note(_ text: String) {
    FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

var argv = Array(CommandLine.arguments.dropFirst())

func has(_ name: String) -> Bool { argv.contains(name) }

func take(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    let value = argv[i + 1]
    argv.removeSubrange(i...(i + 1))
    return value
}

/// Every `name`'s value, in order.
func takeAll(_ name: String) -> [String] {
    var out: [String] = []
    while let value = take(name) { out.append(value) }
    return out
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if has("--frontmost") {
    print(NSWorkspace.shared.frontmostApplication?.bundleURL?.path ?? "")
    exit(0)
}

let title = take("--title") ?? "Claude"
let subtitle = take("--subtitle") ?? ""
let body = take("--body") ?? ""
let identity = take("--id") ?? UUID().uuidString
let wait = Double(take("--wait") ?? "600") ?? 600
let clickExe = take("--click-exe")
let clickArgs = takeAll("--click-arg")

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    var answered = false
    var click: (() -> Void)?

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            click?()
        }
        answered = true
        completionHandler()
    }
}

let center = UNUserNotificationCenter.current()
let delegate = Delegate()
center.delegate = delegate
if let clickExe {
    delegate.click = {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: clickExe)
        child.arguments = clickArgs
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try? child.run()
    }
}

/// Runs the run loop until `done` or `seconds` pass.
func pump(until done: () -> Bool, seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
}

var authorized = false
var answered = false
center.requestAuthorization(options: [.alert, .sound]) { granted, error in
    if let error { note("authorization: \(error)") }
    authorized = granted
    answered = true
}
// The first time, this is where the system asks the user; the prompt is answered in the run loop.
pump(until: { answered }, seconds: 120)
if !authorized {
    note("not allowed: System Settings > Notifications > \(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Claude")")
    exit(2)
}

let content = UNMutableNotificationContent()
content.title = title
if !subtitle.isEmpty { content.subtitle = subtitle }
if !body.isEmpty { content.body = body }
content.sound = nil

var added = false
center.add(UNNotificationRequest(identifier: identity, content: content, trigger: nil)) { error in
    if let error { note("add: \(error)") }
    added = true
}
pump(until: { added }, seconds: 10)
if !added { exit(1) }

pump(until: { delegate.answered }, seconds: wait)
