// The macOS notification that carries the agent's own words, with a click that opens that
// session's sheet on the board. The counterpart of toast.ps1; entrypoints/toast.ts runs it:
//   --title <text> --subtitle <text> --body <text> --id <herdr pane id>
//   --click-exe <program> --click-arg <argument>...   what a click runs (toast.ts click <pane>)
//   --wait <seconds>                                  how long it stays to catch the click
//   --frontmost                                       alone: prints the frontmost app's bundle path
// The notification replaces the pane's earlier one (the id is the pane). A click runs the
// program without a shell and the process exits. The program and its arguments also travel in the
// notification (userInfo), for a click that comes after this process has gone: where macOS starts
// the app again for it, it has no arguments, so it posts nothing, waits about 5 seconds for that
// click, runs it from the notification and exits. That is what the code does; it has not been tried
// on a Mac. A click that reaches no process does nothing, and toast.ts starts one with the next toast.
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

// toast.ts passes --frontmost alone: a notification whose body is that word is only a body.
if argv.first == "--frontmost" {
    print(NSWorkspace.shared.frontmostApplication?.bundleURL?.path ?? "")
    exit(0)
}

let title = take("--title") ?? "Claude"
let subtitle = take("--subtitle") ?? ""
let body = take("--body") ?? ""
let givenId = take("--id")
let wait = Double(take("--wait") ?? "600") ?? 600
let clickExe = take("--click-exe")
let clickArgs = takeAll("--click-arg")

/// Runs the click's program without a shell; the process does not wait for it.
func runClick(_ exe: String, _ args: [String]) {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: exe)
    child.arguments = args
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    try? child.run()
}

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
            // The notification carries its click's program, so one posted by a process that has gone
            // is run too; this process's own click is the fallback.
            let info = response.notification.request.content.userInfo
            if let exe = info["exe"] as? String, let args = info["args"] as? [String] {
                runClick(exe, args)
            } else {
                click?()
            }
        }
        answered = true
        completionHandler()
    }
}

let center = UNUserNotificationCenter.current()
let delegate = Delegate()
center.delegate = delegate
if let clickExe {
    delegate.click = { runClick(clickExe, clickArgs) }
}

/// Runs the run loop until `done` or `seconds` pass.
func pump(until done: () -> Bool, seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
}

// No --id: macOS started the app by itself, for a click on a notification whose process has gone.
// There is nothing to post; the click comes to the delegate set above, if it comes.
guard let identity = givenId else {
    pump(until: { delegate.answered }, seconds: 5)
    exit(0)
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
// What a click runs, for a click that comes when this process has gone.
if let clickExe { content.userInfo = ["exe": clickExe, "args": clickArgs] }

var added = false
center.add(UNNotificationRequest(identifier: identity, content: content, trigger: nil)) { error in
    if let error { note("add: \(error)") }
    added = true
}
pump(until: { added }, seconds: 10)
if !added { exit(1) }

pump(until: { delegate.answered }, seconds: wait)
