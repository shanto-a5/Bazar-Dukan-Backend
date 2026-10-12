import { mailProvider } from "../constance.js";
import * as consoleProvider from "./mail/console.provider.js";
import * as resendProvider from "./mail/resend.provider.js";

/**
 * Mail boundary.
 *
 * Password reset is the one flow where "the server sent something" is part of
 * the contract, but nothing in the auth service may know how mail actually
 * leaves. Everything above this module calls `sendMail`; adding or swapping a
 * transport is a change here and in `mail/`, never in `auth.service.js`.
 *
 * The chain is:
 *
 *     auth.service.js  →  sendMail()  →  providers[MAIL_PROVIDER].send()
 *                                              ├─ console  (development, tests)
 *                                              └─ resend   (real delivery)
 *
 * Selection is configuration, not a code path: `MAIL_PROVIDER` names one of
 * the providers below, an unknown name is an error rather than a fallback, and
 * a provider that is misconfigured fails here — at startup and again on every
 * send — instead of failing halfway through a user's password reset.
 *
 * `console` is refused in production: it would write live reset links into a
 * log collector. Session bearer tokens are never printed anywhere.
 */
const providers = {
    console: consoleProvider,
    resend: resendProvider
};

/**
 * Validates the configured provider and returns its name.
 *
 * Called at startup (so a missing `RESEND_API_KEY` is a boot error, not a
 * surprise during someone's password reset) and again before every send (so a
 * process whose environment changed cannot silently switch transports).
 */
const assertMailConfig = () => {
    const name = mailProvider();
    const provider = providers[name];

    if (!provider) {
        throw new Error(`MAIL_PROVIDER "${name}" is not supported; use "console" or "resend".`);
    }
    if (name === "console" && process.env.NODE_ENV === "production") {
        throw new Error('MAIL_PROVIDER "console" cannot be used in production.');
    }
    if (typeof provider.assertConfig === "function") provider.assertConfig();

    return name;
};

const sendMail = async ({ to, subject, text }) => {
    const name = assertMailConfig();
    const result = await providers[name].send({ to, subject, text });

    return { provider: name, to, subject, ...result };
};

export { sendMail, assertMailConfig };

// The development mailbox keeps living behind this module so existing callers
// (and tests) do not have to know which file the console provider moved to.
export { getOutbox, clearOutbox } from "./mail/console.provider.js";
