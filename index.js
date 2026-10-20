import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} from "ourin-baileys";

import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "path";
import fs from "fs";
import readline from "readline";
import { fileURLToPath } from "url";

global.prefix = ".";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_PATH = path.join(
  __dirname,
  "session"
);

const HANDLER_PATH = path.join(
  __dirname,
  "handler.js"
);

const CUSTOM_NAME = "@dpwoffc";

let handleMessage;
let loadPlugins;
let handlerVersion = 0;

async function loadHandler() {
  try {
    const handler = await import(
      `./handler.js?update=${Date.now()}`
    );

    if (
      typeof handler.handleMessage !== "function"
    ) {
      throw new Error(
        "handleMessage tidak ditemukan di handler.js"
      );
    }

    handleMessage =
      handler.handleMessage;

    loadPlugins =
      handler.loadPlugins;

    handlerVersion++;

    console.log(
      `✅ handler.js loaded (v${handlerVersion})`
    );
  } catch (err) {
    console.error(
      "❌ Gagal load handler.js:",
      err?.message || err
    );

    throw err;
  }
}

const oldConsoleLog = console.log;
const oldConsoleError = console.error;
const oldConsoleWarn = console.warn;
const oldConsoleInfo = console.info;

const ignoredLogs = [
  "Closing session",
  "Closing open session",
  "Decrypted message with closed session",
  "Failed to decrypt message with any known session",
  "Session error",
  "Bad MAC",
  "Failed to decrypt message",
  "Closing stale open session",
  "Closing stale session",
  "Failed to decrypt",
  "pre-key bundle",
  "prekey bundle",
  "open session",
  "closed session"
];

function shouldIgnore(args) {
  try {
    const text = args
      .map((value) => {
        if (
          typeof value === "object" &&
          value !== null
        ) {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }

        return String(value);
      })
      .join(" ");

    return ignoredLogs.some(
      (keyword) =>
        text
          .toLowerCase()
          .includes(
            keyword.toLowerCase()
          )
    );
  } catch {
    return false;
  }
}

console.log = (...args) => {
  if (!shouldIgnore(args)) {
    oldConsoleLog(...args);
  }
};

console.error = (...args) => {
  if (!shouldIgnore(args)) {
    oldConsoleError(...args);
  }
};

console.warn = (...args) => {
  if (!shouldIgnore(args)) {
    oldConsoleWarn(...args);
  }
};

console.info = (...args) => {
  if (!shouldIgnore(args)) {
    oldConsoleInfo(...args);
  }
};

let reconnecting = false;
let hasConnected = false;
let pairingRequested = false;
let phoneNumber = "";
let botSocket = null;
let starting = false;
let handlerRestarting = false;
let manualHandlerRestart = false;
const statusJidList = new Set();
const statusContactSyncStats = {
  upsertEvents: 0,
  upsertEntries: 0,
  historyEvents: 0,
  historyEntries: 0
};
const recentMessageCache = new Map();

function rememberStatusRecipient(value) {
  const rawJid = typeof value === "string" ? value : value?.phoneNumber || value?.id || value?.jid;
  if (typeof rawJid !== "string") return;
  const candidate = /^\d{6,}$/.test(rawJid) ? `${rawJid}@s.whatsapp.net` : rawJid;
  const jid = candidate.replace(/:\d+(?=@(?:s\.whatsapp\.net|lid)$)/, "");
  if (/^\d+@(?:s\.whatsapp\.net|lid)$/.test(jid)) statusJidList.add(jid);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (question) =>
  new Promise((resolve) => {
    rl.question(
      question,
      resolve
    );
  });

async function getPhoneNumber() {
  while (!phoneNumber) {
    let input = await ask(
      "📲 Masukkan nomor WhatsApp (contoh 628xxx): "
    );

    input = String(input)
      .trim()
      .replace(/\D/g, "");

    if (!input) {
      console.log(
        "❌ Nomor tidak boleh kosong."
      );
      continue;
    }

    if (!input.startsWith("62")) {
      console.log(
        "❌ Gunakan format internasional (contoh: 628123456789)."
      );
      continue;
    }

    phoneNumber = input;
  }

  return phoneNumber;
}

async function requestPairingCode(sock, state, attempt = 1) {
  if (botSocket !== sock || state.creds.registered) {
    return;
  }

  try {
    const customCode = "SECURITY";
    const code = await sock.requestPairingCode(phoneNumber, customCode);
    const formattedCode = code.match(/.{1,4}/g)?.join("-") || code;

    console.log("");
    console.log("╔══════════════════════════════════════╗");
    console.log(`║    PAIRING CODE : [ ${CUSTOM_NAME} ]   ║`);
    console.log("╠══════════════════════════════════════╣");
    console.log(`║ Number : ${phoneNumber}`);
    console.log(`║ Code   : ${formattedCode}`);
    console.log("╠══════════════════════════════════════╣");
    console.log("║ WhatsApp > Perangkat tertaut         ║");
    console.log("║ > Tautkan dengan nomor telepon       ║");
    console.log("╚══════════════════════════════════════╝");
    console.log("");
  } catch (err) {
    console.error("❌ Pairing failed:", err?.message || err);

    if (attempt < 3) {
      console.log(`🔄 Mencoba meminta pairing code lagi (${attempt + 1}/3)...`);
      setTimeout(() => {
        requestPairingCode(sock, state, attempt + 1);
      }, 5000);
    } else {
      pairingRequested = false;
      console.error("❌ Pairing code gagal dibuat setelah 3 percobaan.");
    }
  }
}
async function startBot() {
  if (botSocket) {
    console.log(
      "⚠️ Bot already running"
    );

    return botSocket;
  }

  if (starting) {
    console.log(
      "⏳ Bot starting..."
    );

    return;
  }

  starting = true;

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      SESSION_PATH
    );

    const {
      version
    } = await fetchLatestBaileysVersion();

    if (!state.creds.registered) {
      await getPhoneNumber();
    }

    try {
      if (
        typeof loadPlugins ===
        "function"
      ) {
        await loadPlugins();

        console.log(
          "✅ Plugins berhasil dimuat"
        );
      }
    } catch (err) {
      console.error(
        "❌ Gagal load plugins:",
        err?.message || err
      );
    }

    const sock =
      makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS("Chrome"),
        // Keep upload failures visible; silent logging hides the host-level reason.
        printQRInTerminal: false, logger: pino({level: "silent"}),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250,
        markOnlineOnConnect: true
      });

    botSocket = sock;
    sock.statusJidList = statusJidList;
    sock.statusContactSyncStats = statusContactSyncStats;
    sock.recentMessageCache = recentMessageCache;
    starting = false;

    sock.ev.on("contacts.upsert", (contacts = []) => {
      statusContactSyncStats.upsertEvents++;
      statusContactSyncStats.upsertEntries += contacts.length;
      for (const contact of contacts) rememberStatusRecipient(contact);
    });

    sock.ev.on("messaging-history.set", ({ contacts = [] } = {}) => {
      statusContactSyncStats.historyEvents++;
      statusContactSyncStats.historyEntries += contacts.length;
      for (const contact of contacts) rememberStatusRecipient(contact);
    });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "connection.update",
      async ({
        connection,
        lastDisconnect
      }) => {
        try {
          if (
            connection ===
              "connecting" &&
            !state.creds.registered &&
            !pairingRequested
          ) {
            pairingRequested =
              true;

            setTimeout(() => {
              requestPairingCode(sock, state);
            }, 3000);
          }

          if (
            connection === "open"
          ) {
            rememberStatusRecipient(sock.user?.id);
            hasConnected = true;
            reconnecting = false;
            pairingRequested = false;
            
            const botNum =
              sock.user?.id?.split(
                ":"
              )[0] ||
              phoneNumber ||
              "TERHUBUNG";

            console.log("");
            console.log("╔══════════════════════════════════════╗");
            console.log(`║    BOT [ ${CUSTOM_NAME} ] ONLINE      ║`);
            console.log("╠══════════════════════════════════════╣");
            console.log(`║ Number : ${botNum}`);
            console.log("║ Status : CONNECTED                    ║");
            console.log("╚══════════════════════════════════════╝");
            console.log("");
          }

          if (
            connection === "close"
          ) {
            const reason =
              new Boom(
                lastDisconnect?.error
              )
                ?.output
                ?.statusCode;

            console.log(
              "Connection closed:",
              reason
            );

            if (
              manualHandlerRestart
            ) {
              console.log(
                "🔄 Socket ditutup untuk update handler.js"
              );

              botSocket =
                null;

              return;
            }

            botSocket = null;

            if (
              reason ===
                DisconnectReason.loggedOut ||
              reason === 401
            ) {
              console.log(
                "❌ Session invalid / logged out."
              );

              console.log(
                "🗑️ Menghapus session..."
              );

              try {
                if (
                  fs.existsSync(
                    SESSION_PATH
                  )
                ) {
                  fs.rmSync(
                    SESSION_PATH,
                    {
                      recursive:
                        true,
                      force:
                        true
                    }
                  );
                }
              } catch (err) {
                console.error(
                  "❌ Gagal hapus session:",
                  err?.message ||
                    err
                );
              }

              pairingRequested = false;
              hasConnected = false;
              return;
            }

            if (
              reason === 515
            ) {
              console.log(
                "🔄 Restart socket after pairing..."
              );

              pairingRequested = false;

              setTimeout(
                () => {
                  startBot();
                },
                2000
              );

              return;
            }

            if (
              !hasConnected &&
              !state.creds.registered
            ) {
              console.log(
                "⌛ Menunggu pairing diselesaikan..."
              );

              pairingRequested =
                false;

              return;
            }

            if (
              !reconnecting
            ) {
              reconnecting =
                true;

              console.log(
                "🔄 Reconnecting dalam 3 detik..."
              );

              setTimeout(
                () => {
                  reconnecting =
                    false;

                  startBot();
                },
                3000
              );
            }
          }

        } catch (err) {
          console.error(
            "❌ CONNECTION EVENT ERROR:",
            err
          );
        }
      }
    );

    sock.ev.on(
      "messages.upsert",
      async ({
        messages,
        type
      }) => {
        try {

          for (const cachedMessage of messages || []) {
            const cachedId = cachedMessage?.key?.id;
            if (!cachedId || !cachedMessage?.message) continue;
            recentMessageCache.set(cachedId, cachedMessage);
            if (recentMessageCache.size > 500) {
              recentMessageCache.delete(recentMessageCache.keys().next().value);
            }
          }

          if (
            type !== "notify"
          ) {
            return;
          }

          const m =
            messages?.[0];

          if (
            !m?.message
          ) {
            return;
          }

          if (
            m.key?.id?.startsWith(
              "BAE5"
            ) &&
            !m.key?.fromMe
          ) {
            return;
          }

          if (
            m.messageTimestamp
          ) {
            const now =
              Math.floor(
                Date.now() /
                  1000
              );

            if (
              now -
                Number(
                  m.messageTimestamp
                ) >
              10
            ) {
              return;
            }
          }

          let detectedPhoneJid =
            null;

          if (
            m.key?.remoteJidAlt?.endsWith(
              "@s.whatsapp.net"
            )
          ) {
            detectedPhoneJid =
              m.key.remoteJidAlt;
          }

          if (
            !detectedPhoneJid &&
            m.key?.participantAlt?.endsWith(
              "@s.whatsapp.net"
            )
          ) {
            detectedPhoneJid =
              m.key.participantAlt;
          }

          if (
            !detectedPhoneJid &&
            m.key?.senderPn
          ) {
            detectedPhoneJid =
              `${m.key.senderPn}@s.whatsapp.net`;
          }

          if (
            !detectedPhoneJid &&
            m.senderPn
          ) {
            detectedPhoneJid =
              `${m.senderPn}@s.whatsapp.net`;
          }

          if (
            !detectedPhoneJid
          ) {
            try {
              const rawString =
                JSON.stringify(m);

              const match =
                rawString.match(
                  /(\d+)@s\.whatsapp\.net/
                );

              if (match) {
                detectedPhoneJid =
                  match[0];
              }
            } catch {}
          }

          if (
            detectedPhoneJid
          ) {
            if (
              m.key?.remoteJid?.endsWith(
                "@lid"
              )
            ) {
              m.key.remoteJid =
                detectedPhoneJid;
            }

            if (
              m.key?.participant?.endsWith(
                "@lid"
              )
            ) {
              m.key.participant =
                detectedPhoneJid;
            }

            if (
              m.sender?.endsWith(
                "@lid"
              )
            ) {
              m.sender =
                detectedPhoneJid;
            }

            if (
              m.chat?.endsWith(
                "@lid"
              )
            ) {
              m.chat =
                detectedPhoneJid;
            }

            if (
              m.from?.endsWith(
                "@lid"
              )
            ) {
              m.from =
                detectedPhoneJid;
            }
          }

          const jid =
            m.key?.remoteJid ||
            "";

          if (
            jid ===
            "status@broadcast"
          ) {
            return;
          }

          const isNewsletter =
            jid.endsWith(
              "@newsletter"
            );

          const msg =
            m.message
              ?.conversation ||
            m.message
              ?.extendedTextMessage
              ?.text ||
            m.message
              ?.imageMessage
              ?.caption ||
            m.message
              ?.videoMessage
              ?.caption ||
            "";

          if (
            !isNewsletter &&
            m.key?.fromMe &&
            !msg.startsWith(
              global.prefix
            )
          ) {
            return;
          }

          const botNum = sock.user?.id?.split(":"
            )[0] ||
            phoneNumber ||
            "";

          m.body = msg;
          m.isNewsletter = isNewsletter;
          m.botNumber = botNum;
          m.botJid = `${botNum}@s.whatsapp.net`;

          const rawCommand =
            msg.split(/\s+/)[0] ||
            "";

          const command =
            rawCommand
              .replace(
                new RegExp(
                  `^\\${global.prefix}`
                ),
                ""
              )
              .toLowerCase();

          m.rawCommand = rawCommand;
          m.command = command;
          m.prefix = global.prefix;

          const rawSender =
            m.key?.participant ||
            m.key?.remoteJid ||
            "";

          const cleanSenderNumber =
            rawSender
              .split("@")[0]
              .replace(
                /[^0-9]/g,
                ""
              );

          m.senderJid = rawSender;
          m.senderNumber = cleanSenderNumber;

          const sourceType = isNewsletter? "Newsletter": jid.endsWith("@g.us")? "Group": "Private";
          const pushName = m.pushName || "No Name";
          const isCommand = msg
              .trim()
              .startsWith(
                global.prefix
              ) &&
            command.length > 0;

          if ( isCommand
          ) {
            let logText =
              `╔════════════════ [ COMMAND INCOMING ] ════════════════╗\n` +
              `║ Waktu   : ${new Date().toLocaleString()}\n` +
              `║ Sumber  : ${sourceType}\n`;
            if (sourceType === "Group"
            ) {
              logText +=`║ Grup ID : ${jid}\n`;
            }

            logText +=
              `║ Nama    : ${pushName}\n` +
              `║ Sender  : ${cleanSenderNumber} (${rawSender})\n` +
              `║ Bot No  : ${botNum}\n` +
              `║ Command : ${rawCommand}\n` +
              `╚══════════════════════════════════════════════════════╝`;
            console.log(
              logText
            );
          }

          if (
            typeof handleMessage ==="function"
          ) {
            await handleMessage(
              sock,
              m,
              botNum
            );
          }

        } catch (err) {
          console.error(
            "❌ HANDLER ERROR:",
            err
          );
        }
      }
    );

    return sock;

  } catch (err) {
    starting = false;
    botSocket = null;

    console.error(
      "❌ Start bot error:",
      err
    );

    setTimeout(
      () => {
        startBot();
      },
      5000
    );
  }
}

async function restartForHandlerChange() {
  if (
    handlerRestarting
  ) {
    return;
  }

  handlerRestarting = true;
  manualHandlerRestart = true;

  try {
    console.log("");
    console.log("╔══════════════════════════════════════╗"
    );
    console.log("║      🔄 HANDLER.JS BERUBAH           ║"
    );
    console.log("╚══════════════════════════════════════╝"
    );

    await loadHandler();

    if (
      botSocket
    ) {
      console.log(
        "🔌 Menutup socket lama..."
      );

      try {
        botSocket.ws?.close();
      } catch {}

      botSocket =
        null;
    }

    hasConnected =
      false;

    reconnecting =
      false;

    pairingRequested =
      false;

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          1500
        )
    );

    console.log(
      "🚀 Menjalankan socket baru..."
    );

    manualHandlerRestart =
      false;

    await startBot();

    console.log(
      "✅ Handler berhasil diperbarui"
    );

  } catch (err) {
    console.error(
      "❌ Gagal restart handler:",
      err?.message ||
        err
    );

    manualHandlerRestart =
      false;

  } finally {
    handlerRestarting =
      false;
  }
}

let handlerChangeTimer =
  null;

fs.watch(
  HANDLER_PATH,
  {
    persistent:
      true
  },
  (eventType) => {
    if (
      eventType !==
      "change"
    ) {
      return;
    }

    clearTimeout(
      handlerChangeTimer
    );

    handlerChangeTimer =
      setTimeout(
        () => {
          restartForHandlerChange();
        },
        500
      );
  }
);

console.log(
  "👀 Watcher handler.js aktif"
);

await loadHandler();
await startBot();

