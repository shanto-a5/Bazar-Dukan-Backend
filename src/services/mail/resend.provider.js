import { Resend } from "resend";
import { resendApiKey, mailFrom } from "../../constance.js";

/**
 * The Resend provider: real delivery through the official SDK.
 *
 * It receives exactly what the auth service handed to the mailer — recipient,
 * subject and the finished plain-text message with the reset link already in
 * it. Nothing here generates a token, knows about sessions or decides who
 * gets mail; it only transports a message that was built elsewhere.
 *
 * The API key is read from configuration at the moment it is needed and is
 * never written to a log, an error message or a response. Failures come back
 * as an ordinary Error carrying the provider's reason, so the caller decides
 * what the outside world is told (the auth service tells it nothing).
 */
let client = null;

/** Builds the real client on first use; also called by startup validation. */
const assertConfig = () => {
    const apiKey = resendApiKey();
    if (!apiKey) {
        throw new Error('MAIL_PROVIDER "resend" requires RESEND_API_KEY to be set.');
    }
    client ??= new Resend(apiKey);
    return client;
};

/**
 * Test seam: automated tests install a stub client so no real mail is ever
 * sent from `npm test`. Production code never calls this.
 */
const setClient = (next) => {
    client = next;
};

const HTML_SHELL = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111">%s</body></html>`;

const escapeHtml = (value) =>
    value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);

/** Plain text in, plain HTML out — presentation only, never new content. */
const toHtml = (text) => {
    const paragraphs = escapeHtml(text)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : `<p style="margin:0 0 12px">${line}</p>`))
        .join("");

    return HTML_SHELL.replace("%s", paragraphs);
};

const send = async ({ to, subject, text }) => {
    const resend = assertConfig();

    let response;
    try {
        response = await resend.emails.send({
            from: mailFrom(),
            to,
            subject,
            html: toHtml(text)
        });
    } catch (error) {
        // transport-level failure (DNS, timeout): no key, no request body
        throw new Error(`Resend send failed: ${error.message}`);
    }

    const { data, error } = response ?? {};
    if (error) {
        throw new Error(`Resend send failed: ${error.name ?? "error"}: ${error.message ?? "unknown error"}`);
    }

    return { id: data?.id ?? "" };
};

export { send, assertConfig, setClient };
