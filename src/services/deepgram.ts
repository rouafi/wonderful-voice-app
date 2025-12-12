import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { config } from "../config/index.js";
import { packetTracker, PacketStage } from "./packetTracker.js";

// Simple in-memory transcript storage
export const transcripts: Array<{
  text: string;
  isFinal: boolean;
  latency: number;
  timestamp: number;
}> = [];

export function createDeepgramClient() {
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
    console.log("🎤 Deepgram connection opened");
    lastSendTime = Date.now();
  });

  connection.on(LiveTranscriptionEvents.Error, (error) => {
    console.error("❌ Deepgram error:", error);
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript || "";
    const isFinal = data.is_final;

    if (transcript) {
      // Calculate latency from last batch send time
      const latency = lastSendTime > 0 ? Date.now() - lastSendTime : 0;
      const timestamp = Date.now();

      // Store transcript
      transcripts.push({ text: transcript, isFinal, latency, timestamp });

      // Keep only last 100 transcripts
      if (transcripts.length > 100) {
        transcripts.shift();
      }

      // Track STT processing and correlate with sent batches
      const processedPacketIds = packetTracker.trackSTTProcessed(
        transcript,
        isFinal,
        timestamp,
        5000 // 5 second correlation window
      );

      console.log(
        `📝 [${
          isFinal ? "FINAL" : "INTERIM"
        }] ${transcript} (latency: ${latency}ms)`
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
