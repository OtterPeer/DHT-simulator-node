import { EventEmitter } from 'events';

export interface Node {
  id: string;
}

export interface RPCMessage {
  type: string;
  sender?: string;
  recipient?: string;
  message?: any;
}

export default class WebRTCRPC extends EventEmitter {
  constructor(options: { nodeId: string }) {
    super();
  }
  getId(): string { return ''; }
  async ping(node: Node): Promise<boolean> { return false; }
  async sendMessage(node: Node, sender: string, recipient: string, message: any): Promise<boolean> { return false; }
  destroy() {}
}
