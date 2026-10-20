
import settings from "./settings.js";

function normalizeNumber(value) {
    if (typeof value !== "string") return "";

    // Ambil bagian nomor sebelum @, jika berupa JID.
    const number = value.split("@")[0].replace(/[^0-9]/g, "");

    return number;
}

function getSenderNumber(message) {
    // Pesan yang dikirim oleh bot sendiri.
    if (message?.key?.fromMe) {
        const ownNumber = normalizeNumber(
            String(message?.botNumber || message?.botJid || "")
        );

        if (ownNumber) return ownNumber;
    }

    const candidates = [
        message?.senderNumber,
        message?.key?.participantAlt,
        message?.key?.remoteJidAlt,
        message?.key?.senderPn,
        message?.senderPn,
        message?.key?.participant,
        message?.key?.remoteJid
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;

        const number = normalizeNumber(candidate);

        if (number) return number;
    }

    return "";
}

function getAllowedNumbers() {
    const devNumber = normalizeNumber(
        String(settings.devNumber || "")
    );

    const botAccess = Array.isArray(
        settings.botAccess
    ) ? settings.botAccess : [settings.botAccess];

    return new Set(
        [devNumber, ...botAccess.map(normalizeNumber)]
            .filter(Boolean)
    );
}

export async function handleMessage(sock, message) {
    try {
        if (!message || message.isNewsletter) return;
        const jid = message.key?.remoteJid;
        if (!jid) return;
        const senderNumber = getSenderNumber(message);
        if (!senderNumber) return;
        const allowedNumbers = getAllowedNumbers();
        if (!allowedNumbers.has(senderNumber)) return;
        const body = String(message.body || "").trim();
        if (!body) return;
        if (!body.startsWith("/")) return;
        const args = body.slice(1).trim().split(/\s+/);
        const command = String(args.shift() || "").toLowerCase();
        if (!command) return;
        const url = args[0] || "";
        if (message.key?.fromMe) return;

        switch (command) {
            // Contoh:
            //
            // case "menu":
            //     await sock.sendMessage(jid, {
            //         text: "Menu bot"
            //     });
            //     break;
            //
            // case "ping":
            //     await sock.sendMessage(jid, {
            //         text: "Pong!"
            //     });
            //     break;

            default:
                return;
        }
    } catch (error) {
        console.error("[handleMessage]", error);
    }
}
