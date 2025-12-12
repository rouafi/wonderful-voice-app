// Generic queue interface - can be swapped with cloud service later
export interface Queue<T> {
  enqueue(item: T): Promise<void>;
  dequeue(): Promise<T | null>;
  size(): Promise<number>;
  isEmpty(): Promise<boolean>;
  clear(): Promise<void>;
}

// In-memory queue implementation
export class InMemoryQueue<T> implements Queue<T> {
  private items: T[] = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  async enqueue(item: T): Promise<void> {
    if (this.items.length >= this.maxSize) {
      throw new Error(`Queue is full (max size: ${this.maxSize})`);
    }
    this.items.push(item);
  }

  async dequeue(): Promise<T | null> {
    return this.items.shift() || null;
  }

  async size(): Promise<number> {
    return this.items.length;
  }

  async isEmpty(): Promise<boolean> {
    return this.items.length === 0;
  }

  async clear(): Promise<void> {
    this.items = [];
  }
}

