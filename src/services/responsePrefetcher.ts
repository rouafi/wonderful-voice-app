/**
 * Response Prefetcher Service
 * Pre-generates TTS audio for common responses to enable instant playback
 */

import { textToSpeech } from "./tts.js";

export interface PrefetchedResponse {
  text: string;
  audioBuffer: Buffer;
  keywords: string[]; // Keywords to match against
}

export class ResponsePrefetcher {
  private cache: Map<string, PrefetchedResponse> = new Map();
  private isInitialized = false;

  /**
   * Initialize and pre-generate common responses
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("✅ Response prefetcher already initialized");
      return;
    }

    console.log("🔄 Initializing response prefetcher...");

    const commonResponses: Array<{
      text: string;
      keywords: string[];
    }> = [
      {
        text: "Hello! Welcome to our Paris XVI clinic. How can I help you today?",
        keywords: ["hello", "greeting", "hi"],
      },
      {
        text: "Could you please clarify the date and time?",
        keywords: ["clarify", "date", "time", "unclear"],
      },
      {
        text: "Could you please clarify the date and time for your appointment?",
        keywords: ["clarify appointment", "date time appointment"],
      },
      {
        text: "I understand. Let me check the availability for you.",
        keywords: ["check", "availability", "understand"],
      },
      {
        text: "I'm sorry, I didn't catch that. Could you repeat?",
        keywords: ["sorry", "didn't catch", "repeat"],
      },
      {
        text: "I'm sorry, that time isn't available. Could you suggest another time?",
        keywords: ["not available", "unavailable", "suggest another"],
      },
      {
        text: "Great! Your appointment is confirmed. You'll receive an SMS confirmation shortly.",
        keywords: ["appointment confirmed", "confirmed", "SMS confirmation"],
      },
      {
        text: "I've checked the availability. Please check your SMS for details.",
        keywords: ["checked availability", "SMS details"],
      },
      {
        text: "Thank you for calling. Have a great day!",
        keywords: ["thank you", "goodbye", "end"],
      },
    ];

    const prefetchPromises = commonResponses.map(async (response) => {
      try {
        const audioBuffer = await textToSpeech(response.text, {
          encoding: "mulaw",
          sampleRate: 8000,
        });

        const prefetched: PrefetchedResponse = {
          text: response.text,
          audioBuffer,
          keywords: response.keywords,
        };

        // Store by exact text
        this.cache.set(response.text.toLowerCase().trim(), prefetched);

        // Also store by keywords for fuzzy matching
        response.keywords.forEach((keyword) => {
          if (!this.cache.has(keyword)) {
            this.cache.set(keyword, prefetched);
          }
        });

        console.log(
          `✅ Prefetched: "${response.text.substring(0, 40)}${
            response.text.length > 40 ? "..." : ""
          }"`
        );
      } catch (error: any) {
        console.error(
          `❌ Failed to prefetch "${response.text}":`,
          error.message
        );
      }
    });

    await Promise.all(prefetchPromises);
    this.isInitialized = true;
    console.log(
      `✅ Response prefetcher initialized with ${this.cache.size} cached responses`
    );
  }

  /**
   * Get prefetched audio for a response text
   * Returns null if no match found
   */
  getPrefetchedAudio(responseText: string): Buffer | null {
    if (!this.isInitialized) {
      return null;
    }

    const normalizedText = responseText.toLowerCase().trim();

    // Try exact match first
    const exactMatch = this.cache.get(normalizedText);
    if (exactMatch) {
      console.log(
        `⚡ Using prefetched audio for exact match: "${responseText.substring(
          0,
          40
        )}..."`
      );
      return exactMatch.audioBuffer;
    }

    // Try keyword matching
    for (const [key, prefetched] of this.cache.entries()) {
      if (
        prefetched.keywords.some((keyword) => normalizedText.includes(keyword))
      ) {
        console.log(
          `⚡ Using prefetched audio for keyword match: "${responseText.substring(
            0,
            40
          )}..."`
        );
        return prefetched.audioBuffer;
      }
    }

    // Try partial text matching (if response contains prefetched text)
    for (const [key, prefetched] of this.cache.entries()) {
      if (
        normalizedText.includes(prefetched.text.toLowerCase()) ||
        prefetched.text.toLowerCase().includes(normalizedText)
      ) {
        console.log(
          `⚡ Using prefetched audio for partial match: "${responseText.substring(
            0,
            40
          )}..."`
        );
        return prefetched.audioBuffer;
      }
    }

    return null;
  }

  /**
   * Check if a response is likely to match a prefetched response
   */
  hasPrefetched(responseText: string): boolean {
    return this.getPrefetchedAudio(responseText) !== null;
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; isInitialized: boolean } {
    return {
      size: this.cache.size,
      isInitialized: this.isInitialized,
    };
  }
}

// Singleton instance
export const responsePrefetcher = new ResponsePrefetcher();
