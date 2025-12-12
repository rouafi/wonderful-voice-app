/**
 * LLM Agent Service using OpenRouter API
 * Detects user intent and manages conversation flow
 */

import {
  doctorAvailabilityService,
  AvailabilityQuery,
} from "./doctorAvailability.js";
import { smsService } from "./sms.js";

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentResponse {
  text: string;
  intent?: "book_appointment" | "other";
  extractedData?: {
    dateTime?: string;
    doctorId?: string;
    patientPhone?: string;
  };
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, any>;
  }>;
}

export interface AgentContext {
  callSid: string;
  patientPhone: string;
  conversationHistory: AgentMessage[];
}

/**
 * LLM Agent for doctor booking
 */
export class BookingAgent {
  private apiKey: string;
  private apiUrl = "https://openrouter.ai/api/v1/chat/completions";
  private model = "openai/gpt-4o-mini"; // Cost-effective model

  constructor(apiKey: string) {
    // Trim whitespace and validate
    this.apiKey = (apiKey || "").trim();
    if (!this.apiKey) {
      throw new Error("OpenRouter API key is required but was not provided");
    }
  }

  /**
   * Process user transcript and detect intent
   */
  async processTranscript(
    transcript: string,
    context: AgentContext
  ): Promise<AgentResponse> {
    const processingStartTime = Date.now();
    console.log(`\n🤖 ===== AGENT PROCESSING TRANSCRIPT =====`);
    console.log(`📝 Transcript: "${transcript}"`);
    console.log(`📞 Call SID: ${context.callSid}`);
    console.log(`📱 Patient Phone: ${context.patientPhone}`);
    console.log(
      `💬 Conversation history length: ${context.conversationHistory.length}`
    );

    // Add user message to conversation history
    context.conversationHistory.push({
      role: "user",
      content: transcript,
    });

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(context);

    // Prepare messages for API
    const messages: AgentMessage[] = [
      { role: "system", content: systemPrompt },
      ...context.conversationHistory.slice(-10), // Keep last 10 messages for context
    ];

    try {
      // Validate API key before making request
      if (!this.apiKey || this.apiKey.trim() === "") {
        throw new Error("OpenRouter API key is not configured");
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://wonderful-voice-app.com", // Optional
        "X-Title": "Wonderful Voice App", // Optional but recommended by OpenRouter
      };

      // Debug: log masked API key for troubleshooting
      const maskedKey =
        this.apiKey.length > 12
          ? `${this.apiKey.substring(0, 8)}...${this.apiKey.substring(
              this.apiKey.length - 4
            )}`
          : "***masked***";
      console.log(
        `🔑 Making OpenRouter API request with key: ${maskedKey} (length: ${this.apiKey.length})`
      );

      const apiCallStartTime = Date.now();
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: 0.7,
          tools: [
            {
              type: "function",
              function: {
                name: "checkDoctorAvailability",
                description:
                  "Check if a doctor is available at a specific date and time. ONLY use this when you are >80% certain about the date and time. If uncertain, ask for clarification instead.",
                parameters: {
                  type: "object",
                  properties: {
                    dateTime: {
                      type: "string",
                      description:
                        "ISO 8601 datetime string with minute precision (e.g., '2024-01-15T14:30:00Z')",
                    },
                    doctorId: {
                      type: "string",
                      description:
                        "Optional doctor ID. If not provided, will find first available doctor.",
                    },
                    confidence: {
                      type: "number",
                      description:
                        "Your confidence level (0.0 to 1.0) that the dateTime is correctly understood. Must be >0.8 to proceed.",
                      minimum: 0,
                      maximum: 1,
                    },
                  },
                  required: ["dateTime", "confidence"],
                },
              },
            },
          ],
          tool_choice: "auto",
        }),
      });

      const apiCallLatency = Date.now() - apiCallStartTime;
      console.log(`⏱️ OpenRouter API call latency: ${apiCallLatency}ms`);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as any;
      const choice = data.choices?.[0];

      if (!choice) {
        throw new Error("No response from OpenRouter API");
      }

      // Handle tool calls
      if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
        console.log(
          `🔧 LLM requested tool calls:`,
          JSON.stringify(choice.message.tool_calls, null, 2)
        );
        const toolCallStartTime = Date.now();
        const result = await this.handleToolCalls(
          choice.message.tool_calls,
          context
        );
        const toolCallLatency = Date.now() - toolCallStartTime;
        const totalLatency = Date.now() - processingStartTime;
        console.log(
          `⏱️ Tool call processing latency: ${toolCallLatency}ms, Total: ${totalLatency}ms`
        );
        return result;
      }

      // Regular text response
      const assistantMessage = choice.message?.content || "";
      context.conversationHistory.push({
        role: "assistant",
        content: assistantMessage,
      });

      const totalLatency = Date.now() - processingStartTime;
      console.log(
        `⏱️ Total agent processing latency: ${totalLatency}ms (API: ${apiCallLatency}ms)`
      );

      // Detect intent from response
      const intent = this.detectIntent(transcript, assistantMessage);

      return {
        text: assistantMessage,
        intent,
        extractedData: {
          patientPhone: context.patientPhone,
        },
      };
    } catch (error: any) {
      console.error("❌ Agent processing error:", error);
      return {
        text: "I apologize, but I'm having trouble processing your request. Could you please repeat?",
        intent: "other",
      };
    }
  }

  /**
   * Handle tool calls from LLM
   */
  private async handleToolCalls(
    toolCalls: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>,
    context: AgentContext
  ): Promise<AgentResponse> {
    console.log(`\n🔧 ===== TOOL CALL HANDLER =====`);
    console.log(`📋 Received ${toolCalls.length} tool call(s) from LLM`);
    console.log(`📞 Call SID: ${context.callSid}`);
    console.log(`📱 Patient Phone: ${context.patientPhone}`);

    const results: any[] = [];

    for (const toolCall of toolCalls) {
      console.log(`\n🔨 Processing tool call:`);
      console.log(`   ID: ${toolCall.id}`);
      console.log(`   Name: ${toolCall.function.name}`);
      console.log(`   Raw arguments: ${toolCall.function.arguments}`);

      if (toolCall.function.name === "checkDoctorAvailability") {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`   Parsed arguments:`, JSON.stringify(args, null, 2));

          const confidence = args.confidence || 0;
          console.log(`   Confidence level: ${(confidence * 100).toFixed(0)}%`);

          // Only proceed if confidence > 80%
          if (confidence < 0.8) {
            console.log(
              `⚠️ Confidence too low (${(confidence * 100).toFixed(
                0
              )}% < 80%), asking for clarification`
            );
            results.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "checkDoctorAvailability",
              content: JSON.stringify({
                error: "confidence_too_low",
                message: `Confidence level ${(confidence * 100).toFixed(
                  0
                )}% is below the required 80%. Please ask the patient to clarify the date and time.`,
                confidence: confidence,
              }),
            });
            continue; // Skip to next tool call
          }

          const query: AvailabilityQuery = {
            dateTime: args.dateTime,
            doctorId: args.doctorId,
            durationMinutes: 30,
          };

          console.log(`\n🔍 Checking doctor availability:`);
          console.log(`   DateTime: ${query.dateTime}`);
          console.log(
            `   Doctor ID: ${
              query.doctorId || "not specified (will find first available)"
            }`
          );
          console.log(`   Duration: ${query.durationMinutes} minutes`);

          const availability =
            await doctorAvailabilityService.checkAvailability(query);

          console.log(`\n✅ Availability check result:`);
          console.log(`   Available: ${availability.available}`);
          console.log(`   Doctor: ${availability.doctorName}`);
          console.log(`   Message: ${availability.message || "N/A"}`);

          // Send SMS confirmation (fire and forget - don't wait for result)
          // Only send if confidence was high enough (already checked above)
          if (availability.available) {
            console.log(`\n📱 Sending SMS confirmation (fire-and-forget):`);
            console.log(`   To: ${context.patientPhone}`);
            console.log(`   Doctor: ${availability.doctorName}`);
            console.log(`   DateTime: ${query.dateTime}`);

            // Fire and forget - don't await, just trigger and continue
            smsService
              .sendAvailabilityConfirmation(
                context.patientPhone,
                availability.doctorName,
                query.dateTime,
                true
              )
              .then((smsResult) => {
                if (smsResult.success) {
                  console.log(
                    `✅ SMS sent successfully: ${smsResult.messageSid}`
                  );
                } else {
                  console.error(`❌ SMS failed: ${smsResult.error}`);
                }
              })
              .catch((error) => {
                console.error(`❌ SMS sending error:`, error);
              });

            // Return success immediately without waiting for SMS
            results.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "checkDoctorAvailability",
              content: JSON.stringify({
                available: true,
                doctorName: availability.doctorName,
                dateTime: query.dateTime,
                smsSent: true, // Assume success, actual result logged separately
                message: `Appointment confirmed! SMS is being sent to ${context.patientPhone}`,
              }),
            });
          } else {
            console.log(`\n⚠️ Doctor not available - skipping SMS`);
            results.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "checkDoctorAvailability",
              content: JSON.stringify({
                available: false,
                message: availability.message || "Doctor not available",
                availableSlots: availability.availableSlots,
              }),
            });
          }
        } catch (error: any) {
          console.error(
            `\n❌ Error executing tool call ${toolCall.id}:`,
            error
          );
          results.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "checkDoctorAvailability",
            content: JSON.stringify({
              error: error.message || "Failed to check availability",
            }),
          });
        }
      } else {
        console.warn(`⚠️ Unknown tool call: ${toolCall.function.name}`);
      }
    }

    console.log(
      `\n📤 Tool call results (${results.length}):`,
      JSON.stringify(results, null, 2)
    );

    // Get LLM response with tool results
    const secondApiCallStartTime = Date.now();
    console.log(`\n🔄 Sending tool results back to LLM for final response...`);

    // Format messages correctly for OpenAI-compatible API
    // The conversation history already has the user message
    // We need to add: assistant message with tool_calls, then tool results
    const messagesForAPI: any[] = context.conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Add assistant message with tool_calls (this is what the LLM sent originally)
    messagesForAPI.push({
      role: "assistant",
      content: null, // When tool calls are present, content is null
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    });

    // Add tool results
    results.forEach((r) => {
      messagesForAPI.push({
        role: "tool",
        content: r.content,
        tool_call_id: r.tool_call_id,
        name: r.name,
      });
    });

    console.log(
      `📋 Messages being sent to LLM:`,
      JSON.stringify(messagesForAPI.slice(-5), null, 2)
    ); // Log last 5 messages

    try {
      // Validate API key before making request
      if (!this.apiKey || this.apiKey.trim() === "") {
        throw new Error("OpenRouter API key is not configured");
      }

      console.log(
        `📤 Requesting LLM final response with ${messagesForAPI.length} messages`
      );
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Title": "Wonderful Voice App", // Optional but recommended by OpenRouter
        },
        body: JSON.stringify({
          model: this.model,
          messages: messagesForAPI,
          temperature: 0.7,
        }),
      });

      const secondApiCallLatency = Date.now() - secondApiCallStartTime;
      console.log(
        `⏱️ Second OpenRouter API call latency: ${secondApiCallLatency}ms`
      );

      const data = (await response.json()) as any;
      const assistantMessage = data.choices?.[0]?.message?.content || "";

      console.log(`\n✅ LLM final response received:`);
      console.log(`   Content: "${assistantMessage}"`);
      console.log(
        `   Full response structure:`,
        JSON.stringify(data.choices?.[0]?.message, null, 2)
      );

      // If message is empty, check if there's an error or if we need to handle it differently
      if (!assistantMessage || assistantMessage.trim() === "") {
        console.warn(`⚠️ LLM returned empty response after tool calls`);
        console.warn(`   Response data:`, JSON.stringify(data, null, 2));

        // Generate a fallback message based on tool results
        const hasAvailableDoctor = results.some((r) => {
          try {
            const content = JSON.parse(r.content);
            return content.available === true;
          } catch {
            return false;
          }
        });

        if (hasAvailableDoctor) {
          const availableResult = results.find((r) => {
            try {
              const content = JSON.parse(r.content);
              return content.available === true && content.doctorName;
            } catch {
              return false;
            }
          });

          if (availableResult) {
            const content = JSON.parse(availableResult.content);
            const date = new Date(content.dateTime);
            const formattedDate = date.toLocaleString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            });

            const fallbackMessage = `Great! Your appointment with ${content.doctorName} is confirmed for ${formattedDate}. You'll receive an SMS confirmation shortly.`;
            console.log(`📝 Using fallback message: "${fallbackMessage}"`);

            context.conversationHistory.push({
              role: "assistant",
              content: fallbackMessage,
            });

            return {
              text: fallbackMessage,
              intent: "book_appointment",
              extractedData: {
                patientPhone: context.patientPhone,
              },
              toolCalls: toolCalls.map((tc) => ({
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments),
              })),
            };
          }
        }
      }

      context.conversationHistory.push({
        role: "assistant",
        content: assistantMessage,
      });

      const totalToolCallLatency = Date.now() - secondApiCallStartTime;
      console.log(
        `⏱️ Total tool call handler latency: ${totalToolCallLatency}ms (includes 2 API calls)`
      );
      console.log(`\n🔧 ===== TOOL CALL HANDLER COMPLETE =====\n`);

      return {
        text: assistantMessage,
        intent: "book_appointment",
        extractedData: {
          patientPhone: context.patientPhone,
        },
        toolCalls: toolCalls.map((tc) => ({
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })),
      };
    } catch (error: any) {
      console.error("❌ Error getting LLM response after tool calls:", error);
      return {
        text: "I've checked the availability. Please check your SMS for confirmation details.",
        intent: "book_appointment",
      };
    }
  }

  /**
   * Build system prompt for the agent
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `You are a helpful medical appointment booking assistant. Your role is to:

1. Listen to patients who want to book doctor appointments
2. Extract the date and time they want (with minute precision)
3. Check doctor availability using the checkDoctorAvailability tool
4. Confirm appointments and send SMS confirmations

Guidelines:
- Be friendly, professional, and empathetic
- Ask for clarification if the date/time is unclear
- When a patient mentions wanting to book, use the checkDoctorAvailability tool
- If the patient doesn't specify a doctor, find any available doctor
- CRITICAL: Only use checkDoctorAvailability when you are >80% certain about the date and time
- If you're less than 80% certain, ask for clarification instead
- Always confirm the appointment details before booking
- Keep responses concise for voice conversations

IMPORTANT - When confirming an appointment, always mention:
- The doctor's full name (e.g., "Dr. Sarah Smith" or "Dr. Michael Johnson")
- The appointment date and time in a natural, readable format (e.g., "Monday, January 15, 2024, at 2:30 PM")
- Format your confirmation like: "Your appointment with [Doctor Name] is confirmed for [Date and Time]"
- Example: "Great! Your appointment with Dr. Sarah Smith is confirmed for Monday, January 15, 2024, at 2:30 PM. You'll receive an SMS confirmation shortly."

Current patient phone: ${context.patientPhone}
Call SID: ${context.callSid}`;
  }

  /**
   * Detect intent from transcript
   */
  private detectIntent(
    transcript: string,
    response: string
  ): "book_appointment" | "other" {
    const bookingKeywords = [
      "book",
      "appointment",
      "schedule",
      "available",
      "doctor",
      "see a doctor",
      "meet with",
    ];

    const lowerTranscript = transcript.toLowerCase();
    return bookingKeywords.some((keyword) => lowerTranscript.includes(keyword))
      ? "book_appointment"
      : "other";
  }
}

/**
 * Agent manager to handle multiple concurrent calls
 */
export class AgentManager {
  private agents: Map<string, BookingAgent> = new Map();
  private contexts: Map<string, AgentContext> = new Map();

  constructor(apiKey: string) {
    // Create a shared agent instance (can be per-call if needed)
    this.agents.set("default", new BookingAgent(apiKey));
  }

  /**
   * Get or create context for a call
   */
  getContext(callSid: string, patientPhone: string): AgentContext {
    let context = this.contexts.get(callSid);
    if (!context) {
      context = {
        callSid,
        patientPhone,
        conversationHistory: [],
      };
      this.contexts.set(callSid, context);
    }
    return context;
  }

  /**
   * Process transcript for a call
   */
  async processTranscript(
    callSid: string,
    patientPhone: string,
    transcript: string
  ): Promise<AgentResponse> {
    const agent = this.agents.get("default")!;
    const context = this.getContext(callSid, patientPhone);
    return agent.processTranscript(transcript, context);
  }

  /**
   * Clean up context for ended call
   */
  cleanup(callSid: string): void {
    this.contexts.delete(callSid);
  }
}

// Global agent manager instance - will be initialized in index.ts
// This allows the API key to be loaded from config (which reads from .env)
export let agentManager: AgentManager | undefined;

/**
 * Initialize the agent manager with API key
 * Called from index.ts after config is loaded
 */
export function initializeAgentManager(apiKey: string): void {
  const trimmedKey = (apiKey || "").trim();

  if (!trimmedKey) {
    console.error("❌ OPENROUTER_API_KEY not configured. Agent will not work.");
    console.error(
      "   Please set OPENROUTER_API_KEY in your .env file or environment variables."
    );
    // Create agent manager without key (will handle gracefully)
    agentManager = new AgentManager("");
  } else {
    // Log masked version for verification (first 8 chars + last 4 chars)
    const masked =
      trimmedKey.length > 12
        ? `${trimmedKey.substring(0, 8)}...${trimmedKey.substring(
            trimmedKey.length - 4
          )}`
        : "***masked***";
    console.log(
      `✅ OpenRouter API key loaded: ${masked} (length: ${trimmedKey.length})`
    );
    agentManager = new AgentManager(trimmedKey);
  }
}
