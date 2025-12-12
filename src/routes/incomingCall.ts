import { Router, Request, Response } from "express";
import twilio from "twilio";
import { config } from "../config/index.js";

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

router.post("/", (req: Request, res: Response) => {
  try {
    console.log("📞 Incoming call webhook received");
    console.log("Call SID:", req.body.CallSid);
    console.log("From:", req.body.From);
    console.log("To:", req.body.To);

    const twiml = new VoiceResponse();

    // Get the WebSocket URL directly from environment (config might be cached)
    let wsUrl = process.env.WEBSOCKET_URL || config.websocketUrl;

    console.log("🔍 WEBSOCKET_URL from env:", process.env.WEBSOCKET_URL);
    console.log("🔍 WEBSOCKET_URL being used:", wsUrl);

    // Validate WebSocket URL is configured
    if (!wsUrl || wsUrl === "https://your-websocket-url.com" || wsUrl === "") {
      console.error("❌ WEBSOCKET_URL not configured!");
      console.error("   Env value:", process.env.WEBSOCKET_URL);
      console.error("   Config value:", config.websocketUrl);
      const errorTwiml = new VoiceResponse();
      errorTwiml.say("Sorry, the service is not properly configured.");
      res.type("text/xml");
      res.send(errorTwiml.toString());
      return;
    }

    // Always use WSS (secure WebSocket) for fluid streaming
    // Convert HTTPS/HTTP to WSS
    if (wsUrl.startsWith("https://")) {
      wsUrl = wsUrl.replace("https://", "wss://");
    } else if (wsUrl.startsWith("http://")) {
      wsUrl = wsUrl.replace("http://", "wss://");
    } else if (!wsUrl.startsWith("wss://") && !wsUrl.startsWith("ws://")) {
      // If no protocol specified, assume HTTPS and convert to WSS
      wsUrl = `wss://${wsUrl}`;
    }

    // Append the media stream path
    const wsUrlWithPath = `${wsUrl}/media-stream`;

    // Optional: Add a greeting message
    // twiml.say("Connecting you to the voice assistant.");

    // Connect to WebSocket for media stream
    const connect = twiml.connect();
    connect.stream({
      url: wsUrlWithPath,
      // Optional: Add parameters for better compatibility
      // track: "both", // Track both inbound and outbound audio
    });

    const twimlResponse = twiml.toString();
    console.log("📤 Sending TwiML response:");
    console.log(twimlResponse);
    console.log("🔗 WebSocket URL:", wsUrlWithPath);
    console.log("📋 Full request body:", JSON.stringify(req.body, null, 2));

    // Set proper headers for TwiML response
    res.type("text/xml");
    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    res.status(200).send(twimlResponse);
  } catch (error) {
    console.error("❌ Error processing incoming call:", error);
    const errorTwiml = new VoiceResponse();
    errorTwiml.say("Sorry, an application error occurred.");
    res.type("text/xml");
    res.status(500).send(errorTwiml.toString());
  }
});

export { router as incomingCallRouter };
