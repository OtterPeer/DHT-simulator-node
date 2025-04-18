import { EventEmitter } from 'events';
import { Simulator } from './simulator';
import WebRTCRPC from './webrtc-rpc';
import { MessageDTO } from './dht';

interface Node {
  id: string;
}

export class MockWebRTCRPC extends EventEmitter implements WebRTCRPC {
  private nodes: { id: string; dht: any; online: boolean }[];
  private simulator: Simulator;
  private nodeId: string;

  constructor(nodes: { id: string; dht: any; online: boolean }[], simulator: Simulator, nodeId: string) {
    super();
    this.nodes = nodes;
    this.simulator = simulator;
    this.nodeId = nodeId;
  }

  setNodeId(id: string) {
    this.nodeId = id;
  }

  getId(): string {
    return this.nodeId;
  }

  async ping(node: Node): Promise<boolean> {
    console.log("I'm node " + this.getId() + " Sening ping to: " + node.id)
    this.simulator.getNodesDHT(node.id)!.rpc.emit("ping", {id: this.getId()})
    return this.simulator.isNodeOnline(node.id);
  }

  async sendMessage(node: Node, sender: string, recipient: string, message: MessageDTO): Promise<boolean> {
    if (!this.simulator.isNodeOnline(node.id)) {
      console.log(`Node ${node.id} is offline; message not sent`);
      return false;
    }

    const targetNode = this.nodes.find(n => n.id === node.id);
    if (!targetNode) {
      console.log(`Node ${node.id} not found`);
      return false;
    }

    const rpcMessage = { type: 'message', sender, recipient, message };
    this.simulator.getNodesDHT(recipient)!.rpc.emit('message', rpcMessage, {id: sender})

    return true;
  }

  destroy() {
  }
}