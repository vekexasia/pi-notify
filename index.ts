/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, WezTerm, rxvt-unicode
 * - OSC 9: iTerm2
 * - OSC 99: Kitty
 * - tmux passthrough wrapper for OSC notifications
 * - Windows toast: Windows Terminal (WSL)
 * - Optional sound hook via PI_NOTIFY_SOUND_CMD
 *
 * Focus tracking:
 *   Notifications are automatically suppressed when the terminal is focused.
 *   Uses CSI ?1004h (terminal focus reporting) to track focus/blur.
 *   Other extensions can listen for changes via pi.events:
 *
 *   pi.events.on("pi-notify:focus", ({ focused }) => { ... });
 *
 * Customization:
 * - PI_NOTIFY_TITLE env var: notification title (default: "Pi")
 * - PI_NOTIFY_BODY  env var: notification body  (default: "{folder} — ready for input")
 *
 * Both support {placeholder} templates resolved at notification time:
 *   {cwd}    — full working directory path
 *   {folder} — basename of cwd
 *
 * Other extensions can hook into the "pi-notify:customize" event on pi.events
 * to dynamically change title, body, or add custom template variables:
 *
 *   pi.events.on("pi-notify:customize", (notification) => {
 *       notification.title = "Custom Title";
 *       notification.body  = "Done in {folder}!";
 *       notification.vars.myVar = "value";   // use as {myVar} in title/body
 *   });
 *
 * Other extensions can also send their own notifications via the "pi-notify:send" event:
 *
 *   pi.events.emit("pi-notify:send", { title: "My Extension", body: "Something happened!" });
 *
 * The send event accepts an optional `vars` object for template resolution.
 * If title or body are omitted, defaults are used (env vars or hardcoded fallbacks).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

/** Shape of the object passed to the "pi-notify:customize" event. */
export interface PiNotifyCustomization {
    title: string;
    body: string;
    /** Template variables available for {placeholder} resolution. Handlers can add new keys. */
    vars: Record<string, string>;
}

/** Shape of the object passed to the "pi-notify:send" event. All fields are optional. */
export interface PiNotifySend {
    title?: string;
    body?: string;
    /** Template variables for {placeholder} resolution. Merged with built-in vars (cwd, folder). */
    vars?: Record<string, string>;
    /** If true, skip the sound hook for this notification. */
    silent?: boolean;
    /** If true, send even when the terminal is focused (default: skip when focused). */
    force?: boolean;
}

// ── Notification transport ────────────────────────────────────────────────────

function windowsToastScript(title: string, body: string): string {
    const type = "Windows.UI.Notifications";
    const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
    const template = `[${type}.ToastTemplateType]::ToastText01`;
    const toast = `[${type}.ToastNotification]::new($xml)`;
    return [
        `${mgr} > $null`,
        `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
        `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
        `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
    ].join("; ");
}

function wrapForTmux(sequence: string): string {
    if (!process.env.TMUX) return sequence;
    const escaped = sequence.split("\x1b").join("\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
}

function notifyOSC777(title: string, body: string): void {
    const sequence = `\x1b]777;notify;${title};${body}\x07`;
    process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC9(message: string): void {
    const sequence = `\x1b]9;${message}\x07`;
    process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC99(title: string, body: string): void {
    const titleSequence = `\x1b]99;i=1:d=0;${title}\x1b\\`;
    const bodySequence = `\x1b]99;i=1:p=body;${body}\x1b\\`;
    process.stdout.write(wrapForTmux(titleSequence));
    process.stdout.write(wrapForTmux(bodySequence));
}

function notifyWindows(title: string, body: string): void {
    const { execFile } = require("node:child_process");
    execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function runSoundHook(): void {
    const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
    if (!command) return;
    try {
        const { spawn } = require("node:child_process");
        const child = spawn(command, { shell: true, detached: true, stdio: "ignore" });
        child.unref();
    } catch {}
}

function sendNotification(title: string, body: string): void {
    const isIterm2 = process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);
    if (process.env.WT_SESSION) {
        notifyWindows(title, body);
    } else if (process.env.KITTY_WINDOW_ID) {
        notifyOSC99(title, body);
    } else if (isIterm2) {
        notifyOSC9(`${title}: ${body}`);
    } else {
        notifyOSC777(title, body);
    }
}

/** Replace {key} placeholders with values from vars. Unknown placeholders are left as-is. */
function resolveTemplates(text: string, vars: Record<string, string>): string {
    return text.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

// ── Focus tracking via CSI ?1004h ─────────────────────────────────────────────

const FOCUS_IN = "\x1b[I";   // ESC [ I
const FOCUS_OUT = "\x1b[O";  // ESC [ O

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let focused = true; // assume focused on startup

    // Enable terminal focus reporting
    process.stdout.write("\x1b[?1004h");

    const stdinListener = (data: Buffer) => {
        const str = data.toString();
        if (str.includes(FOCUS_IN) && !focused) {
            focused = true;
            pi.events.emit("pi-notify:focus", { focused: true });
        }
        if (str.includes(FOCUS_OUT) && focused) {
            focused = false;
            pi.events.emit("pi-notify:focus", { focused: false });
        }
    };

    process.stdin.on("data", stdinListener);

    pi.on("session_shutdown", async () => {
        process.stdout.write("\x1b[?1004l");
        process.stdin.removeListener("data", stdinListener);
    });

    // ── Notify helper ──────────────────────────────────────────────────────

    function notify(
        rawTitle: string,
        rawBody: string,
        baseVars: Record<string, string>,
        options?: { silent?: boolean; customize?: boolean; force?: boolean },
    ): void {
        if (focused && !options?.force) return;

        const notification: PiNotifyCustomization = {
            title: rawTitle,
            body: rawBody,
            vars: { ...baseVars },
        };

        if (options?.customize !== false) {
            pi.events.emit("pi-notify:customize", notification);
        }

        const title = resolveTemplates(notification.title, notification.vars);
        const body = resolveTemplates(notification.body, notification.vars);

        sendNotification(title, body);

        if (!options?.silent) {
            runSoundHook();
        }
    }

    // ── agent_end: default notification ────────────────────────────────────

    pi.on("agent_end", async (_event, ctx) => {
        const cwd = ctx.cwd;
        const folder = path.basename(cwd);

        notify(
            process.env.PI_NOTIFY_TITLE ?? "Pi",
            process.env.PI_NOTIFY_BODY ?? "{folder} — ready for input",
            { cwd, folder },
        );
    });

    // ── pi-notify:send: let other extensions trigger notifications ─────────

    pi.events.on("pi-notify:send", (msg: PiNotifySend) => {
        const cwd = process.cwd();
        const folder = path.basename(cwd);
        const baseVars: Record<string, string> = { cwd, folder, ...msg.vars };

        notify(
            msg.title ?? process.env.PI_NOTIFY_TITLE ?? "Pi",
            msg.body ?? "Notification",
            baseVars,
            { silent: msg.silent, force: msg.force },
        );
    });
}
