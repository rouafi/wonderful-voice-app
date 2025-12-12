import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { createDeepgramClient } from "../services/deepgram.js";
import { BatchingBackpressureService } from "../services/backpressure.js";
import { packetTracker, PacketStage } from "../services/packetTracker.js";
import { randomUUID } from "crypto";

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
    let backpressureService: BatchingBackpressureService<Buffer> | null = null;

    // Handle incoming messages from Twilio
    ws.on("message", async (data: Buffer) => {
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

          // Initialize Deepgram connection on start event
          try {
            deepgramConnection = createDeepgramClient();
            console.log("✅ Deepgram connection initialized");

            // Initialize batching backpressure service
            backpressureService = new BatchingBackpressureService<Buffer>(
              // canSend: check if Deepgram connection is ready
              () => {
                if (!deepgramConnection) return false;
                // Check connection state (1 = OPEN)
                const state = (deepgramConnection as any).getReadyState?.();
                return state === 1 || state === undefined; // OPEN or unknown (assume ready)
              },
              // sendItem: send batched audio buffer to Deepgram
              async (batchedAudio: Buffer) => {
                if (!deepgramConnection) {
                  throw new Error("Deepgram connection not available");
                }
                (deepgramConnection.send as any)(batchedAudio);
              },
              {
                batchSize: 5, // Batch 5 packets together
                batchTimeout: 100, // Send partial batch after 100ms
                maxQueueSize: 500, // Max 500 batches in queue
                processInterval: 50, // Process queue every 50ms
                onQueueFull: () => {
                  console.warn("⚠️ Audio queue is full, dropping packets");
                },
              }
            );
            console.log("✅ Batching backpressure service initialized");
          } catch (error) {
            console.error("❌ Failed to initialize Deepgram:", error);
          }
        } else if (message.event === "media") {
          // Audio data is base64 encoded in message.media.payload
          mediaPacketCount++;

          // Send individual packet - batching handled by backpressure service
          if (backpressureService && message.media?.payload) {
            try {
              const packetId = randomUUID();
              const audioBuffer = Buffer.from(message.media.payload, "base64");

              // Track packet arrival
              packetTracker.track(packetId, PacketStage.ARRIVED_FROM_TWILIO, {
                packetNumber: mediaPacketCount,
                payloadSize: audioBuffer.length,
              });

              // Backpressure service handles batching and queuing automatically
              await backpressureService.add(audioBuffer, packetId);

              // Log queue size periodically
              const queueSize = await backpressureService.getQueueSize();
              if (queueSize > 0 && mediaPacketCount % 100 === 0) {
                console.log(`📊 Audio queue size: ${queueSize}`);
              }
            } catch (error) {
              console.error(
                "❌ Error adding audio to backpressure service:",
                error
              );
            }
          } else {
            if (mediaPacketCount === 1) {
              console.log(
                "⚠️ Backpressure service not available or no payload"
              );
              console.log("   backpressureService:", !!backpressureService);
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

          // Flush backpressure service (batches + queue)
          if (backpressureService) {
            await backpressureService.flush();
            console.log("✅ Flushed backpressure service");
          }
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

    ws.on("close", async () => {
      console.log("🔌 WebSocket connection closed");

      // Flush backpressure service before closing
      if (backpressureService) {
        await backpressureService.flush();
        console.log("✅ Flushed backpressure service on close");
      }

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
