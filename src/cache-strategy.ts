import { EventEmitter } from 'stream';
import { QueuedMessage, MessageDTO } from './dht';
import { Node } from './webrtc-rpc';
import KBucket from './kbucket';

export interface CacheStrategy extends EventEmitter {
  cacheMessage(sender: string, recipient: string, message: MessageDTO, nodeId: string, recipienFoundInBuckets: boolean): void;
  tryToDeliverCachedMessages(
    findAndPingNode: (targetId: string) => Promise<Node | null>,
    sendMessage: (node: Node, sender: string, recipient: string, message: MessageDTO) => Promise<boolean>,
    maxTTL: number
  ): Promise<void>;
  getCachedMessageCount(): number;
  clear(): void;
}

export class DefaultCacheStrategy extends EventEmitter implements CacheStrategy {
  private cachedMessages: Map<string, QueuedMessage>;

  constructor() {
    super();
    this.cachedMessages = new Map();
  }

  cacheMessage(sender: string, recipient: string, message: MessageDTO, nodeId: string, recipienFoundInBuckets: boolean): void {
    if (!message.id || this.cachedMessages.has(message.id)) {
      console.log(`Message ${message.id} already cached or no ID; skipping`);
      return;
    }
    if (!recipienFoundInBuckets) {
      console.log("Reciepient is not in my buckets - not caching (DefaultCacheStrategy)")
    }
    const queued: QueuedMessage = {
      sender,
      recipient,
      message,
    };
    this.cachedMessages.set(message.id, queued);
    this.emit('messageCached');
    console.log(`Cached message ${message.id} for ${recipient}`);
  }

  async tryToDeliverCachedMessages(
    findAndPingNode: (targetId: string) => Promise<Node | null>,
    sendMessage: (node: Node, sender: string, recipient: string, message: MessageDTO) => Promise<boolean>,
    maxTTL: number
  ): Promise<void> {
    console.log("Trying to deliver cached messages");
    const now = Date.now();
    for (const [messageId, msg] of this.cachedMessages) {
      if (now - msg.message.timestamp > maxTTL) {
        console.log(`Message ${messageId} expired; removing`);
        this.cachedMessages.delete(messageId);
        continue;
      }

      const targetNode = await findAndPingNode(msg.recipient);
      try {
        if (targetNode) {
          const success = await sendMessage(targetNode, msg.sender, msg.recipient, msg.message);
          if (success) {
            console.log(`Delivered cached message ${messageId} to ${msg.recipient}`);
            this.cachedMessages.delete(messageId);
          }
        } else {
          console.log(`Recipient ${msg.recipient} offline; keeping message ${messageId} in cache`);
        }
      } catch (error) {
        console.error(`Error delivering cached message ${messageId}:`, error);
      }
    }
  }

  getCachedMessageCount(): number {
    return this.cachedMessages.size;
  }

  clear(): void {
    this.cachedMessages.clear();
  }
}

export class LRUCacheStrategy extends EventEmitter implements CacheStrategy {
  private cachedMessages: Map<string, QueuedMessage>;
  private accessOrder: string[];
  private maxSize: number;

  constructor(maxSize: number = 100) {
    super();
    this.cachedMessages = new Map();
    this.accessOrder = [];
    this.maxSize = maxSize;
  }

  cacheMessage(sender: string, recipient: string, message: MessageDTO, nodeId: string, recipienFoundInBuckets: boolean): void {
    if (!message.id || this.cachedMessages.has(message.id)) {
      console.log(`Message ${message.id} already cached or no ID; skipping`);
      return;
    }

    if (this.cachedMessages.size >= this.maxSize) {
      const oldestId = this.accessOrder.shift();
      if (oldestId) {
        this.cachedMessages.delete(oldestId);
        console.log(`Evicted oldest message ${oldestId} due to cache size limit`);
      }
    }

    const queued: QueuedMessage = {
      sender,
      recipient,
      message,
    };
    this.cachedMessages.set(message.id, queued);
    this.accessOrder.push(message.id);
    console.log(`Cached message ${message.id} for ${recipient}`);
  }

  async tryToDeliverCachedMessages(
    findAndPingNode: (targetId: string) => Promise<Node | null>,
    sendMessage: (node: Node, sender: string, recipient: string, message: MessageDTO) => Promise<boolean>,
    maxTTL: number
  ): Promise<void> {
    console.log("Trying to deliver cached messages (LRU)");
    const now = Date.now();
    for (const [messageId, msg] of this.cachedMessages) {
      if (now - msg.message.timestamp > maxTTL) {
        console.log(`Message ${messageId} expired; removing`);
        this.cachedMessages.delete(messageId);
        this.accessOrder = this.accessOrder.filter(id => id !== messageId);
        continue;
      }

      const targetNode = await findAndPingNode(msg.recipient);
      try {
        if (targetNode) {
          const success = await sendMessage(targetNode, msg.sender, msg.recipient, msg.message);
          if (success) {
            console.log(`Delivered cached message ${messageId} to ${msg.recipient}`);
            this.cachedMessages.delete(messageId);
            this.accessOrder = this.accessOrder.filter(id => id !== messageId);
          } else {
            this.accessOrder = this.accessOrder.filter(id => id !== messageId);
            this.accessOrder.push(messageId);
          }
        } else {
          console.log(`Recipient ${msg.recipient} offline; keeping message ${messageId} in cache`);
          this.accessOrder = this.accessOrder.filter(id => id !== messageId);
          this.accessOrder.push(messageId);
        }
      } catch (error) {
        console.error(`Error delivering cached message ${messageId}:`, error);
      }
    }
  }

  getCachedMessageCount(): number {
    return this.cachedMessages.size;
  }

  clear(): void {
    this.cachedMessages.clear();
    this.accessOrder = [];
  }
}

export class DistanceBasedCacheStrategy extends EventEmitter implements CacheStrategy {
  private cachedMessages: Map<string, QueuedMessage>;
  private accessOrder: string[];
  private maxSize: number;
  private distanceThreshold: number;

  constructor(maxSize: number = 100, distanceThreshhold: number = 2 ** 42) {
    super();
    this.cachedMessages = new Map();
    this.accessOrder = [];
    this.maxSize = maxSize;
    this.distanceThreshold = distanceThreshhold;
  }

  cacheMessage(sender: string, recipient: string, message: MessageDTO, nodeId: string, recipienFoundInBuckets: boolean): void {
    if (!message.id || this.cachedMessages.has(message.id)) {
      console.log(`Message ${message.id} already cached or no ID; skipping`);
      return;
    }

    const distanceHex = KBucket.xorDistance(nodeId, recipient);

    const distanceHexShort = distanceHex.substring(0, 12);
    const distance = parseInt(distanceHexShort, 16) || 0;

    console.log(`Distance (48 most significant bits): ${distance}`);

    if (distance > this.distanceThreshold) {
      console.log(`Message ${message.id} already cached or no ID; skipping`);
      return;
    }

    if (this.cachedMessages.size >= this.maxSize) {
      const oldestId = this.accessOrder.shift();
      if (oldestId) {
        this.cachedMessages.delete(oldestId);
        console.log(`Evicted oldest message ${oldestId} due to cache size limit`);
      }
    }

    const queued: QueuedMessage = {
      sender,
      recipient,
      message,
    };
    this.cachedMessages.set(message.id, queued);
    this.accessOrder.push(message.id);
    console.log(`Cached message ${message.id} for ${recipient}`);
  }

  async tryToDeliverCachedMessages(
    findAndPingNode: (targetId: string) => Promise<Node | null>,
    sendMessage: (node: Node, sender: string, recipient: string, message: MessageDTO) => Promise<boolean>,
    maxTTL: number
  ): Promise<void> {
    console.log("Trying to deliver cached messages (LRU)");
    const now = Date.now();
    for (const [messageId, msg] of this.cachedMessages) {
      if (now - msg.message.timestamp > maxTTL) {
        console.log(`Message ${messageId} expired; removing`);
        this.cachedMessages.delete(messageId);
        this.accessOrder = this.accessOrder.filter(id => id !== messageId);
        continue;
      }

      const targetNode = await findAndPingNode(msg.recipient);
      try {
        if (targetNode) {
          const success = await sendMessage(targetNode, msg.sender, msg.recipient, msg.message);
          if (success) {
            console.log(`Delivered cached message ${messageId} to ${msg.recipient}`);
            this.cachedMessages.delete(messageId);
            this.accessOrder = this.accessOrder.filter(id => id !== messageId);
          } else {
            this.accessOrder = this.accessOrder.filter(id => id !== messageId);
            this.accessOrder.push(messageId);
          }
        } else {
          console.log(`Recipient ${msg.recipient} offline; keeping message ${messageId} in cache`);
          this.accessOrder = this.accessOrder.filter(id => id !== messageId);
          this.accessOrder.push(messageId);
        }
      } catch (error) {
        console.error(`Error delivering cached message ${messageId}:`, error);
      }
    }
  }

  getCachedMessageCount(): number {
    return this.cachedMessages.size;
  }

  clear(): void {
    this.cachedMessages.clear();
    this.accessOrder = [];
  }
}