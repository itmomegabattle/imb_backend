import { env } from "../config/env.js";

export async function sendParticipantBotMessage(chatId: string, payload: Record<string, unknown>) {
  if (!env.TELEGRAM_PARTICIPANT_BOT_TOKEN) throw new Error("Participant bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_PARTICIPANT_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: payload.text ?? payload.message ?? "Новое уведомление Megabattle",
      parse_mode: payload.parseMode ?? "HTML",
      reply_markup: payload.replyMarkup,
    }),
  });
  const body = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !body.ok) throw new Error(body.description ?? `Telegram Bot API: ${response.status}`);
}
