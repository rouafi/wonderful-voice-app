export const config = {
  port: process.env.PORT || 3000,
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  },
  websocketUrl: process.env.WEBSOCKET_URL || "https://your-websocket-url.com",
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || "http://localhost:3000",
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY || "",
  },
};
