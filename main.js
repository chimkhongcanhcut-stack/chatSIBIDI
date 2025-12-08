// main.js / bot.js
// sibidi v4 (conversational):
// - Trigger: "sibidi ..." hoặc mention @bot + có chữ "sibidi"
// - Rate limit: 1 request / 5s / user
// - Gửi "đợi tí để nghĩ phát..." rồi xóa khi trả lời xong
// - Luôn trả lời tiếng Việt, auto dịch tiếng Anh
// - Ghi nhớ "persona" theo từng chat (VD: "từ giờ bạn sẽ là em tôi")
// - Ghi nhớ luôn lịch sử hội thoại theo từng chat để nói chuyện tự nhiên

require("dotenv").config();
const { Telegraf } = require("telegraf");
const OpenAI = require("openai");

// ================== DEBUG ENV ==================
console.log(
  "DEBUG BOT_TOKEN:",
  process.env.BOT_TOKEN ? "OK (đã set)" : "MISSING"
);
console.log(
  "DEBUG OPENAI_API_KEY:",
  process.env.OPENAI_API_KEY ? "OK (đã set)" : "MISSING"
);

// ================== CONFIG ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN) {
  console.error("❌ Chưa set BOT_TOKEN trong .env");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error("❌ Chưa set OPENAI_API_KEY trong .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Lưu info bot để detect mention
let BOT_USERNAME = null;
let BOT_ID = null;

// Rate limit đơn giản: userId -> timestamp ms
const lastCallByUser = new Map();
const RATE_LIMIT_MS = 5000; // 5 giây

// Persona per chat: chatId -> instruction string
const personaByChat = new Map();

// History per chat: chatId -> [{ role: "user"|"assistant", content: string }]
const historyByChat = new Map();
const MAX_HISTORY_MESSAGES = 20; // giới hạn số message để không quá dài

// ================== HELPER ==================
function extractPrompt(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.text) return null;

  const text = msg.text;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Check xem có mention bot không
  let isMentioned = false;
  if (BOT_USERNAME && msg.entities) {
    const atUsername = "@" + BOT_USERNAME.toLowerCase();
    if (lower.includes(atUsername)) {
      isMentioned = true;
    }
  }

  const startsWithSibidi = lower.startsWith("sibidi");

  // Nếu không bắt đầu bằng sibidi và cũng không mention bot + chứa "sibidi" → bỏ qua
  if (!startsWithSibidi && !isMentioned) return null;
  if (!lower.includes("sibidi")) return null;

  let prompt = trimmed;

  // Nếu bắt đầu bằng "sibidi", cắt nó đi
  if (startsWithSibidi) {
    prompt = trimmed.slice(6).trim(); // "sibidi" dài 6 ký tự
  } else {
    // Nếu chỉ mention: remove @bot + từ "sibidi" trong câu
    if (BOT_USERNAME) {
      const atRegex = new RegExp("@" + BOT_USERNAME, "ig");
      prompt = prompt.replace(atRegex, " ");
    }
    prompt = prompt.replace(/sibidi/gi, " ").trim();
  }

  if (!prompt) {
    prompt = "Giúp tôi trả lời tin nhắn này.";
  }

  return prompt;
}

function isRateLimited(userId) {
  const now = Date.now();
  const last = lastCallByUser.get(userId) || 0;
  if (now - last < RATE_LIMIT_MS) {
    return true;
  }
  lastCallByUser.set(userId, now);
  return false;
}

// Phát hiện câu kiểu "từ giờ" / "from now" để coi như cấu hình persona
function shouldUpdatePersona(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes("từ giờ") || lower.includes("tu gio")) return true;
  if (lower.includes("from now")) return true;
  return false;
}

// Lấy history cho chat
function getHistoryForChat(chatId) {
  if (!chatId) return [];
  return historyByChat.get(chatId) || [];
}

// Lưu history cho chat
function updateHistoryForChat(chatId, userPrompt, assistantReply) {
  if (!chatId) return;
  const history = historyByChat.get(chatId) || [];
  history.push({ role: "user", content: userPrompt });
  history.push({ role: "assistant", content: assistantReply });

  // Giới hạn độ dài history
  if (history.length > MAX_HISTORY_MESSAGES) {
    // cắt bỏ phần đầu
    const sliced = history.slice(history.length - MAX_HISTORY_MESSAGES);
    historyByChat.set(chatId, sliced);
  } else {
    historyByChat.set(chatId, history);
  }
}

// ================== HANDLERS ==================
bot.on("text", async (ctx) => {
  const msg = ctx.message;
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || "unknown";
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;

  let waitingMsg = null;

  try {
    const prompt = extractPrompt(ctx);

    // Không khớp trigger → im luôn
    if (!prompt) {
      console.log(
        `👀 Bỏ qua tin nhắn từ @${username} (chat: ${chatType}): "${msg.text}"`
      );
      return;
    }

    // Rate limit theo user
    if (isRateLimited(userId)) {
      console.log(`🚫 Rate limit user @${username} (${userId})`);
      return;
    }

    console.log(
      `💬 sibidi từ @${username} (${userId}) ở chat ${chatType}: "${prompt}"`
    );

    // Nếu prompt có dạng "từ giờ..." / "from now..." thì lưu lại làm persona cho chat này
    if (chatId && shouldUpdatePersona(prompt)) {
      personaByChat.set(chatId, prompt);
      console.log(`🧠 Cập nhật persona cho chat ${chatId}: ${prompt}`);
    }

    const personaInstruction = chatId ? personaByChat.get(chatId) : null;

    // Gửi message "đợi tí để nghĩ phát..."
    waitingMsg = await ctx.reply("⏳ đợi tí để nghĩ phát...", {
      reply_to_message_id: msg.message_id,
    });

    // Base system prompt: luôn trả lời tiếng Việt, auto dịch nếu user dùng tiếng Anh
    // + Hạn chế câu mời mọc chung chung
    const baseSystem =
      "Bạn là trợ lý AI thân thiện, luôn trả lời HOÀN TOÀN bằng tiếng Việt. " +
      "Nếu người dùng nhập bằng tiếng Anh hoặc có đoạn tiếng Anh, hãy dịch phần đó sang tiếng Việt và giải thích ngắn gọn nếu cần. " +
      "Giữ cách nói gần gũi, tự nhiên như bạn bè nói chuyện với nhau, không quá máy móc, không quá trang trọng. " +
      "KHÔNG được tự động kết thúc câu bằng những câu mời chung chung kiểu như " +
      "'Nếu cần gì cứ hỏi thêm', 'Nếu bạn còn câu hỏi...' trừ khi người dùng nói là đã xong, hết hỏi, hoặc tạm biệt. " +
      "Khi người dùng chỉ nhắn các từ rất ngắn như 'ok', 'oke', 'okay', 'ừ', 'ừm', 'vâng', 'dạ'..., " +
      "hãy trả lời thật ngắn gọn (ví dụ 'ok nha 😄', 'rồi đó', 'oke') và KHÔNG hỏi thêm 'bạn cần gì nữa không'.";

    // Lấy history của chat để gửi lên OpenAI (giúp giữ mạch hội thoại)
    const history = getHistoryForChat(chatId);

    // Build messages cho OpenAI: base system + optional persona + history + user prompt
    const messages = [{ role: "system", content: baseSystem }];

    if (personaInstruction) {
      messages.push({
        role: "system",
        content:
          "Đây là yêu cầu về cách xưng hô / tính cách mà bạn phải luôn tuân theo trong cuộc trò chuyện này: " +
          personaInstruction,
      });
    }

    // thêm history (chỉ bao gồm role user/assistant)
    for (const h of history) {
      messages.push(h);
    }

    // cuối cùng là câu hỏi hiện tại
    messages.push({
      role: "user",
      content: prompt,
    });

    // Gọi OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const replyText = completion.choices?.[0]?.message?.content?.trim();

    // Xoá message "đợi tí để nghĩ phát..." nếu có
    if (waitingMsg) {
      try {
        await ctx.deleteMessage(waitingMsg.message_id);
      } catch (e) {
        console.error("⚠️ Không xoá được message chờ:", e.message);
      }
    }

    if (!replyText) {
      await ctx.reply("⚠️ Mình không nhận được câu trả lời nào từ ChatGPT.", {
        reply_to_message_id: msg.message_id,
      });
      return;
    }

    // Lưu history cuộc trò chuyện
    updateHistoryForChat(chatId, prompt, replyText);

    // Gửi reply
    await ctx.reply(replyText, {
      reply_to_message_id: msg.message_id,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("❌ Lỗi xử lý OpenAI/Telegram:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error("Message:", err.message);
    }

    // cố xoá message chờ nếu vẫn còn
    if (waitingMsg) {
      try {
        await ctx.deleteMessage(waitingMsg.message_id);
      } catch (e) {
        console.error("⚠️ Không xoá được message chờ (trong catch):", e.message);
      }
    }

    try {
      await ctx.reply(
        "⚠️ Có lỗi xảy ra ở phía ChatGPT hoặc mạng, thử lại sau nhé.",
        { reply_to_message_id: msg.message_id }
      );
    } catch (e) {
      console.error("❌ Lỗi khi gửi reply Telegram:", e.message);
    }
  }
});

// Lệnh test nhanh
bot.command("sibidi_test", async (ctx) => {
  await ctx.reply("✅ sibidi bot đang online!", {
    reply_to_message_id: ctx.message.message_id,
  });
});

// ================== START BOT ==================
(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    BOT_ID = me.id;
    console.log("🤖 Bot username:", BOT_USERNAME);
    console.log("🤖 Bot id:", BOT_ID);

    await bot.launch();
    console.log("✅ Bot Telegram đã chạy với trigger 'sibidi' (v4, conversational)!");
  } catch (err) {
    console.error("❌ Lỗi khi khởi động bot:", err.message);
    process.exit(1);
  }
})();

// Graceful stop (VPS / server)
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
