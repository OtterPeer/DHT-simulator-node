import { EventEmitter } from "events";
import WebRTCRPC, { Node, RPCMessage } from "./webrtc-rpc";
import KBucket from "./kbucket";
import { CacheStrategy, DefaultCacheStrategy } from "./cache-strategy";
import { ForwardStrategy, DefaultForwardStrategy } from "./forward-strategy";

export interface DHTOptions {
  nodeId: string;
  bootstrapNodeId?: string;
  rpc: WebRTCRPC;
  k?: number;
  cacheStrategy?: CacheStrategy;
  forwardStrategy?: ForwardStrategy;
}

export interface QueuedMessage {
  sender: string;
  recipient: string;
  message: MessageDTO;
}

export interface MessageDTO {
  id: string;
  senderId: string;
  encryptedMessage: string;
  timestamp: number;
}

class DHT extends EventEmitter {
  public rpc: WebRTCRPC;
  private buckets: KBucket;
  private cacheStrategy: CacheStrategy;
  private forwardStrategy: ForwardStrategy;
  private k: number;
  private forwardedMessagesIds: Set<string>;
  private ttlCleanupInterval: NodeJS.Timeout | null;
  private readonly MAX_TTL = 48 * 3600 * 1000;
  private nodeId: string;

  constructor(opts: DHTOptions) {
    super();
    this.rpc = opts.rpc;
    this.buckets = new KBucket(opts.nodeId, opts.k);
    this.cacheStrategy = opts.cacheStrategy || new DefaultCacheStrategy();
    this.forwardStrategy = opts.forwardStrategy || new DefaultForwardStrategy();
    this.k = opts.k || 20;
    this.forwardedMessagesIds = new Set();
    this.ttlCleanupInterval = null;
    this.nodeId = opts.nodeId;

    this.rpc.on("ping", (node: Node) => {
      console.log(`recieved ping event from mock rpc, from node: ${node.id}`);
      this.addNode(node);
    });
    this.rpc.on("message", this.handleMessage.bind(this));
    this.rpc.on("listening", (node) => {
      console.log(`Node ${node.id} is listening`);
      this.addNode(node);
      this.tryToDeliverCachedMessagesToTarget();
    });
    this.rpc.on("warning", (err) => this.emit("warning", err));
    this.cacheStrategy.on("messageCached", () => this.emit("messageCached"))

    this.startTTLCleanup();

    if (opts.bootstrapNodeId) this.bootstrap({ id: opts.bootstrapNodeId });
  }

  public async addNode(node: Node): Promise<void> {
    const exists = this.buckets.all().some((n) => n.id === node.id);
    if (!exists) {
      console.log(`Adding new node: ${node.id}`);
      this.buckets.add(node);
      console.log(`Sending ping to node ${node.id}`);
      const alive = await this.rpc.ping(node);
      console.log(`Received pong: ${alive}`);
      if (alive) {
        this.emit("ready");
      }
    } else {
      console.log(`Node already exists: ${node.id}`);
    }
  }

  public async sendMessage(recipient: string, message: MessageDTO, sender?: string | null): Promise<void> {
    let originNode: boolean = false;
    if (!sender) {
      sender = this.rpc.getId();
      originNode = true;
    }
    console.log("Looking for target node in buckets.");

    const targetNodeInBuckets = this.findNodeInBuckets(recipient);
    if (targetNodeInBuckets) {
      this.emit("nodeProcessesMessage");
      const alive = await this.rpc.ping(targetNodeInBuckets);
      if (alive) {
        const success = await this.rpc.sendMessage(targetNodeInBuckets, sender, recipient, message);
        if (success) {
          this.emit("sent", { sender, recipient, content: message });
          this.emit("forward", { sender: this.nodeId, recipient: targetNodeInBuckets.id, message });
          console.log(`I'm node ${this.nodeId} forwarding the message to ${targetNodeInBuckets.id}`);
          this.forwardedMessagesIds.add(message.id);
        } else {
          this.cacheMessage(sender, recipient, message);
          this.forward(sender, recipient, message, originNode, true);
          this.forwardedMessagesIds.add(message.id);
        }
      } else {
        this.cacheMessage(sender, recipient, message);
        this.forward(sender, recipient, message, originNode, true);
        this.forwardedMessagesIds.add(message.id);
      }
    } else {
      console.log("Routing message through other peers");
      await this.forward(sender, recipient, message, originNode);
    }
  }

  private findNodeInBuckets(nodeId: string): Node | null {
    const closest = this.buckets.closest(nodeId, this.k);
    for (const node of closest) {
      if (node.id === nodeId) {
        return node;
      }
    }
    return null;
  }

  private async findAndPingNode(targetId: string): Promise<Node | null> {
    const closest = this.buckets.closest(targetId, this.k);
    for (const node of closest) {
      if (node.id === targetId) {
        const alive = await this.rpc.ping(node);
        if (alive) return node;
      }
    }
    console.log("Node not found in buckets or didn't respond to ping");
    return null;
  }

  private async forward(sender: string, recipient: string, message: MessageDTO, originNode: boolean = false, forceForwardingToKPeers: boolean = false): Promise<void> {
    try {
      await this.forwardStrategy.forward(
        sender,
        recipient,
        message,
        this.buckets,
        { sendMessage: this.rpc.sendMessage.bind(this.rpc) },
        this.k,
        this.nodeId,
        this.forwardedMessagesIds,
        originNode,
        forceForwardingToKPeers,
        this.emit.bind(this)
      );
    } catch (error) {
      this.cacheMessage(sender, recipient, message);
    }
  }

  private handleMessage(rpcMessage: RPCMessage, from: Node): void {
    console.log(`I'm node ${this.rpc.getId()} Handling message: ${rpcMessage.type}. From: ${from.id}`);
    if (rpcMessage.type === 'message') {
      this.emit('messageReceived');
      const { sender, recipient, message } = rpcMessage;
      if (!sender || !recipient || !message || !message.id) {
        console.warn("Invalid message; dropping.");
        return;
      }

      this.addNode(from);

      if (recipient === this.rpc.getId()) {
        console.log("Received chat message for self:", message);
        this.emit("chatMessage", message);
      } else {
        this.sendMessage(recipient, message, sender);
      }
    }
  }

  private async tryToDeliverCachedMessagesToTarget(): Promise<void> {
    await this.cacheStrategy.tryToDeliverCachedMessages(
      (targetId: string) => this.findAndPingNode(targetId),
      (node: Node, sender: string, recipient: string, message: MessageDTO) => this.rpc.sendMessage(node, sender, recipient, message),
      this.MAX_TTL
    );
    this.emit("delivered");
  }

  private startTTLCleanup(): void {
    this.ttlCleanupInterval = setInterval(() => {
      this.cacheStrategy.tryToDeliverCachedMessages(
        (targetId: string) => this.findAndPingNode(targetId),
        (node: Node, sender: string, recipient: string, message: MessageDTO) => this.rpc.sendMessage(node, sender, recipient, message),
        this.MAX_TTL
      ).then(() => {
        console.log(`Cleaned up expired messages; ${this.cacheStrategy.getCachedMessageCount()} remain`);
      });
    }, 5 * 60 * 1000);
  }

  private stopTTLCleanup(): void {
    if (this.ttlCleanupInterval) {
      clearInterval(this.ttlCleanupInterval);
      this.ttlCleanupInterval = null;
    }
  }

  private cacheMessage(sender: string, recipient: string, message: MessageDTO, recipienFoundInBuckets: boolean = true): void {
    this.cacheStrategy.cacheMessage(sender, recipient, message, this.nodeId, recipienFoundInBuckets);
    this.emit("cache", { sender, recipient, message });
  }

  private async bootstrap(bootstrapNode: Node): Promise<void> {
    console.log("Adding bootstrap node...");
    this.addNode(bootstrapNode);
    const alive = await this.rpc.ping(bootstrapNode);
    if (alive) this.emit("ready");
  }

  public destroy(): void {
    this.stopTTLCleanup();
    this.rpc.destroy();
    this.cacheStrategy.clear();
    this.forwardedMessagesIds.clear();
    this.emit("close");
  }

  public getCachedMessageCount(): number {
    return this.cacheStrategy.getCachedMessageCount();
  }
}

export default DHT;