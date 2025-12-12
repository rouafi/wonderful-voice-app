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
  private delayedCheckTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Timeouts before starting frequent checks
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
      // Stop frequent checking and reset to delayed mode
      this.stopFrequentChecking(callSid);
      // Start delayed check: wait 500ms, then start frequent checking
      this.startDelayedCheck(callSid);
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
      if (state.isSpeaking) {
        // Only log when transitioning from speaking to not speaking
        console.log(
          `🔇 VAD: Marking as not speaking for call ${callSid.substring(
            0,
            8
          )} - ` + `silence: ${state.silenceDuration}ms`
        );
      }
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

    if (!state) return false;

    // Update silence duration first
    this.updateSilence(callSid);

    // Turn complete if: silence exceeds timeout (regardless of isSpeaking flag)
    // This ensures we detect completion even if isSpeaking wasn't properly set to false
    const isComplete = state.silenceDuration >= config.silenceTimeout;

    // Only return true if we haven't already logged this turn completion
    // AND we've had at least one transcript (to avoid false positives at call start)
    const hasHadTranscript =
      state.lastTranscriptTime > 0 && state.lastFinalTranscriptTime > 0;

    if (
      isComplete &&
      hasHadTranscript &&
      !this.turnCompleteLogged.has(callSid)
    ) {
      this.turnCompleteLogged.add(callSid);
      console.log(
        `🎯 VAD: Turn complete detected for call ${callSid.substring(
          0,
          8
        )} - ` +
          `silence: ${state.silenceDuration}ms (threshold: ${config.silenceTimeout}ms)`
      );
      return true;
    }

    return false;
  }

  /**
   * Start delayed check: wait 500ms after last transcript, then start frequent checking
   * Optimized for faster response time
   */
  private startDelayedCheck(callSid: string): void {
    // Clear existing delayed timeout if any
    const existingTimeout = this.delayedCheckTimeouts.get(callSid);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Wait 500ms before starting frequent checks (reduced from 2s for faster response)
    const timeout = setTimeout(() => {
      this.delayedCheckTimeouts.delete(callSid);
      // Now start frequent checking (200ms interval)
      this.startFrequentChecking(callSid);
    }, 500); // Wait 500ms (optimized from 2s)

    this.delayedCheckTimeouts.set(callSid, timeout);
    console.log(
      `⏱️ VAD: Starting 500ms delayed check for call ${callSid.substring(0, 8)}`
    );
  }

  /**
   * Stop frequent checking (when new transcript arrives)
   */
  private stopFrequentChecking(callSid: string): void {
    const interval = this.checkIntervals.get(callSid);
    if (interval) {
      clearInterval(interval);
      this.checkIntervals.delete(callSid);
    }
  }

  /**
   * Start frequent checking (200ms interval) - called after 2 second delay
   */
  private startFrequentChecking(callSid: string): void {
    // Clear existing interval if any
    this.stopFrequentChecking(callSid);

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

      // Only check for turn completion if we've had at least one transcript
      // (to avoid false positives at call start)
      if (state.lastFinalTranscriptTime > 0 && this.isTurnComplete(callSid)) {
        // Trigger callback
        this.onTurnComplete(callSid);
        // Stop frequent checking after turn is detected (will restart on next transcript)
        this.stopFrequentChecking(callSid);
      }
    }, 200); // Check every 200ms

    this.checkIntervals.set(callSid, interval);
    console.log(
      `⏱️ VAD: Started frequent checking (200ms) for call ${callSid.substring(
        0,
        8
      )}`
    );
  }

  /**
   * Start periodic checking for turn completion (legacy - now uses delayed check)
   */
  private startPeriodicCheck(callSid: string): void {
    // This is called when state is first created
    // We don't start checking immediately - wait for first transcript
    // The checking will start after first final transcript via startDelayedCheck
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

    // Initialize state if it doesn't exist yet
    if (!this.states.has(callSid)) {
      const now = Date.now();
      this.states.set(callSid, {
        isSpeaking: false,
        lastTranscriptTime: now,
        silenceDuration: 0,
        lastFinalTranscriptTime: 0,
      });
      // Start periodic checking
      this.startPeriodicCheck(callSid);
      console.log(
        `✅ VAD state initialized and periodic check started for call ${callSid.substring(
          0,
          8
        )}`
      );
    }
  }

  /**
   * Get default config based on mode
   */
  private getDefaultConfig(): VADConfig {
    return {
      silenceTimeout: 600, // 1.5s default
      mode: "patient",
    };
  }

  /**
   * Clean up state for ended call
   */
  cleanup(callSid: string): void {
    // Clear periodic check interval
    this.stopFrequentChecking(callSid);

    // Clear delayed check timeout
    const delayedTimeout = this.delayedCheckTimeouts.get(callSid);
    if (delayedTimeout) {
      clearTimeout(delayedTimeout);
      this.delayedCheckTimeouts.delete(callSid);
    }

    this.states.delete(callSid);
    this.configs.delete(callSid);
    this.turnCompleteLogged.delete(callSid);
    this.turnCompleteCallbacks.delete(callSid);
  }
}

// Global VAD service instance
export const vadService = new VADService();
