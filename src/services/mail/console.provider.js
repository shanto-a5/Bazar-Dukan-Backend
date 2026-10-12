/**
 * The development provider.
 *
 * The process *is* the mailbox: the message body (including the reset link) is
 * printed for whoever is developing, and the same message is kept in the
 * outbox so automated tests read it instead of scraping stdout. Printing is
 * delivery here, not logging — which is why the mailer refuses to select this
 * provider in production, where it would otherwise write live reset links into
 * a log collector.
 *
 * Session bearer tokens are never printed anywhere.
 */
const outbox = [];

const send = async ({ to, subject, text }) => {
    outbox.push({ to, subject, text, sentAt: new Date().toISOString() });
    console.log(`[mail:console] to=${to} subject="${subject}"\n${text}`);
    return {};
};

/** The dev mailbox, read by tests instead of scraping stdout. */
const getOutbox = () => outbox.map((entry) => ({ ...entry }));

const clearOutbox = () => {
    outbox.length = 0;
};

export { send, getOutbox, clearOutbox };
