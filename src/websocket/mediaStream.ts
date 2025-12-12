import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { packetTracker, PacketStage } from "../services/packetTracker.js";
import { sessionManager } from "../services/sessionManager.js";
import { vadService } from "../services/vad.js";
import { phoneStore } from "../services/phoneStore.js";
import { agentManager } from "../services/agent.js";
import { textToSpeech, sendAudioToTwilio } from "../services/tts.js";
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

    let callSid: string | null = null;
    let lastLogTime = Date.now();

    // Handle incoming messages from Twilio
    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.event === "connected") {
          console.log("✅ Media stream connected");
          console.log("   Protocol:", message.protocol);
        } else if (message.event === "start") {
          callSid = message.start?.callSid;
          console.log("🎬 Media stream started");
          console.log("   Stream SID:", message.start?.streamSid);
          console.log("   Account SID:", message.start?.accountSid);
          console.log("   Call SID:", callSid);
          console.log("   Tracks:", message.start?.tracks);

          // Create session using SessionManager
          if (callSid) {
            try {
              const session = sessionManager.createSession(callSid, {
                streamSid: message.start?.streamSid,
                accountSid: message.start?.accountSid,
                webSocket: ws, // Store WebSocket for sending audio back
              });

              // Send immediate greeting when call starts (don't wait for patient to speak)
              const greetingText = "Hello! How can I help you today?";
              console.log(`👋 Sending immediate greeting: "${greetingText}"`);

              textToSpeech(greetingText, {
                encoding: "mulaw",
                sampleRate: 8000,
              })
                .then((audioBuffer) => {
                  // Re-fetch session to ensure we have latest WebSocket state
                  if (!callSid) {
                    console.warn(`⚠️ No callSid available for greeting`);
                    return;
                  }
                  const currentSession = sessionManager.getSession(callSid);
                  if (currentSession?.webSocket && currentSession?.streamSid) {
                    if (
                      currentSession.webSocket.readyState === WebSocket.OPEN
                    ) {
                      sendAudioToTwilio(
                        currentSession.webSocket,
                        currentSession.streamSid,
                        audioBuffer
                      );
                      console.log(`✅ Greeting sent successfully`);
                    } else {
                      console.warn(
                        `⚠️ WebSocket not open yet, greeting will be delayed`
                      );
                    }
                  } else {
                    console.warn(
                      `⚠️ Session or WebSocket not available for greeting`
                    );
                  }
                })
                .catch((ttsError: any) => {
                  console.error(`❌ Error sending greeting:`, ttsError.message);
                });

              // Configure VAD for patient booking call with callback
              vadService.configure(
                callSid,
                {
                  mode: "patient",
                  silenceTimeout: 600, // 1s for faster response (optimized from 2s)
                },
                async (callSid) => {
                  // Callback when turn is complete
                  const turnCompleteStartTime = Date.now();
                  console.log(
                    `🎯 Turn complete for call ${callSid.substring(
                      0,
                      8
                    )} - patient finished speaking [T+0ms]`
                  );

                  // Get patient phone number
                  const patientPhone = phoneStore.getPhone(callSid);
                  if (!patientPhone) {
                    console.warn(
                      `⚠️ No phone number found for call ${callSid.substring(
                        0,
                        8
                      )}`
                    );
                    return;
                  }

                  // Get latest final transcript from session
                  const session = sessionManager.getSession(callSid);
                  if (!session) {
                    console.warn(
                      `⚠️ No session found for call ${callSid.substring(0, 8)}`
                    );
                    return;
                  }

                  // Get the most recent final transcript
                  const finalTranscripts = session.transcripts.filter(
                    (t) => t.isFinal
                  );
                  if (finalTranscripts.length === 0) {
                    console.log(
                      `ℹ️ No final transcripts yet for call ${callSid.substring(
                        0,
                        8
                      )}`
                    );
                    return;
                  }

                  // Use the latest final transcript
                  const latestTranscript =
                    finalTranscripts[finalTranscripts.length - 1];
                  if (!latestTranscript) {
                    console.log(
                      `ℹ️ No valid transcript found for call ${callSid.substring(
                        0,
                        8
                      )}`
                    );
                    return;
                  }

                  // Calculate VAD latency: time from last final transcript to turn complete detection
                  // This includes the silence timeout (1s) + delayed check (500ms) + frequent checking
                  const vadLatency =
                    turnCompleteStartTime - latestTranscript.timestamp;

                  console.log(
                    `🤖 Processing transcript with agent: "${latestTranscript.text}"`
                  );
                  console.log(`   VAD latency: ${vadLatency}ms`);

                  if (!agentManager) {
                    console.error(
                      "❌ Agent manager not initialized. Cannot process transcript."
                    );
                    return;
                  }

                  try {
                    let agentResponse;
                    let agentLatency = 0;
                    const agentStartTime = Date.now();

                    // Check if we have early processing result
                    if (
                      session.earlyProcessing &&
                      session.earlyProcessing.result
                    ) {
                      // Use cached result from early processing
                      agentResponse = session.earlyProcessing.result;
                      agentLatency =
                        Date.now() -
                        session.earlyProcessing.processingStartTime;
                      const timeSaved =
                        agentStartTime -
                        session.earlyProcessing.processingStartTime;
                      console.log(
                        `⚡ Using early processing result - saved ~${timeSaved}ms`
                      );
                      console.log(
                        `   Early processing latency: ${agentLatency}ms (from start of early processing)`
                      );
                      // Clear early processing
                      session.earlyProcessing = undefined;
                    } else if (
                      session.earlyProcessing &&
                      session.earlyProcessing.promise
                    ) {
                      // Early processing is still in progress, wait for it
                      console.log(
                        `⏳ Early processing in progress - waiting for result...`
                      );
                      try {
                        agentResponse = await session.earlyProcessing.promise;
                        agentLatency =
                          Date.now() -
                          session.earlyProcessing.processingStartTime;
                        const timeSaved =
                          agentStartTime -
                          session.earlyProcessing.processingStartTime;
                        console.log(
                          `✅ Early processing completed - saved ~${timeSaved}ms`
                        );
                        session.earlyProcessing = undefined;
                      } catch (error) {
                        console.warn(
                          `⚠️ Early processing failed, falling back to normal processing`
                        );
                        // Fall back to normal processing
                        agentResponse = await agentManager.processTranscript(
                          callSid,
                          patientPhone,
                          latestTranscript.text
                        );
                        agentLatency = Date.now() - agentStartTime;
                      }
                    } else {
                      // No early processing - process normally
                      agentResponse = await agentManager.processTranscript(
                        callSid,
                        patientPhone,
                        latestTranscript.text
                      );
                      agentLatency = Date.now() - agentStartTime;
                    }

                    console.log(`🤖 Agent response: ${agentResponse.text}`);
                    console.log(`   LLM latency: ${agentLatency}ms`);
                    if (agentResponse.intent === "book_appointment") {
                      console.log(`✅ Appointment booking intent detected`);
                    }
                    if (
                      agentResponse.toolCalls &&
                      agentResponse.toolCalls.length > 0
                    ) {
                      console.log(
                        `🔧 Tool calls executed:`,
                        agentResponse.toolCalls
                      );
                    }

                    // Re-fetch session to ensure we have latest WebSocket and streamSid
                    // (session might have been updated during tool calls)
                    const currentSession = sessionManager.getSession(callSid);

                    // Convert agent response to speech and send back to caller (fire-and-forget)
                    if (
                      !agentResponse.text ||
                      agentResponse.text.trim() === ""
                    ) {
                      console.warn(
                        `⚠️ Agent response text is empty, skipping TTS`
                      );
                    } else if (!currentSession) {
                      console.warn(
                        `⚠️ Session not found for call ${callSid}, cannot send TTS`
                      );
                    } else if (!currentSession.webSocket) {
                      console.warn(
                        `⚠️ WebSocket not available in session, cannot send TTS`
                      );
                    } else if (!currentSession.streamSid) {
                      console.warn(
                        `⚠️ StreamSid not available in session, cannot send TTS`
                      );
                    } else {
                      const ttsStartTime = Date.now();

                      console.log(
                        `🔊 Preparing to send TTS for response: "${agentResponse.text.substring(
                          0,
                          50
                        )}..."`
                      );
                      console.log(`   VAD latency: ${vadLatency}ms`);
                      console.log(`   LLM latency: ${agentLatency}ms`);
                      console.log(
                        `   WebSocket available: ${!!currentSession.webSocket}`
                      );
                      console.log(`   StreamSid: ${currentSession.streamSid}`);

                      // Fire and forget - don't await, just trigger and continue
                      textToSpeech(agentResponse.text, {
                        encoding: "mulaw",
                        sampleRate: 8000,
                      })
                        .then((audioBuffer) => {
                          const ttsLatency = Date.now() - ttsStartTime;
                          sendAudioToTwilio(
                            currentSession.webSocket!,
                            currentSession.streamSid!,
                            audioBuffer
                          );
                          const totalEndToEnd =
                            Date.now() - turnCompleteStartTime;
                          console.log(
                            `✅ Agent response sent as audio to caller [TTS: ${ttsLatency}ms, Total E2E: ${totalEndToEnd}ms]`
                          );
                        })
                        .catch((ttsError: any) => {
                          console.error(
                            `❌ Error converting/sending TTS:`,
                            ttsError.message
                          );
                        });

                      // Don't wait for TTS - continue immediately
                      console.log(
                        `🔊 TTS conversion started (fire-and-forget)`
                      );
                    }
                  } catch (error: any) {
                    console.error(
                      `❌ Error processing transcript with agent:`,
                      error.message
                    );
                  }
                }
              );
              console.log("✅ VAD configured for patient mode");
            } catch (error) {
              console.error("❌ Failed to create session:", error);
            }
          } else {
            console.warn("⚠️ No callSid in start event");
          }
        } else if (message.event === "media") {
          if (!callSid) {
            console.warn("⚠️ Received media packet but no callSid");
            return;
          }

          const session = sessionManager.getSession(callSid);
          if (!session) {
            console.warn(`⚠️ No session found for call ${callSid}`);
            return;
          }

          sessionManager.incrementPacketCount(callSid);

          // Send individual packet - batching handled by backpressure service
          if (session.backpressureService && message.media?.payload) {
            try {
              const packetId = randomUUID();
              const audioBuffer = Buffer.from(message.media.payload, "base64");

              // Track packet arrival
              packetTracker.track(packetId, PacketStage.ARRIVED_FROM_TWILIO, {
                packetNumber: session.packetCount,
                payloadSize: audioBuffer.length,
                callSid: callSid,
              });

              // Backpressure service handles batching and queuing automatically
              await session.backpressureService.add(audioBuffer, packetId);

              // Log queue size periodically
              const queueSize =
                await session.backpressureService.getQueueSize();
              if (queueSize > 0 && session.packetCount % 100 === 0) {
                console.log(
                  `📊 Audio queue size for call ${callSid}: ${queueSize}`
                );
              }
            } catch (error) {
              console.error(
                `❌ Error adding audio to backpressure service for call ${callSid}:`,
                error
              );
            }
          }

          // Log every 50 packets or every 5 seconds (to avoid spam)
          const now = Date.now();
          if (session.packetCount % 50 === 0 || now - lastLogTime > 5000) {
            const payloadSize = message.media?.payload?.length || 0;
            console.log(
              `🎵 Audio data received for call ${callSid} (packet #${session.packetCount})`
            );
            console.log(`   Payload size: ${payloadSize} bytes`);
            console.log(`   Timestamp: ${message.media?.timestamp || "N/A"}`);
            console.log(`   Track: ${message.media?.track || "N/A"}`);
            lastLogTime = now;
          }
        } else if (message.event === "stop") {
          console.log("🛑 Media stream stopped");
          if (callSid) {
            const session = sessionManager.getSession(callSid);
            if (session) {
              console.log(
                `   Total packets received for call ${callSid}: ${session.packetCount}`
              );
            }
            // End session
            await sessionManager.endSession(callSid);
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
      if (callSid) {
        await sessionManager.endSession(callSid);
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
