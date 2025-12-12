// Packet tracking for fine-grained latency analysis

export interface PacketEvent {
  packetId: string;
  batchId?: string;
  stage: PacketStage;
  timestamp: number;
  metadata?: Record<string, any>;
}

export enum PacketStage {
  ARRIVED_FROM_TWILIO = "arrived_from_twilio",
  BUFFERED = "buffered",
  BATCH_CREATED = "batch_created",
  QUEUED = "queued",
  SENT_TO_DEEPGRAM = "sent_to_deepgram",
  STT_PROCESSED = "stt_processed",
}

interface BatchSentInfo {
  batchId: string;
  sentTimestamp: number;
  packetIds: string[];
}

export class PacketTracker {
  private events: Map<string, PacketEvent[]> = new Map();
  private batchToPackets: Map<string, string[]> = new Map(); // batchId -> packetIds
  private sentBatches: BatchSentInfo[] = []; // Track batches sent to Deepgram with timestamps
  private readonly MAX_SENT_BATCHES = 100; // Keep last 100 sent batches for correlation

  /**
   * Track a packet event
   */
  track(
    packetId: string,
    stage: PacketStage,
    metadata?: Record<string, any>
  ): void {
    const event: PacketEvent = {
      packetId,
      stage,
      timestamp: Date.now(),
      metadata,
    };

    if (!this.events.has(packetId)) {
      this.events.set(packetId, []);
    }
    this.events.get(packetId)!.push(event);

    // Log with formatted timestamp
    this.logEvent(event);
  }

  /**
   * Track batch creation and link packets to batch
   */
  trackBatch(batchId: string, packetIds: string[]): void {
    this.batchToPackets.set(batchId, packetIds);

    // Track batch creation for each packet
    packetIds.forEach((packetId) => {
      this.track(packetId, PacketStage.BATCH_CREATED, { batchId });
    });
  }

  /**
   * Track when a batch is sent to Deepgram (for STT correlation)
   */
  trackBatchSent(batchId: string, sentTimestamp: number): void {
    const packetIds = this.batchToPackets.get(batchId) || [];
    if (packetIds.length > 0) {
      this.sentBatches.push({
        batchId,
        sentTimestamp,
        packetIds,
      });

      // Keep only recent batches
      if (this.sentBatches.length > this.MAX_SENT_BATCHES) {
        this.sentBatches.shift();
      }
    }
  }

  /**
   * Track STT processing and correlate with sent batches
   * This finds the most recent batch(es) that could have produced this transcript
   */
  trackSTTProcessed(
    transcript: string,
    isFinal: boolean,
    receivedTimestamp: number,
    maxCorrelationWindow: number = 5000
  ): string[] {
    // Find batches sent within the correlation window
    const correlatedBatches = this.sentBatches
      .filter(
        (batch) =>
          receivedTimestamp - batch.sentTimestamp <= maxCorrelationWindow &&
          receivedTimestamp >= batch.sentTimestamp
      )
      .sort((a, b) => b.sentTimestamp - a.sentTimestamp); // Most recent first

    const processedPacketIds: string[] = [];

    if (correlatedBatches.length > 0 && correlatedBatches[0]) {
      // Process the most recent batch (or batches if multiple in window)
      // For simplicity, we'll process the most recent batch
      const mostRecentBatch = correlatedBatches[0];

      mostRecentBatch.packetIds.forEach((packetId) => {
        this.track(packetId, PacketStage.STT_PROCESSED, {
          transcript,
          isFinal,
          batchId: mostRecentBatch.batchId,
          sttLatency: receivedTimestamp - mostRecentBatch.sentTimestamp,
        });
        processedPacketIds.push(packetId);
      });
    } else {
      // No batch found in correlation window, create synthetic tracking
      const syntheticId = `stt-${receivedTimestamp}`;
      this.track(syntheticId, PacketStage.STT_PROCESSED, {
        transcript,
        isFinal,
        note: "No batch correlation found",
      });
      processedPacketIds.push(syntheticId);
    }

    return processedPacketIds;
  }

  /**
   * Track batch event (affects all packets in batch)
   */
  trackBatchEvent(
    batchId: string,
    stage: PacketStage,
    metadata?: Record<string, any>
  ): void {
    const packetIds = this.batchToPackets.get(batchId) || [];
    packetIds.forEach((packetId) => {
      this.track(packetId, stage, { batchId, ...metadata });
    });
  }

  /**
   * Format timestamp as [HH:MM:SS:mmm]
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    const millis = date.getMilliseconds().toString().padStart(3, "0");
    return `[${hours}:${minutes}:${seconds}:${millis}]`;
  }

  /**
   * Format timestamp as human-readable string (computed on demand)
   */
  formatHumanTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    const millis = date.getMilliseconds().toString().padStart(3, "0");
    return `${hours}:${minutes}:${seconds}:${millis}`;
  }

  /**
   * Format timestamp as ISO string (computed on demand)
   */
  formatISOTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  /**
   * Log event with formatted timestamp
   */
  private logEvent(event: PacketEvent): void {
    const timestamp = this.formatTimestamp(event.timestamp);
    const stageLabel = this.getStageLabel(event.stage);
    const batchInfo = event.batchId
      ? ` batch:${event.batchId.substring(0, 8)}`
      : "";
    const packetInfo = ` packet:${event.packetId.substring(0, 8)}`;

    //console.log(`${timestamp} ${stageLabel}${packetInfo}${batchInfo}`);
  }

  /**
   * Get human-readable stage label
   */
  private getStageLabel(stage: PacketStage): string {
    const labels: Record<PacketStage, string> = {
      [PacketStage.ARRIVED_FROM_TWILIO]: "📥 arrived from twilio",
      [PacketStage.BUFFERED]: "📦 buffered",
      [PacketStage.BATCH_CREATED]: "🔗 batch created",
      [PacketStage.QUEUED]: "⏳ queued",
      [PacketStage.SENT_TO_DEEPGRAM]: "📤 sent to deepgram",
      [PacketStage.STT_PROCESSED]: "✅ STT processed",
    };
    return labels[stage] || stage;
  }

  /**
   * Get all events for a packet
   */
  getPacketEvents(packetId: string): PacketEvent[] {
    return this.events.get(packetId) || [];
  }

  /**
   * Get all events for a packet with human-readable timestamps (computed on demand)
   */
  getPacketEventsWithHumanTimestamps(packetId: string): Array<
    PacketEvent & {
      timestampHuman: string;
      timestampISO: string;
    }
  > {
    const events = this.getPacketEvents(packetId);
    return events.map((event) => ({
      ...event,
      timestampHuman: this.formatHumanTimestamp(event.timestamp),
      timestampISO: this.formatISOTimestamp(event.timestamp),
    }));
  }

  /**
   * Get latency breakdown for a packet
   */
  getPacketLatency(packetId: string): {
    totalLatency?: number;
    stages: Array<{ stage: PacketStage; duration?: number; timestamp: number }>;
  } {
    const events = this.getPacketEvents(packetId);
    if (events.length === 0) {
      return { stages: [] };
    }

    const stages = events.map((event, index) => {
      const prevEvent = index > 0 ? events[index - 1] : null;
      const duration = prevEvent
        ? event.timestamp - prevEvent.timestamp
        : undefined;

      return {
        stage: event.stage,
        duration,
        timestamp: event.timestamp,
      };
    });

    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    if (!firstEvent || !lastEvent) {
      return { stages: [] };
    }
    const totalLatency = lastEvent.timestamp - firstEvent.timestamp;

    return {
      totalLatency,
      stages,
    };
  }

  /**
   * Get latency breakdown with human-readable timestamps (computed on demand)
   */
  getPacketLatencyWithHumanTimestamps(packetId: string): {
    totalLatency?: number;
    totalLatencyMs?: string;
    stages: Array<{
      stage: PacketStage;
      duration?: number;
      durationMs?: string;
      timestamp: number;
      timestampHuman: string;
      timestampISO: string;
    }>;
  } {
    const latency = this.getPacketLatency(packetId);
    if (latency.stages.length === 0) {
      return { stages: [] };
    }

    const stages = latency.stages.map((stage) => ({
      ...stage,
      durationMs: stage.duration ? `${stage.duration}ms` : undefined,
      timestampHuman: this.formatHumanTimestamp(stage.timestamp),
      timestampISO: this.formatISOTimestamp(stage.timestamp),
    }));

    return {
      totalLatency: latency.totalLatency,
      totalLatencyMs: latency.totalLatency
        ? `${latency.totalLatency}ms`
        : undefined,
      stages,
    };
  }

  /**
   * Get all tracked packet IDs
   */
  getAllPacketIds(): string[] {
    return Array.from(this.events.keys());
  }

  /**
   * Find packet IDs that match a partial ID (prefix match)
   */
  findPacketIds(partialId: string): string[] {
    const allIds = this.getAllPacketIds();
    return allIds.filter((id) => id.startsWith(partialId));
  }

  /**
   * Get recent packets (last N)
   */
  getRecentPackets(limit: number = 50): Array<{
    packetId: string;
    eventCount: number;
    firstEvent: PacketEvent;
    lastEvent: PacketEvent;
  }> {
    const allIds = this.getAllPacketIds();
    const recent = allIds.slice(-limit);

    return recent
      .map((packetId) => {
        const events = this.getPacketEvents(packetId);
        if (events.length === 0) return null;
        return {
          packetId,
          eventCount: events.length,
          firstEvent: events[0],
          lastEvent: events[events.length - 1],
        };
      })
      .filter(
        (
          p
        ): p is {
          packetId: string;
          eventCount: number;
          firstEvent: PacketEvent;
          lastEvent: PacketEvent;
        } => p !== null
      );
  }

  /**
   * Clear old events (keep last N packets)
   */
  clearOldEvents(keepLast: number = 1000): void {
    const packetIds = Array.from(this.events.keys());
    if (packetIds.length > keepLast) {
      const toRemove = packetIds.slice(0, packetIds.length - keepLast);
      toRemove.forEach((id) => {
        this.events.delete(id);
      });
    }
  }
}

// Global tracker instance
export const packetTracker = new PacketTracker();
