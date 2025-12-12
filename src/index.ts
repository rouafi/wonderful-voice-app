import express from "express";
import dotenv from "dotenv";
import { createServer } from "http";
import { incomingCallRouter } from "./routes/incomingCall.js";
import { startNgrok } from "./utils/ngrok.js";
import { createMediaStreamServer } from "./websocket/mediaStream.js";
import { transcripts } from "./services/deepgram.js";
import { packetTracker } from "./services/packetTracker.js";
import { sessionManager } from "./services/sessionManager.js";
import { vadService } from "./services/vad.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Create HTTP server (needed for WebSocket)
const server = createServer(app);

// Middleware - Log all requests for debugging
app.use((req, res, next) => {
  console.log(`\n📥 ${req.method} ${req.path}`);
  console.log("   Headers:", JSON.stringify(req.headers, null, 2));
  if (Object.keys(req.body || {}).length > 0) {
    console.log("   Body:", JSON.stringify(req.body, null, 2));
  }
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Routes
app.use("/incoming-call", incomingCallRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Test endpoint to verify webhook is accessible
app.get("/test-webhook", (req, res) => {
  res.json({
    message: "Webhook endpoint is accessible",
    webhookUrl: "/incoming-call",
    method: "POST",
  });
});

// View transcripts endpoint
app.get("/transcripts", (req, res) => {
  const finalOnly = req.query.final === "true";
  const filtered = finalOnly
    ? transcripts.filter((t) => t.isFinal)
    : transcripts;

  res.json({
    count: filtered.length,
    transcripts: filtered.slice(-50), // Last 50 transcripts
  });
});

// List all tracked packets
app.get("/packets", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const allIds = packetTracker.getAllPacketIds();
  const recent = packetTracker.getRecentPackets(limit);

  // Add human-readable timestamps on demand
  const packetsWithTimestamps = recent.map((packet) => ({
    ...packet,
    firstEvent: {
      ...packet.firstEvent,
      timestampHuman: packetTracker.formatHumanTimestamp(
        packet.firstEvent.timestamp
      ),
      timestampISO: packetTracker.formatISOTimestamp(
        packet.firstEvent.timestamp
      ),
    },
    lastEvent: {
      ...packet.lastEvent,
      timestampHuman: packetTracker.formatHumanTimestamp(
        packet.lastEvent.timestamp
      ),
      timestampISO: packetTracker.formatISOTimestamp(
        packet.lastEvent.timestamp
      ),
    },
  }));

  res.json({
    totalTracked: allIds.length,
    showing: recent.length,
    packets: packetsWithTimestamps,
  });
});

// View packet tracking data (supports partial ID match)
app.get("/packets/:packetId", (req, res) => {
  const { packetId } = req.params;
  if (!packetId) {
    return res.status(400).json({ error: "packetId is required" });
  }

  // Try exact match first
  let events = packetTracker.getPacketEvents(packetId);

  // If no exact match, try prefix match
  if (events.length === 0) {
    const matchingIds = packetTracker.findPacketIds(packetId);
    if (matchingIds.length === 1 && matchingIds[0]) {
      // Single match, use it
      const matchedId = matchingIds[0];
      const eventsWithTimestamps =
        packetTracker.getPacketEventsWithHumanTimestamps(matchedId);
      const latencyWithTimestamps =
        packetTracker.getPacketLatencyWithHumanTimestamps(matchedId);
      return res.json({
        packetId: matchedId,
        matchedFrom: packetId,
        events: eventsWithTimestamps,
        latency: latencyWithTimestamps,
      });
    } else if (matchingIds.length > 1) {
      // Multiple matches
      return res.json({
        packetId,
        error: "Multiple packets match this ID",
        matchingIds: matchingIds.slice(0, 10), // Return first 10 matches
      });
    }
  }

  // Get events and latency with human-readable timestamps (computed on demand)
  const eventsWithTimestamps =
    packetTracker.getPacketEventsWithHumanTimestamps(packetId);
  const latencyWithTimestamps =
    packetTracker.getPacketLatencyWithHumanTimestamps(packetId);

  return res.json({
    packetId,
    events: eventsWithTimestamps,
    latency: latencyWithTimestamps,
  });
});

// Session Management Endpoints

// Get all sessions
app.get("/sessions", (req, res) => {
  const activeOnly = req.query.active === "true";
  const sessions = activeOnly
    ? sessionManager.getActiveSessions()
    : sessionManager.getAllSessions();

  res.json({
    count: sessions.length,
    sessions: sessions.map((s) => ({
      callSid: s.callSid,
      streamSid: s.streamSid,
      from: s.from,
      to: s.to,
      startedAt: s.startedAt,
      status: s.status,
      packetCount: s.packetCount,
      transcriptCount: s.transcripts.length,
    })),
  });
});

// Get session by callSid
app.get("/sessions/:callSid", (req, res) => {
  const { callSid } = req.params;
  const session = sessionManager.getSession(callSid);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  return res.json({
    callSid: session.callSid,
    streamSid: session.streamSid,
    accountSid: session.accountSid,
    from: session.from,
    to: session.to,
    startedAt: session.startedAt,
    status: session.status,
    packetCount: session.packetCount,
    transcriptCount: session.transcripts.length,
    transcripts: session.transcripts,
  });
});

// Get transcripts for a specific call
app.get("/calls/:callSid/transcripts", (req, res) => {
  const { callSid } = req.params;
  const finalOnly = req.query.final === "true";
  const session = sessionManager.getSession(callSid);

  if (!session) {
    return res.status(404).json({ error: "Call session not found" });
  }

  const filtered = finalOnly
    ? session.transcripts.filter((t) => t.isFinal)
    : session.transcripts;

  return res.json({
    callSid,
    count: filtered.length,
    transcripts: filtered,
  });
});

// Get VAD state for a call
app.get("/calls/:callSid/vad", (req, res) => {
  const { callSid } = req.params;
  const state = vadService.getState(callSid);
  const isTurnComplete = vadService.isTurnComplete(callSid);

  if (!state) {
    return res.status(404).json({ error: "VAD state not found for this call" });
  }

  return res.json({
    callSid,
    isSpeaking: state.isSpeaking,
    silenceDuration: state.silenceDuration,
    lastTranscriptTime: state.lastTranscriptTime,
    lastFinalTranscriptTime: state.lastFinalTranscriptTime,
    isTurnComplete,
  });
});

// Create WebSocket server for media streams (handles upgrade automatically)
const wss = createMediaStreamServer(server);
console.log("🔧 WebSocket server created and attached to HTTP server");

server.listen(PORT, async () => {
  const baseUrl = `http://${process.env.WEBHOOK_BASE_URL}:${PORT}`;
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook endpoint: ${baseUrl}/incoming-call`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/media-stream`);
  console.log(`Session endpoint: ${baseUrl}/media-stream`);
  console.log(`Sessions endpoint: ${baseUrl}/sessions/:callSid`);
  console.log(`Transcripts endpoint: ${baseUrl}/sessions?active=true`);

  // Optionally start ngrok if ENABLE_NGROK is set
  if (process.env.ENABLE_NGROK === "true") {
    try {
      const ngrokUrl = await startNgrok(PORT);
      console.log(`\n✅ Ready for Twilio webhooks!`);
      console.log(`📋 Configure Twilio webhook URL: ${ngrokUrl}/incoming-call`);
      console.log(`📋 Use this for WEBSOCKET_URL: ${ngrokUrl}\n`);
    } catch (error) {
      console.error("⚠️  ngrok failed to start, but server is running");
      console.error("   You can still use ngrok CLI: ngrok http 3000");
    }
  }
});
