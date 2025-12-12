export interface VADState {
  isSpeaking: boolean;
  lastTranscriptTime: number;
  silenceDuration: number; // ms since last transcript
  lastFinalTranscriptTime: number;
}

export interface VADConfig {
  silenceTimeout: number; // ms of silence to consider turn complete
  mode: "patient" | "agent"; // Different timeouts for different roles
}

export type TurnCompleteCallback = (callSid: string) => void;

export class VADService {
  private states: Map<string, VADState> = new Map();
  private configs: Map<string, VADConfig> = new Map();
  private checkIntervals: Map<string, NodeJS.Timeout> = new Map();
  private turnCompleteLogged: Set<string> = new Set(); // Track which calls already logged turn complete
  private turnCompleteCallbacks: Map<string, TurnCompleteCallback> = new Map();

  /**
   * Update VAD state from transcript
   */
  updateFromTranscript(callSid: string, isFinal: boolean): void {
    const now = Date.now();
    let state = this.states.get(callSid);

    if (!state) {
      state = {
        isSpeaking: false,
        lastTranscriptTime: now,
        silenceDuration: 0,
        lastFinalTranscriptTime: 0,
      };
      this.states.set(callSid, state);
      // Start periodic checking for this call
      this.startPeriodicCheck(callSid);
    }

    // Any transcript (interim or final) = speaking
    state.isSpeaking = true;
    state.lastTranscriptTime = now;
    state.silenceDuration = 0;

    // Reset turn complete flag when new speech detected
    this.turnCompleteLogged.delete(callSid);

    // Final transcript = turn might be ending
    if (isFinal) {
      state.lastFinalTranscriptTime = now;
    }
  }

  /**
   * Check current silence duration (call periodically)
   */
  updateSilence(callSid: string): void {
    const state = this.states.get(callSid);
    if (!state) return;

    const now = Date.now();
    state.silenceDuration = now - state.lastTranscriptTime;

    // If silence exceeds threshold, mark as not speaking
    const config = this.configs.get(callSid) || this.getDefaultConfig();
    if (state.silenceDuration >= config.silenceTimeout) {
      state.isSpeaking = false;
    }
  }

  /**
   * Check if turn is complete (patient finished speaking)
   * Returns true only once per turn (until new speech is detected)
   */
  isTurnComplete(callSid: string): boolean {
    const state = this.states.get(callSid);
    const config = this.configs.get(callSid) || this.getDefaultConfig();
    console.log("VAD config", config);
    console.log("VAD state", state);

    if (!state) return false;

    // Update silence duration
    this.updateSilence(callSid);

    // Turn complete if: not speaking AND silence exceeds timeout
    const isComplete =
      !state.isSpeaking && state.silenceDuration >= config.silenceTimeout;

    // Only return true if we haven't already logged this turn completion
    if (isComplete && !this.turnCompleteLogged.has(callSid)) {
      this.turnCompleteLogged.add(callSid);
      return true;
    }

    return false;
  }

  /**
   * Start periodic checking for turn completion
   */
  private startPeriodicCheck(callSid: string): void {
    // Clear existing interval if any
    const existing = this.checkIntervals.get(callSid);
    if (existing) {
      clearInterval(existing);
    }

    // Check every 200ms for responsive detection
    const interval = setInterval(() => {
      const state = this.states.get(callSid);
      if (!state) {
        // State was cleaned up, stop checking
        clearInterval(interval);
        this.checkIntervals.delete(callSid);
        return;
      }

      // Update silence and check for turn completion
      this.updateSilence(callSid);
      if (this.isTurnComplete(callSid)) {
        // Trigger callback or event (will be handled by caller)
        this.onTurnComplete(callSid);
      }
    }, 200); // Check every 200ms

    this.checkIntervals.set(callSid, interval);
  }

  /**
   * Callback when turn is detected as complete
   */
  private onTurnComplete(callSid: string): void {
    const callback = this.turnCompleteCallbacks.get(callSid);
    if (callback) {
      callback(callSid);
    }
  }

  /**
   * Get current VAD state
   */
  getState(callSid: string): VADState | undefined {
    const state = this.states.get(callSid);
    if (state) {
      this.updateSilence(callSid);
    }
    return state;
  }

  /**
   * Configure VAD for a call
   */
  configure(
    callSid: string,
    config: Partial<VADConfig>,
    onTurnComplete?: TurnCompleteCallback
  ): void {
    const current = this.configs.get(callSid) || this.getDefaultConfig();
    this.configs.set(callSid, { ...current, ...config });

    if (onTurnComplete) {
      this.turnCompleteCallbacks.set(callSid, onTurnComplete);
    }
  }

  /**
   * Get default config based on mode
   */
  private getDefaultConfig(): VADConfig {
    return {
      silenceTimeout: 1500, // 1.5s default
      mode: "patient",
    };
  }

  /**
   * Clean up state for ended call
   */
  cleanup(callSid: string): void {
    // Clear periodic check interval
    const interval = this.checkIntervals.get(callSid);
    if (interval) {
      clearInterval(interval);
      this.checkIntervals.delete(callSid);
    }

    this.states.delete(callSid);
    this.configs.delete(callSid);
    this.turnCompleteLogged.delete(callSid);
    this.turnCompleteCallbacks.delete(callSid);
  }
}

// Global VAD service instance
export const vadService = new VADService();
