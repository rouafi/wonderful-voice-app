import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { config } from "../config/index.js";
import { packetTracker, PacketStage } from "./packetTracker.js";
import { sessionManager } from "./sessionManager.js";
import { vadService } from "./vad.js";
import { agentManager } from "./agent.js";
import { phoneStore } from "./phoneStore.js";

// Simple in-memory transcript storage
export const transcripts: Array<{
  text: string;
  isFinal: boolean;
  latency: number;
  timestamp: number;
}> = [];

export function createDeepgramClient(callSid?: string) {
  // Check config first (loads from .env via dotenv), then fallback to process.env
  const apiKey = config.deepgram.apiKey || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DEEPGRAM_API_KEY environment variable is required (check .env file or environment variables)"
    );
  }

  const deepgram = createClient(apiKey);
  const connection = deepgram.listen.live({
    model: "nova-2",
    language: "en",
    smart_format: true,
    interim_results: true,
    encoding: "mulaw", // Twilio sends μ-law audio
    sample_rate: 8000, // Twilio uses 8kHz sample rate
    channels: 1, // Mono audio
  });

  let lastSendTime = 0;

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log(
      `🎤 Deepgram connection opened${callSid ? ` for call ${callSid}` : ""}`
    );
    lastSendTime = Date.now();
  });

  connection.on(LiveTranscriptionEvents.Error, (error) => {
    console.error(
      `❌ Deepgram error${callSid ? ` for call ${callSid}` : ""}:`,
      error
    );
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript || "";
    const isFinal = data.is_final;

    if (transcript) {
      // Calculate latency from last batch send time
      const latency = lastSendTime > 0 ? Date.now() - lastSendTime : 0;
      const timestamp = Date.now();

      // Store in global transcripts (for backward compatibility)
      transcripts.push({ text: transcript, isFinal, latency, timestamp });
      if (transcripts.length > 100) {
        transcripts.shift();
      }

      // Store in session if callSid provided
      if (callSid) {
        sessionManager.addTranscript(callSid, {
          text: transcript,
          isFinal,
          latency,
          timestamp,
        });

        // Update VAD from transcript
        vadService.updateFromTranscript(callSid, isFinal);

        // Early processing: Start processing stable interim transcripts
        if (!isFinal && transcript.length > 15) {
          // Only process interim transcripts that are substantial (>15 chars)
          const session = sessionManager.getSession(callSid);
          if (session) {
            const now = Date.now();
            const lastInterim = session.lastInterimTranscript;

            // Debug logging
            if (!lastInterim) {
              console.log(
                `🔍 Early processing check: First interim transcript (${
                  transcript.length
                } chars): "${transcript.substring(0, 30)}..."`
              );
            } else {
              const timeSinceLast = now - lastInterim.timestamp;
              const isSame = lastInterim.text === transcript;
              const isSimilar =
                transcript
                  .toLowerCase()
                  .startsWith(lastInterim.text.toLowerCase()) ||
                lastInterim.text
                  .toLowerCase()
                  .startsWith(transcript.toLowerCase());

              console.log(
                `🔍 Early processing check: timeSinceLast=${timeSinceLast}ms, isSame=${isSame}, isSimilar=${isSimilar}, hasEarlyProcessing=${!!session.earlyProcessing}`
              );
            }

            // Check if transcript is "stable" - multiple conditions:
            // 1. Same transcript for 400ms+ (exact match - user paused)
            // 2. Transcript is growing (new transcript starts with old one) and old one was stable for 300ms+
            // 3. Transcript is substantial (>30 chars) and we've been tracking it for 500ms+ (user speaking for a while)
            const timeSinceLast = lastInterim ? now - lastInterim.timestamp : 0;
            const isSame = lastInterim && lastInterim.text === transcript;
            const isGrowing =
              lastInterim &&
              transcript
                .toLowerCase()
                .startsWith(lastInterim.text.toLowerCase()) &&
              transcript.length >= lastInterim.text.length + 3;

            const shouldStartEarly =
              !session.earlyProcessing &&
              transcript.length > 20 && // Substantial transcript
              lastInterim &&
              ((isSame && timeSinceLast > 400) || // Exact match for 400ms
                (isGrowing && timeSinceLast > 300) || // Growing for 300ms
                (timeSinceLast > 500 && transcript.length > 30)); // Substantial transcript tracked for 500ms

            if (shouldStartEarly) {
              // Transcript is stable - start early processing
              console.log(
                `⚡ Starting early processing for stable interim transcript: "${transcript.substring(
                  0,
                  50
                )}${transcript.length > 50 ? "..." : ""}"`
              );
              startEarlyProcessing(callSid, transcript);
            }

            // Update last interim transcript
            session.lastInterimTranscript = {
              text: transcript,
              timestamp: now,
            };
          }
        }

        // If final transcript comes and we have early processing, check if we can use it
        if (isFinal && callSid) {
          const session = sessionManager.getSession(callSid);
          if (session?.earlyProcessing) {
            // Check if final transcript matches what we processed early
            const earlyText = session.earlyProcessing.transcript
              .toLowerCase()
              .trim();
            const finalText = transcript.toLowerCase().trim();

            if (finalText === earlyText || finalText.startsWith(earlyText)) {
              console.log(
                `✅ Final transcript matches early processing - can use cached result`
              );
              // The result will be used in the VAD callback
            } else {
              console.log(
                `⚠️ Final transcript differs from early processing - will re-process`
              );
              // Clear early processing so we re-process with final transcript
              session.earlyProcessing = undefined;
            }
          }
        }

        // Note: Turn completion is now detected via periodic checking in VAD service
        // The callback configured in mediaStream.ts will handle logging
      }

      // Track STT processing and correlate with sent batches
      const processedPacketIds = packetTracker.trackSTTProcessed(
        transcript,
        isFinal,
        timestamp,
        5000 // 5 second correlation window
      );

      console.log(
        `📝 [${isFinal ? "FINAL" : "INTERIM"}]${
          callSid ? ` [call:${callSid.substring(0, 8)}]` : ""
        } ${transcript} (latency: ${latency}ms)`
      );
    }
  });

  // Track send time per batch for accurate latency calculation
  const originalSend = connection.send.bind(connection);
  (connection as any).send = (audio: any) => {
    // Update send time when batch is actually sent
    lastSendTime = Date.now();
    return originalSend(audio);
  };

  return connection;
}

/**
 * Start early processing of interim transcript
 * This allows us to begin LLM processing while user is still speaking
 */
function startEarlyProcessing(callSid: string, transcript: string): void {
  const session = sessionManager.getSession(callSid);
  if (!session) return;

  if (!agentManager) {
    console.warn(`⚠️ Agent manager not initialized for early processing`);
    return;
  }

  const patientPhone = phoneStore.getPhone(callSid);
  if (!patientPhone) {
    console.warn(`⚠️ No phone number found for early processing`);
    return;
  }

  // Mark that we're starting early processing
  session.earlyProcessing = {
    transcript,
    processingStartTime: Date.now(),
  };

  // Start processing asynchronously (fire and forget)
  const processingPromise = agentManager
    .processTranscript(callSid, patientPhone, transcript)
    .then((result) => {
      // Store result for later use
      if (session.earlyProcessing) {
        session.earlyProcessing.result = result;
        const latency =
          Date.now() - session.earlyProcessing.processingStartTime;
        console.log(
          `✅ Early processing complete in ${latency}ms - result cached`
        );
      }
      return result;
    })
    .catch((error) => {
      console.error(`❌ Early processing error:`, error);
      // Clear early processing on error
      if (session.earlyProcessing) {
        session.earlyProcessing = undefined;
      }
    });

  // Store promise in session
  if (session.earlyProcessing) {
    session.earlyProcessing.promise = processingPromise;
  }
}
