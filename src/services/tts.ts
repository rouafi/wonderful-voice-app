/**
 * Text-to-Speech Service using Deepgram TTS
 * Converts agent text responses to audio for playback
 */

import { config } from "../config/index.js";

export interface TTSOptions {
  model?: string; // Deepgram TTS model name (e.g., "aura-asteria-en", "aura-2-thalia-en")
  encoding?: "linear16" | "mulaw" | "alaw";
  sampleRate?: number;
}

/**
 * Convert text to speech audio buffer
 */
export async function textToSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  const apiKey = config.deepgram.apiKey || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is required for TTS");
  }

  const {
    model = "aura-asteria-en", // Valid Deepgram TTS model - should be available on most plans
    encoding = "mulaw", // Match Twilio format
    sampleRate = 8000, // Match Twilio 8kHz
  } = options;

  try {
    console.log(
      `🔊 Converting text to speech: "${text.substring(0, 50)}${
        text.length > 50 ? "..." : ""
      }"`
    );
    console.log(`   Using model: ${model}`);

    // Use Deepgram REST API directly for TTS (leaner than SDK)
    const response = await fetch(
      `https://api.deepgram.com/v1/speak?model=${model}&encoding=${encoding}&sample_rate=${sampleRate}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      // If model not available, try fallback to basic "aura-asteria-en" model
      if (response.status === 403 && model !== "aura-asteria-en") {
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.err_code === "INSUFFICIENT_PERMISSIONS") {
            console.warn(
              `⚠️ Model ${model} not available, falling back to "aura-asteria-en" model`
            );
            // Retry with basic "aura-asteria-en" model
            return textToSpeech(text, { ...options, model: "aura-asteria-en" });
          }
        } catch (parseError) {
          // Error text is not JSON, continue with normal error
        }
      }

      throw new Error(
        `Deepgram TTS API error: ${response.status} - ${errorText}`
      );
    }

    // Get audio buffer from response
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    console.log(`✅ TTS conversion complete: ${audioBuffer.length} bytes`);
    return audioBuffer;
  } catch (error: any) {
    console.error("❌ TTS conversion error:", error);
    throw new Error(`TTS conversion failed: ${error.message}`);
  }
}

/**
 * Send audio buffer to Twilio Media Stream via WebSocket
 */
export function sendAudioToTwilio(
  ws: any, // WebSocket connection
  streamSid: string,
  audioBuffer: Buffer
): void {
  try {
    const payload = audioBuffer.toString("base64");

    const message = {
      event: "media",
      streamSid: streamSid,
      media: {
        payload: payload,
      },
    };

    ws.send(JSON.stringify(message));
    console.log(`📤 Sent audio to Twilio (${audioBuffer.length} bytes)`);
  } catch (error: any) {
    console.error("❌ Error sending audio to Twilio:", error);
    throw error;
  }
}
