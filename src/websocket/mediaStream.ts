import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { createDeepgramClient } from "../services/deepgram.js";

export function createMediaStreamServer(server: any): WebSocketServer {
  console.log("🔧 Setting up WebSocket server on path: /media-stream");

  const wss = new WebSocketServer({
    server,
    path: "/media-stream",
    // Verify client is optional but can help with debugging
    verifyClient: (info: { req: IncomingMessage; origin: string }) => {
      console.log("🔄 WebSocket upgrade request received");
      console.log("   Path:", info.req.url);
      console.log("   Origin:", info.origin);
      console.log("   Headers:", JSON.stringify(info.req.headers, null, 2));
      return true; // Accept all connections
    },
  });

  // Log when WebSocket server is ready
  wss.on("listening", () => {
    console.log("✅ WebSocket server is listening for connections");
  });

  // Log any errors during WebSocket setup
  wss.on("error", (error) => {
    console.error("❌ WebSocket server error:", error);
  });

  wss.on("connection", (ws: WebSocket, req) => {
    console.log("🔌 WebSocket connection established for media stream");
    console.log("   Remote address:", req.socket.remoteAddress);

    let mediaPacketCount = 0;
    let lastLogTime = Date.now();
    let deepgramConnection: ReturnType<typeof createDeepgramClient> | null =
      null;

    // Initialize Deepgram connection
    try {
      deepgramConnection = createDeepgramClient();
    } catch (error) {
      console.error("❌ Failed to initialize Deepgram:", error);
    }

    // Handle incoming messages from Twilio
    ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.event === "connected") {
          console.log("✅ Media stream connected");
          console.log("   Protocol:", message.protocol);
        } else if (message.event === "start") {
          console.log("🎬 Media stream started");
          console.log("   Stream SID:", message.start?.streamSid);
          console.log("   Account SID:", message.start?.accountSid);
          console.log("   Call SID:", message.start?.callSid);
          console.log("   Tracks:", message.start?.tracks);
        } else if (message.event === "media") {
          // Audio data is base64 encoded in message.media.payload
          mediaPacketCount++;

          // Forward audio to Deepgram
          if (deepgramConnection && message.media?.payload) {
            try {
              const audioBuffer = Buffer.from(message.media.payload, "base64");
              // Send buffer directly - Deepgram SDK accepts Buffer
              (deepgramConnection.send as any)(audioBuffer);
            } catch (error) {
              console.error("❌ Error sending audio to Deepgram:", error);
            }
          } else {
            if (mediaPacketCount === 1) {
              console.log("⚠️ Deepgram connection not available or no payload");
              console.log("   deepgramConnection:", !!deepgramConnection);
              console.log("   payload exists:", !!message.media?.payload);
            }
          }

          // Log every 50 packets or every 5 seconds (to avoid spam)
          const now = Date.now();
          if (mediaPacketCount % 50 === 0 || now - lastLogTime > 5000) {
            const payloadSize = message.media?.payload?.length || 0;
            console.log(`🎵 Audio data received (packet #${mediaPacketCount})`);
            console.log(`   Payload size: ${payloadSize} bytes`);
            console.log(`   Timestamp: ${message.media?.timestamp || "N/A"}`);
            console.log(`   Track: ${message.media?.track || "N/A"}`);
            lastLogTime = now;
          }
        } else if (message.event === "stop") {
          console.log("🛑 Media stream stopped");
          console.log(`   Total packets received: ${mediaPacketCount}`);
        } else {
          console.log(
            "📨 Unknown event:",
            message.event,
            JSON.stringify(message)
          );
        }
      } catch (error) {
        console.error("❌ Error parsing WebSocket message:", error);
        console.error("   Raw data:", data.toString().substring(0, 200));
      }
    });

    ws.on("error", (error) => {
      console.error("❌ WebSocket error:", error);
    });

    ws.on("close", () => {
      console.log("🔌 WebSocket connection closed");
      if (deepgramConnection) {
        deepgramConnection.finish();
      }
    });

    // Send a welcome message (optional)
    ws.send(
      JSON.stringify({
        event: "connected",
        protocol: "Call",
        version: "1.0.0",
      })
    );
  });

  return wss;
}
