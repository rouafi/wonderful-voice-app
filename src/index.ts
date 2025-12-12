import express from "express";
import dotenv from "dotenv";
import { createServer } from "http";
import { incomingCallRouter } from "./routes/incomingCall.js";
import { startNgrok } from "./utils/ngrok.js";
import { createMediaStreamServer } from "./websocket/mediaStream.js";

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

// Create WebSocket server for media streams (handles upgrade automatically)
const wss = createMediaStreamServer(server);
console.log("🔧 WebSocket server created and attached to HTTP server");

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/incoming-call`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/media-stream`);

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
