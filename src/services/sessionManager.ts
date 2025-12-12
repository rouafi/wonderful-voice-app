import { createDeepgramClient } from "./deepgram.js";
import { BatchingBackpressureService } from "./backpressure.js";
import { vadService } from "./vad.js";
import { agentManager } from "./agent.js";
import { phoneStore } from "./phoneStore.js";

export interface CallSession {
  callSid: string;
  streamSid?: string;
  accountSid?: string;
  from?: string;
  to?: string;
  startedAt: number;
  deepgramConnection: ReturnType<typeof createDeepgramClient>;
  backpressureService: BatchingBackpressureService<Buffer>;
  transcripts: Array<{
    text: string;
    isFinal: boolean;
    latency: number;
    timestamp: number;
  }>;
  packetCount: number;
  status: "active" | "ended";
}

export class SessionManager {
  private sessions: Map<string, CallSession> = new Map();

  /**
   * Create a new session for a call
   */
  createSession(
    callSid: string,
    metadata?: {
      streamSid?: string;
      accountSid?: string;
      from?: string;
      to?: string;
    }
  ): CallSession {
    // Clean up existing session if any (shouldn't happen, but safety)
    if (this.sessions.has(callSid)) {
      this.endSession(callSid);
    }

    console.log(`📞 Creating session for call: ${callSid}`);

    // Create Deepgram connection with callSid
    const deepgramConnection = createDeepgramClient(callSid);

    // Create backpressure service
    const backpressureService = new BatchingBackpressureService<Buffer>(
      // canSend: check if Deepgram connection is ready
      () => {
        const state = (deepgramConnection as any).getReadyState?.();
        return state === 1 || state === undefined;
      },
      // sendItem: send batched audio buffer to Deepgram
      async (batchedAudio: Buffer) => {
        (deepgramConnection.send as any)(batchedAudio);
      },
      {
        batchSize: 5,
        batchTimeout: 100,
        maxQueueSize: 500,
        processInterval: 50,
        onQueueFull: () => {
          console.warn(
            `⚠️ Audio queue is full for call ${callSid}, dropping packets`
          );
        },
      }
    );

    const session: CallSession = {
      callSid,
      streamSid: metadata?.streamSid,
      accountSid: metadata?.accountSid,
      from: metadata?.from,
      to: metadata?.to,
      startedAt: Date.now(),
      deepgramConnection,
      backpressureService,
      transcripts: [],
      packetCount: 0,
      status: "active",
    };

    this.sessions.set(callSid, session);
    console.log(`✅ Session created for call ${callSid}`);

    return session;
  }

  /**
   * Get session by callSid
   */
  getSession(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  /**
   * Add transcript to session
   */
  addTranscript(
    callSid: string,
    transcript: {
      text: string;
      isFinal: boolean;
      latency: number;
      timestamp: number;
    }
  ): void {
    const session = this.sessions.get(callSid);
    if (session) {
      session.transcripts.push(transcript);
      // Keep only last 1000 transcripts per call
      if (session.transcripts.length > 1000) {
        session.transcripts.shift();
      }
    }
  }

  /**
   * Increment packet count
   */
  incrementPacketCount(callSid: string): void {
    const session = this.sessions.get(callSid);
    if (session) {
      session.packetCount++;
    }
  }

  /**
   * End session and cleanup resources
   */
  async endSession(callSid: string): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session) {
      return;
    }

    console.log(`🛑 Ending session for call: ${callSid}`);

    // Flush backpressure service
    try {
      await session.backpressureService.flush();
    } catch (error) {
      console.error(
        `❌ Error flushing backpressure for call ${callSid}:`,
        error
      );
    }

    // Close Deepgram connection
    try {
      session.deepgramConnection.finish();
    } catch (error) {
      console.error(`❌ Error closing Deepgram for call ${callSid}:`, error);
    }

    session.status = "ended";

    // Cleanup VAD state
    vadService.cleanup(callSid);

    // Cleanup agent context (if initialized)
    if (agentManager) {
      agentManager.cleanup(callSid);
    }

    // Cleanup phone number
    phoneStore.remove(callSid);

    // Keep session for querying (don't delete immediately)
    // Optionally: delete after some time or limit total sessions
    console.log(`✅ Session ended for call ${callSid} (kept for querying)`);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): CallSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "active"
    );
  }

  /**
   * Get all sessions (active + ended)
   */
  getAllSessions(): CallSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clean up old ended sessions (keep last N)
   */
  cleanupOldSessions(keepLast: number = 100): void {
    const endedSessions = Array.from(this.sessions.entries())
      .filter(([_, session]) => session.status === "ended")
      .sort((a, b) => b[1].startedAt - a[1].startedAt); // Most recent first

    if (endedSessions.length > keepLast) {
      const toRemove = endedSessions.slice(keepLast);
      toRemove.forEach(([callSid]) => {
        this.sessions.delete(callSid);
        console.log(`🧹 Cleaned up old session: ${callSid}`);
      });
    }
  }
}

// Global session manager instance
export const sessionManager = new SessionManager();
