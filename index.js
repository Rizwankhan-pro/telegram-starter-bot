const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN || "PUT_YOUR_BOT_TOKEN_HERE";
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "123456789")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
);

if (!TOKEN || TOKEN === "PUT_YOUR_BOT_TOKEN_HERE") {
  console.error("Set BOT_TOKEN environment variable before running.");
  process.exit(1);
}

const DB_PATH = path.join(__dirname, "bot_config.json");
const DEFAULT_CFG = {
  channels: [],
  community: null,
  welcome: "🔥 Welcome!\nJoin all channels to unlock ❤️",
  content: "✅ Membership verified! Here is your content.",
  key: "Key is not configured yet.",
  howto: "How to get the key: contact the admin.",
  video_file_id: null,
  voice_file_id: null,
};

function loadConfig() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      return { ...DEFAULT_CFG, ...parsed };
    } catch (err) {
      console.error("Could not read config; using defaults:", err.message);
    }
  }
  return { ...DEFAULT_CFG };
}

let cfg = loadConfig();

function saveConfig() {
  fs.writeFileSync(DB_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function isAdmin(uid) {
  return ADMIN_IDS.has(uid);
}

function channelList() {
  const items = Array.isArray(cfg.channels) ? [...cfg.channels] : [];
  if (cfg.community && !items.some((x) => x.chat_id === cfg.community.chat_id)) {
    items.push(cfg.community);
  }
  return items;
}

function joinKeyboard() {
  const rows = channelList().map((ch, idx) => [
    { text: ch.title || `Channel ${idx + 1}`, url: ch.url },
  ]);
  rows.push([{ text: "✅ Check Joined", callback_data: "check_joined" }]);
  return { inline_keyboard: rows };
}

function parseChannelSpec(raw, defaultTitle) {
  const parts = raw.split("|").map((p) => p.trim());
  if (parts.length === 2 && parts[0].startsWith("@")) {
    const [username, title] = parts;
    return {
      locator: username,
      url: `https://t.me/${username.slice(1)}`,
      title: title || defaultTitle,
      username,
    };
  }
  if (parts.length === 3 && /^-?\d+$/.test(parts[0])) {
    const [chatIdStr, inviteUrl, title] = parts;
    if (!inviteUrl.startsWith("https://t.me/") && !inviteUrl.startsWith("http://t.me/")) {
      throw new Error("Invite link must be a Telegram t.me link.");
    }
    return {
      locator: Number(chatIdStr),
      url: inviteUrl,
      title: title || defaultTitle,
      username: null,
    };
  }
  throw new Error("Use @username | title OR -100CHAT_ID | https://t.me/+invite | title");
}

const bot = new TelegramBot(TOKEN, { polling: true });

async function joinedAll(uid) {
  for (const ch of channelList()) {
    try {
      const member = await bot.getChatMember(ch.chat_id, uid);
      if (!["member", "administrator", "creator"].includes(member.status)) {
        return [false, ch];
      }
    } catch (err) {
      console.error(`Membership check failed for ${ch.title || ch.chat_id}:`, err.message);
      return [false, ch];
    }
  }
  return [true, null];
}

async function sendUnlocked(chatId) {
  await bot.sendMessage(chatId, cfg.content);
  if (cfg.video_file_id) {
    await bot.sendVideo(chatId, cfg.video_file_id);
  }
  if (cfg.voice_file_id) {
    await bot.sendVoice(chatId, cfg.voice_file_id, { caption: "🎙️ Voice Message" });
  }
  await bot.sendMessage(chatId, "Choose an option:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔑 Get Key", callback_data: "get_key" },
          { text: "📖 How To Get Key", callback_data: "howto" },
        ],
      ],
    },
  });
}

bot.onText(/^\/start(?:@\w+)?(?:\s.*)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cfg.video_file_id) {
    await bot.sendVideo(chatId, cfg.video_file_id, { caption: cfg.welcome });
  } else {
    await bot.sendMessage(chatId, cfg.welcome);
  }

  if (channelList().length === 0) {
    await bot.sendMessage(chatId, "Admin has not configured any required channels yet.");
    return;
  }

  const [ok] = await joinedAll(uid);
  if (ok) {
    await sendUnlocked(chatId);
  } else {
    await bot.sendMessage(chatId, "🚫 Join all channels to unlock ❤️", {
      reply_markup: joinKeyboard(),
    });
  }
});

bot.onText(/^\/admin(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const helpText = [
    "🛠 ADMIN COMMANDS",
    "/addchannel @username | Channel title",
    "Private channel: /addchannel -100CHAT_ID | https://t.me/+INVITE | Title",
    "/removechannel @username or -100CHAT_ID",
    "/setcommunity @username | Community title",
    "Private community: /setcommunity -100CHAT_ID | https://t.me/+INVITE | Title",
    "/clearcommunity",
    "/setcontent Your unlocked message",
    "/setkey Your key/message",
    "/sethowto Instructions",
    "/setwelcome Welcome text",
    "Reply to a video with /setvideo; reply to a voice/audio with /setvoice.",
    "/channels — list configured channels",
    "Add the bot as admin in each channel. Channels are not capped by the code.",
  ].join("\n");
  await bot.sendMessage(msg.chat.id, helpText);
});

bot.onText(/^\/addchannel(?:@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const raw = (match[1] || "").trim();
  try {
    const spec = parseChannelSpec(raw, "Channel");
    const chat = await bot.getChat(spec.locator);
    const entry = {
      chat_id: chat.id,
      username: spec.username,
      title: spec.title || chat.title || "Channel",
      url: spec.url,
    };
    cfg.channels = cfg.channels.filter((x) => x.chat_id !== chat.id);
    cfg.channels.push(entry);
    saveConfig();
    await bot.sendMessage(
      msg.chat.id,
      `Added: ${entry.title}\nMake sure the bot is admin in this channel and can check members.`
    );
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      `Could not add channel: ${err.message}\nFor private channels, use the channel's numeric -100... chat ID and its invite link.`
    );
  }
});

bot.onText(/^\/setcommunity(?:@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const raw = (match[1] || "").trim();
  try {
    const spec = parseChannelSpec(raw, "Community");
    const chat = await bot.getChat(spec.locator);
    cfg.community = {
      chat_id: chat.id,
      username: spec.username,
      title: spec.title || chat.title || "Community",
      url: spec.url,
    };
    saveConfig();
    await bot.sendMessage(msg.chat.id, "Community set as a required join destination.");
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      `Could not set community: ${err.message}\nFor private communities, use the numeric -100... chat ID and invite link.`
    );
  }
});

bot.onText(/^\/removechannel(?:@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const target = (match[1] || "").trim().replace(/^@/, "").toLowerCase();
  const before = cfg.channels.length;
  cfg.channels = cfg.channels.filter(
    (x) =>
      String(x.chat_id) !== target &&
      String(x.username || "").replace(/^@/, "").toLowerCase() !== target
  );
  saveConfig();
  await bot.sendMessage(
    msg.chat.id,
    cfg.channels.length < before ? "Channel removed." : "Channel not found."
  );
});

bot.onText(/^\/clearcommunity(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  cfg.community = null;
  saveConfig();
  await bot.sendMessage(msg.chat.id, "Community requirement cleared.");
});

bot.onText(/^\/channels(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const lines = cfg.channels.map(
    (x, i) => `${i + 1}. ${x.title} — ${x.username || x.chat_id}`
  );
  if (cfg.community) {
    lines.push(
      `Community: ${cfg.community.title || "Community"} — ${
        cfg.community.username || cfg.community.chat_id
      }`
    );
  }
  await bot.sendMessage(msg.chat.id, lines.length ? lines.join("\n") : "No channels configured.");
});

function registerTextSetter(cmdName, cfgKey, label) {
  const regex = new RegExp(`^\\/${cmdName}(?:@\\w+)?(?:\\s+([\\s\\S]*))?$`);
  bot.onText(regex, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const value = (match[1] || "").trim();
    if (!value) {
      await bot.sendMessage(msg.chat.id, `Usage: /${cmdName} your text`);
      return;
    }
    cfg[cfgKey] = value;
    saveConfig();
    await bot.sendMessage(msg.chat.id, `${label} updated.`);
  });
}

registerTextSetter("setwelcome", "welcome", "setwelcome");
registerTextSetter("setcontent", "content", "setcontent");
registerTextSetter("setkey", "key", "setkey");
registerTextSetter("sethowto", "howto", "sethowto");

bot.onText(/^\/(setvideo|setvoice)(?:@\w+)?$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const cmd = match[1];
  const reply = msg.reply_to_message;
  if (!reply) {
    await bot.sendMessage(
      msg.chat.id,
      "Reply to the video or voice/audio message with /setvideo or /setvoice."
    );
    return;
  }
  if (cmd === "setvideo" && reply.video) {
    cfg.video_file_id = reply.video.file_id;
  } else if (cmd === "setvoice" && (reply.voice || reply.audio)) {
    cfg.voice_file_id = (reply.voice || reply.audio).file_id;
  } else {
    await bot.sendMessage(msg.chat.id, "Reply with the matching video or voice/audio media.");
    return;
  }
  saveConfig();
  await bot.sendMessage(msg.chat.id, "Media saved.");
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const uid = q.from.id;
  try {
    await bot.answerCallbackQuery(q.id);
    if (!chatId) return;

    if (q.data === "check_joined") {
      const [ok, missing] = await joinedAll(uid);
      if (ok) {
        await bot.sendMessage(chatId, "✅ Membership verified!");
        await sendUnlocked(chatId);
      } else {
        await bot.sendMessage(
          chatId,
          `⚠️ Could not verify membership: ${missing?.title || "channel"}. Join it, then try again.`,
          { reply_markup: joinKeyboard() }
        );
      }
    } else if (q.data === "get_key") {
      await bot.sendMessage(chatId, cfg.key);
    } else if (q.data === "howto") {
      await bot.sendMessage(chatId, cfg.howto);
    }
  } catch (err) {
    console.error("Callback error:", err.message);
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("Bot started");
