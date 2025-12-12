/**
 * Text-to-Speech Service using Deepgram TTS
 * Converts agent text responses to audio for playback
 */

import { config } from "../config/index.js";

export interface TTSOptions {
  model?: string; // Deepgram TTS model name (e.g., "aura-asteria-en", "aura-2-thalia-en")
  encoding?: "linear16" | "mulaw" | "alaw";
  sampleRate?: number;
  stream?: boolean; // Enable streaming (chunked) mode
  onChunk?: (audioBuffer: Buffer) => void; // Callback for each audio chunk
}

/**
 * Convert text to speech audio buffer
 * If stream=true and onChunk is provided, will stream chunks as they're generated
 */
export async function textToSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  // If streaming is requested, use streaming function
  if (options.stream && options.onChunk) {
    // For streaming, we still return a buffer (all chunks combined)
    // But chunks are sent via onChunk callback
    const chunks: Buffer[] = [];
    const onChunkCallback = options.onChunk;
    await streamTextToSpeech(text, {
      ...options,
      onChunk: async (chunk) => {
        chunks.push(chunk);
        await onChunkCallback(chunk);
      },
    });
    // Return combined buffer for compatibility
    return Buffer.concat(chunks);
  }
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
 * Split text into chunks for streaming TTS
 * Splits on sentence boundaries (., !, ?) or commas for natural pauses
 */
function splitTextIntoChunks(
  text: string,
  maxChunkLength: number = 100
): string[] {
  // First try to split on sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= maxChunkLength) {
      chunks.push(sentence.trim());
    } else {
      // If sentence is too long, split on commas
      const parts = sentence.split(/,/g);
      let currentChunk = "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (currentChunk.length + trimmed.length + 1 <= maxChunkLength) {
          currentChunk += (currentChunk ? ", " : "") + trimmed;
        } else {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = trimmed;
        }
      }
      if (currentChunk) chunks.push(currentChunk);
    }
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Stream text to speech - generates and sends audio chunks as they're ready
 */
export async function streamTextToSpeech(
  text: string,
  options: TTSOptions & {
    onChunk: (audioBuffer: Buffer) => Promise<void> | void;
  }
): Promise<void> {
  const {
    model = "aura-asteria-en",
    encoding = "mulaw",
    sampleRate = 8000,
  } = options;

  // Split text into chunks for streaming
  // Smaller chunks (50 chars) = faster first chunk generation
  const chunks = splitTextIntoChunks(text, 50);

  console.log(
    `🔊 Streaming TTS: "${text.substring(0, 50)}${
      text.length > 50 ? "..." : ""
    }" (${chunks.length} chunks)`
  );

  // Process chunks sequentially to maintain order
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.trim().length === 0) {
      continue; // Skip empty chunks
    }

    try {
      // Generate TTS for this chunk
      const audioBuffer = await textToSpeech(chunk, {
        model,
        encoding,
        sampleRate,
        stream: false, // Individual chunks are not streamed
      });

      // Send chunk immediately
      await options.onChunk(audioBuffer);

      if (i === 0) {
        console.log(
          `⚡ First audio chunk sent (${audioBuffer.length} bytes) - streaming started`
        );
      }
    } catch (error: any) {
      console.error(
        `❌ Error generating/sending chunk ${i + 1}/${chunks.length}:`,
        error.message
      );
      // Continue with next chunk even if one fails
    }
  }

  console.log(`✅ Streaming TTS complete (${chunks.length} chunks sent)`);
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
    // Check if WebSocket is still open
    if (ws.readyState !== 1) {
      // 1 = OPEN, 0 = CONNECTING, 2 = CLOSING, 3 = CLOSED
      console.error(
        `❌ WebSocket is not open (state: ${ws.readyState}), cannot send audio`
      );
      throw new Error(`WebSocket is not open (state: ${ws.readyState})`);
    }

    const payload = audioBuffer.toString("base64");

    const message = {
      event: "media",
      streamSid: streamSid,
      media: {
        payload: payload,
      },
    };

    ws.send(JSON.stringify(message));
    console.log(
      `📤 Sent audio to Twilio (${audioBuffer.length} bytes, streamSid: ${streamSid})`
    );
  } catch (error: any) {
    console.error("❌ Error sending audio to Twilio:", error);
    throw error;
  }
}
