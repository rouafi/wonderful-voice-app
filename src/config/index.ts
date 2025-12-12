// Load .env file FIRST before any config values are read
// This ensures .env variables are available when config is initialized
import dotenv from "dotenv";
dotenv.config();

/**
 * Get environment variable from .env file (via dotenv) or process.env
 * dotenv.config() loads .env into process.env, so this checks both sources
 */
function getEnv(key: string, defaultValue: string = ""): string {
  // process.env contains both system env vars and .env file vars (after dotenv.config())
  return process.env[key] || defaultValue;
}

export const config = {
  port: Number(getEnv("PORT")) || 3000,
  twilio: {
    accountSid: getEnv("TWILIO_ACCOUNT_SID"),
    authToken: getEnv("TWILIO_AUTH_TOKEN"),
    phoneNumber: getEnv("TWILIO_PHONE_NUMBER"),
  },
  websocketUrl: getEnv("WEBSOCKET_URL", "https://your-websocket-url.com"),
  webhookBaseUrl: getEnv("WEBHOOK_BASE_URL", "http://localhost:3000"),
  deepgram: {
    apiKey: getEnv("DEEPGRAM_API_KEY"),
  },
  openRouter: {
    apiKey: getEnv("OPENROUTER_API_KEY"),
  },
};
