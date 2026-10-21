import { InputRouter } from "./inputRouter";

export interface TelegramMediaMessage {
  message_id?: number;
  from?: { id: number; first_name?: string };
  chat?: { id: number };
  caption?: string;
  voice?: {
    file_id: string;
    file_unique_id?: string;
    duration?: number;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  _testPayload?: Uint8Array | string;
}

export async function handleTelegramMediaIngress(
  message: TelegramMediaMessage,
  context: { db: D1Database; updateId: number; senderId?: number; chatId?: number; env: any },
  now: Date = new Date()
): Promise<{
  command: string;
  success: boolean;
  response: string;
  replyMarkup?: any;
  proposalId?: string;
  interpretation?: any;
}> {
  const { db, env } = context;

  // Determine media type
  if (message.voice) {
    let payload: Uint8Array;
    if (message._testPayload) {
      payload = typeof message._testPayload === 'string'
        ? new TextEncoder().encode(message._testPayload)
        : message._testPayload;
    } else {
      payload = new TextEncoder().encode(`voice_file_${message.voice.file_id}`);
    }

    const res = await InputRouter.routeInput(
      db,
      {
        source: 'telegram',
        rawType: 'audio',
        payload,
        filename: 'voice_note.ogg',
        mimeType: message.voice.mime_type || 'audio/ogg',
        metadata: {
          telegram_file_id: message.voice.file_id,
          duration: message.voice.duration,
        },
      },
      env,
      now
    );

    const title = res.interpretation.candidateTitle;
    const conf = Math.round((res.interpretation.advisoryConfidence || 1.0) * 100);
    const replyMarkup = res.proposalId
      ? {
          inline_keyboard: [
            [
              { text: "✅ Confirm", callback_data: `p_conf:${res.proposalId.slice(0, 13)}` },
              { text: "❌ Reject", callback_data: `p_rej:${res.proposalId.slice(0, 13)}` },
            ],
          ],
        }
      : undefined;

    return {
      command: "voice_ingress",
      success: true,
      proposalId: res.proposalId,
      interpretation: res.interpretation,
      response: `🎙️ *Voice Note Received*\n\nTranscription: "${res.extraction?.text || ''}"\n\n📋 *Proposal*: ${title}\nConfidence: ${conf}%\nStatus: Pending review in Inbox (/inbox)`,
      replyMarkup,
    };
  }

  if (message.photo && message.photo.length > 0) {
    const largestPhoto = message.photo[message.photo.length - 1];
    let payload: Uint8Array;
    if (message._testPayload) {
      payload = typeof message._testPayload === 'string'
        ? new TextEncoder().encode(message._testPayload)
        : message._testPayload;
    } else {
      payload = new TextEncoder().encode(`photo_file_${largestPhoto.file_id}`);
    }

    const res = await InputRouter.routeInput(
      db,
      {
        source: 'telegram',
        rawType: 'image',
        payload,
        filename: 'telegram_photo.png',
        mimeType: 'image/png',
        metadata: {
          telegram_file_id: largestPhoto.file_id,
          caption: message.caption,
        },
      },
      env,
      now
    );

    const title = res.interpretation.candidateTitle;
    const conf = Math.round((res.interpretation.advisoryConfidence || 1.0) * 100);
    const replyMarkup = res.proposalId
      ? {
          inline_keyboard: [
            [
              { text: "✅ Confirm", callback_data: `p_conf:${res.proposalId.slice(0, 13)}` },
              { text: "❌ Reject", callback_data: `p_rej:${res.proposalId.slice(0, 13)}` },
            ],
          ],
        }
      : undefined;

    return {
      command: "photo_ingress",
      success: true,
      proposalId: res.proposalId,
      interpretation: res.interpretation,
      response: `📸 *Photo Received*\n\nOCR: "${res.extraction?.text || ''}"\n\n📋 *Proposal*: ${title}\nConfidence: ${conf}%\nStatus: Pending review in Inbox (/inbox)`,
      replyMarkup,
    };
  }

  if (message.document) {
    const filename = message.document.file_name || 'telegram_doc.txt';
    const mimeType = message.document.mime_type || 'text/plain';
    let payload: Uint8Array;
    if (message._testPayload) {
      payload = typeof message._testPayload === 'string'
        ? new TextEncoder().encode(message._testPayload)
        : message._testPayload;
    } else {
      payload = new TextEncoder().encode(`document_file_${message.document.file_id}`);
    }

    const res = await InputRouter.routeInput(
      db,
      {
        source: 'telegram',
        rawType: 'document',
        payload,
        filename,
        mimeType,
        metadata: {
          telegram_file_id: message.document.file_id,
          caption: message.caption,
        },
      },
      env,
      now
    );

    const title = res.interpretation.candidateTitle;
    const conf = Math.round((res.interpretation.advisoryConfidence || 1.0) * 100);
    const replyMarkup = res.proposalId
      ? {
          inline_keyboard: [
            [
              { text: "✅ Confirm", callback_data: `p_conf:${res.proposalId.slice(0, 13)}` },
              { text: "❌ Reject", callback_data: `p_rej:${res.proposalId.slice(0, 13)}` },
            ],
          ],
        }
      : undefined;

    return {
      command: "document_ingress",
      success: true,
      proposalId: res.proposalId,
      interpretation: res.interpretation,
      response: `📄 *Document Received: ${filename}*\n\n📋 *Proposal*: ${title}\nConfidence: ${conf}%\nStatus: Pending review in Inbox (/inbox)`,
      replyMarkup,
    };
  }

  return {
    command: "unknown_media",
    success: false,
    response: "Unsupported media attachment type.",
  };
}
