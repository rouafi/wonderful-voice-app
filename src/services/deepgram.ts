import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { config } from "../config/index.js";

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
    console.log(
      "🔍 Raw transcript data received:",
      JSON.stringify(data, null, 2)
    );
    const transcript = data.channel?.alternatives?.[0]?.transcript || "";
    const isFinal = data.is_final;

    console.log(
      `🔍 Transcript text: "${transcript}", isFinal: ${isFinal}, lastSendTime: ${lastSendTime}`
    );

    if (transcript) {
      const latency = lastSendTime > 0 ? Date.now() - lastSendTime : 0;
      const timestamp = Date.now();

      // Store transcript
      transcripts.push({ text: transcript, isFinal, latency, timestamp });

      // Keep only last 100 transcripts
      if (transcripts.length > 100) {
        transcripts.shift();
      }

      console.log(
        `📝 [${
          isFinal ? "FINAL" : "INTERIM"
        }] ${transcript} (latency: ${latency}ms)`
      );
    } else {
      console.log("⚠️ Empty transcript received, skipping storage");
    }
  });

  // Track send time for latency calculation
  const originalSend = connection.send.bind(connection);
  (connection as any).send = (audio: any) => {
    lastSendTime = Date.now();
    return originalSend(audio);
  };

  return connection;
}
