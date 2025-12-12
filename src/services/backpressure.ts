import { Queue, InMemoryQueue } from "./queue.js";
import { packetTracker, PacketStage } from "./packetTracker.js";
import { randomUUID } from "crypto";

export interface BackpressureOptions {
  maxQueueSize?: number;
  processInterval?: number; // ms between queue processing attempts
  onQueueFull?: () => void; // Callback when queue is full
  onItemDropped?: () => void; // Callback when item is dropped due to backpressure
}

export interface BatchingBackpressureOptions extends BackpressureOptions {
  batchSize?: number; // Number of items to batch together
  batchTimeout?: number; // Max time (ms) to wait before sending partial batch
}

interface QueuedItem<T> {
  item: T;
  batchId?: string;
}

export class BackpressureService<T> {
  private queue: Queue<QueuedItem<T>>;
  private isProcessing: boolean = false;
  private processInterval: number;
  private onQueueFull?: () => void;
  private onItemDropped?: () => void;
  private canSend: () => boolean;
  private sendItem: (item: T) => Promise<void>;
  private processTimer?: NodeJS.Timeout;

  constructor(
    canSend: () => boolean,
    sendItem: (item: T) => Promise<void>,
    options: BackpressureOptions = {}
  ) {
    this.canSend = canSend;
    this.sendItem = sendItem;
    this.processInterval = options.processInterval || 100; // Default 100ms
    this.onQueueFull = options.onQueueFull;
    this.onItemDropped = options.onItemDropped;

    // Use in-memory queue by default, can be swapped later
    const maxSize = options.maxQueueSize || 1000;
    this.queue = new InMemoryQueue<QueuedItem<T>>(maxSize);

    // Start processing queue
    this.startProcessing();
  }

  /**
   * Add item to queue or send immediately if possible
   */
  async add(item: T, batchId?: string): Promise<void> {
    // Try to send immediately if possible
    if (this.canSend()) {
      try {
        const sendTimestamp = Date.now();
        if (batchId) {
          packetTracker.trackBatchEvent(batchId, PacketStage.SENT_TO_DEEPGRAM);
          // Track batch sent for STT correlation
          packetTracker.trackBatchSent(batchId, sendTimestamp);
        }
        await this.sendItem(item);
        return;
      } catch (error) {
        // If send fails, queue it
        console.warn("⚠️ Send failed, queuing item:", error);
      }
    }

    // Queue the item
    try {
      if (batchId) {
        packetTracker.trackBatchEvent(batchId, PacketStage.QUEUED);
      }
      await this.queue.enqueue({ item, batchId });
    } catch (error) {
      // Queue is full
      if (this.onQueueFull) {
        this.onQueueFull();
      }
      if (this.onItemDropped) {
        this.onItemDropped();
      }
      throw new Error("Queue is full, item dropped");
    }
  }

  /**
   * Process queue - send items when ready
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (!(await this.queue.isEmpty()) && this.canSend()) {
        const queuedItem = await this.queue.dequeue();
        if (queuedItem) {
          try {
            if (queuedItem.batchId) {
              packetTracker.trackBatchEvent(
                queuedItem.batchId,
                PacketStage.SENT_TO_DEEPGRAM
              );
            }
            await this.sendItem(queuedItem.item);
          } catch (error) {
            // If send fails, put item back at front of queue
            console.error("❌ Error sending queued item:", error);
            // Note: InMemoryQueue doesn't have unshift, so we'd need to re-enqueue
            // For now, we'll drop it on error (could be improved)
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Start periodic queue processing
   */
  private startProcessing(): void {
    this.processTimer = setInterval(() => {
      this.processQueue().catch((error) => {
        console.error("❌ Error processing queue:", error);
      });
    }, this.processInterval);
  }

  /**
   * Stop processing and flush remaining items
   */
  async flush(): Promise<void> {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = undefined;
    }

    // Process remaining items
    await this.processQueue();
  }

  /**
   * Get current queue size
   */
  async getQueueSize(): Promise<number> {
    return this.queue.size();
  }

  /**
   * Clear queue
   */
  async clear(): Promise<void> {
    await this.queue.clear();
  }

  /**
   * Replace queue implementation (for swapping to cloud service)
   */
  setQueue(queue: Queue<QueuedItem<T>>): void {
    this.queue = queue;
  }
}

/**
 * Backpressure service with built-in batching
 * Accepts individual items, batches them, and handles queuing
 */
export class BatchingBackpressureService<T> {
  private backpressureService: BackpressureService<T>;
  private batchBuffer: T[] = [];
  private batchPacketIds: string[] = []; // Track packet IDs in current batch
  private batchSize: number;
  private batchTimeout: number;
  private batchTimer?: NodeJS.Timeout;
  private flushBatch: () => Promise<void>;

  constructor(
    canSend: () => boolean,
    sendItem: (item: T) => Promise<void>,
    options: BatchingBackpressureOptions = {}
  ) {
    this.batchSize = options.batchSize || 5;
    this.batchTimeout = options.batchTimeout || 100; // Default 100ms timeout

    // Create internal backpressure service that handles batched items
    this.backpressureService = new BackpressureService<T>(
      canSend,
      // sendItem receives a batched item (which is T, but for Buffer it's a concatenated buffer)
      sendItem,
      {
        maxQueueSize: options.maxQueueSize || 500,
        processInterval: options.processInterval || 50,
        onQueueFull: options.onQueueFull,
        onItemDropped: options.onItemDropped,
      }
    );

    // Flush batch function
    this.flushBatch = async () => {
      if (this.batchBuffer.length === 0) return;

      const batchId = randomUUID();
      const batched = this.combineBatch(this.batchBuffer);
      const packetIds = [...this.batchPacketIds];

      // Track batch creation
      packetTracker.trackBatch(batchId, packetIds);

      this.batchBuffer = [];
      this.batchPacketIds = [];

      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
      }

      await this.backpressureService.add(batched, batchId);
    };

    // Start batch timeout timer
    this.startBatchTimer();
  }

  /**
   * Combine batch items into a single item
   * For Buffer, concatenate them. Override for other types.
   */
  protected combineBatch(items: T[]): T {
    // Default implementation assumes T is Buffer
    return Buffer.concat(items as Buffer[]) as T;
  }

  /**
   * Add individual item - will be batched automatically
   */
  async add(item: T, packetId?: string): Promise<string> {
    const id = packetId || randomUUID();

    // Track buffering
    packetTracker.track(id, PacketStage.BUFFERED);

    this.batchBuffer.push(item);
    this.batchPacketIds.push(id);

    // If batch is full, flush immediately
    if (this.batchBuffer.length >= this.batchSize) {
      await this.flushBatch();
    } else {
      // Restart timer for partial batch
      this.startBatchTimer();
    }

    return id;
  }

  /**
   * Start batch timeout timer
   */
  private startBatchTimer(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.flushBatch().catch((error) => {
        console.error("❌ Error flushing batch on timeout:", error);
      });
    }, this.batchTimeout);
  }

  /**
   * Flush all remaining items (batched and queued)
   */
  async flush(): Promise<void> {
    // Flush current batch first
    await this.flushBatch();
    // Then flush backpressure queue
    await this.backpressureService.flush();
  }

  /**
   * Get current queue size (batched + queued)
   */
  async getQueueSize(): Promise<number> {
    const backpressureSize = await this.backpressureService.getQueueSize();
    return backpressureSize + this.batchBuffer.length;
  }

  /**
   * Clear all buffers and queues
   */
  async clear(): Promise<void> {
    this.batchBuffer = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    await this.backpressureService.clear();
  }

  /**
   * Replace queue implementation (for swapping to cloud service)
   */
  setQueue(queue: Queue<{ item: T; batchId?: string }>): void {
    this.backpressureService.setQueue(queue);
  }
}
