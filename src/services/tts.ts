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
 * Strategy: Combine chunks optimally (2+ words) while respecting natural punctuation
 * - Prefer sentence boundaries (., !, ?)
 * - Then comma boundaries
 * - Ensure chunks are at least 2 words but not too large
 */
function splitTextIntoChunks(
  text: string,
  maxChunkLength: number = 120
): string[] {
  // Helper to count words in a string
  const wordCount = (str: string): number => {
    return str
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
  };

  // First split on sentence boundaries (., !, ?) - highest priority
  const sentencePattern = /[^.!?]+[.!?]+/g;
  const sentences = text.match(sentencePattern) || [text];
  const chunks: string[] = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    // If sentence fits and has at least 2 words, use it as-is
    if (trimmed.length <= maxChunkLength && wordCount(trimmed) >= 2) {
      chunks.push(trimmed);
      continue;
    }

    // If sentence is too long, split on commas
    if (trimmed.length > maxChunkLength) {
      const commaParts = trimmed.split(/,/g);
      let currentChunk = "";

      for (let i = 0; i < commaParts.length; i++) {
        const partRaw = commaParts[i];
        if (!partRaw) continue;
        const part = partRaw.trim();
        if (part.length === 0) continue;

        // Try to combine with current chunk
        const potentialChunk = currentChunk ? `${currentChunk}, ${part}` : part;

        // If combined chunk fits and has 2+ words, keep combining
        if (
          potentialChunk.length <= maxChunkLength &&
          wordCount(potentialChunk) >= 2
        ) {
          currentChunk = potentialChunk;
        } else {
          // Current chunk is ready (either too big or can't combine)
          if (currentChunk && wordCount(currentChunk) >= 2) {
            chunks.push(currentChunk);
          }
          // Start new chunk with current part
          currentChunk = part;
        }
      }

      // Add remaining chunk if it has 2+ words
      if (currentChunk && wordCount(currentChunk) >= 2) {
        chunks.push(currentChunk);
      }
    } else {
      // Sentence is short but might have < 2 words - combine with previous if possible
      if (wordCount(trimmed) >= 2) {
        chunks.push(trimmed);
      } else if (chunks.length > 0) {
        // Combine with last chunk if it won't exceed max length
        const lastChunk = chunks[chunks.length - 1];
        const combined = `${lastChunk} ${trimmed}`;
        if (combined.length <= maxChunkLength) {
          chunks[chunks.length - 1] = combined;
        } else {
          // Can't combine, add as new chunk (even if < 2 words)
          chunks.push(trimmed);
        }
      } else {
        // First chunk, add it even if < 2 words
        chunks.push(trimmed);
      }
    }
  }

  // Final pass: merge very small chunks (< 2 words) with adjacent chunks
  const finalChunks: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const words = wordCount(chunk);

    if (words < 2 && finalChunks.length > 0) {
      // Try to merge with previous chunk
      const lastChunk = finalChunks[finalChunks.length - 1];
      if (lastChunk) {
        const combined = `${lastChunk} ${chunk}`;
        if (combined.length <= maxChunkLength) {
          finalChunks[finalChunks.length - 1] = combined;
        } else {
          // Can't merge, add as separate chunk
          finalChunks.push(chunk);
        }
      } else {
        finalChunks.push(chunk);
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Stream text to speech - generates and sends audio chunks as they're ready
 * Only streams if text is long enough to benefit from chunking
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

  // Only stream if text is long (>150 chars) - shorter texts sent as single chunk
  const STREAMING_THRESHOLD = 150;

  if (text.length <= STREAMING_THRESHOLD) {
    // Short text - send as single chunk (no streaming artifacts)
    console.log(
      `🔊 TTS (non-streaming): "${text.substring(0, 50)}${
        text.length > 50 ? "..." : ""
      }" (${text.length} chars - too short to stream)`
    );
    const audioBuffer = await textToSpeech(text, {
      model,
      encoding,
      sampleRate,
      stream: false,
    });
    await options.onChunk(audioBuffer);
    return;
  }

  // Long text - split into chunks (only on sentence boundaries)
  // Use larger chunks (200 chars) to minimize breaks
  const chunks = splitTextIntoChunks(text, 200);

  console.log(
    `🔊 Streaming TTS: "${text.substring(0, 50)}${
      text.length > 50 ? "..." : ""
    }" (${chunks.length} chunks, ${text.length} chars)`
  );

  // Process chunks sequentially to maintain order
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.trim().length === 0) {
      continue; // Skip empty chunks
    }

    try {
      // Generate TTS for this chunk
      const audioBuffer = await textToSpeech(chunk.trim(), {
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

      // Add longer delay between chunks to avoid audio artifacts
      // Only delay if not the last chunk (to avoid unnecessary wait at end)
      if (i < chunks.length - 1) {
        // Longer delay: 150ms to allow audio to play smoothly
        // This prevents the "tip" sound between chunks
        await new Promise((resolve) => setTimeout(resolve, 150));
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
