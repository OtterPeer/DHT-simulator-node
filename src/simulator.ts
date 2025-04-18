import DHT, { DHTOptions } from './dht';
import { MockWebRTCRPC } from './mock-webrtc';
import { v4 as uuid } from 'uuid';
import { MessageDTO } from './dht';
import { generateVisualizer } from './visualizer';

interface SimulatorConfig {
  numNodes: number;
  onlineProbability: number;
  k: number;
  forwardThreshold: number;
}

export class Simulator {
  private config: SimulatorConfig;
  public nodes: { id: string; dht: DHT; online: boolean }[];
  private messagesSent: number;
  private messagesDelivered: number;
  private nodesProcessingMessage: number;
  private messagePath: { from: string; to: string }[];
  private messagesReceived: number;

  constructor(config: Partial<SimulatorConfig> = {}) {
    this.config = {
      numNodes: config.numNodes || 50,
      onlineProbability: config.onlineProbability || 0.2,
      k: config.k || 20,
      forwardThreshold: config.forwardThreshold || 1 << 20,
    };
    this.nodes = [];
    this.messagesSent = 0;
    this.messagesDelivered = 0;
    this.nodesProcessingMessage = 0;
    this.messagesReceived = 0;
    this.messagePath = [];
  }

  async initialize(): Promise<void> {
    for (let i = 0; i < this.config.numNodes; i++) {
      const id = uuid().replace(/-/g, '');
      const online = true;
      const mockRpc = new MockWebRTCRPC(this.nodes, this, id);
      const dht = new DHT({
        nodeId: id,
        k: this.config.k,
        rpc: mockRpc
      });
      this.nodes.push({ id, dht, online });
    }

    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].online) {
        for (let j = 0; j < this.nodes.length; j++) {
          if (Math.random() < 0.3 && this.nodes[i].id !== this.nodes[j].id) { // each node has seen about ~30% of a network
            this.nodes[i].dht.addNode({id: this.nodes[j].id})
          }
        }
      }
    }

    for (const node of this.nodes) {
      node.online = Math.random() < this.config.onlineProbability;
      node.dht.on('sent', () => this.messagesSent++);
      node.dht.on('chatMessage', () => {
        this.messagesDelivered++;
      });
      node.dht.on('nodeProcessesMessage', () => this.nodesProcessingMessage++)
      node.dht.on('forward', ({ sender, recipient }) => {
        this.messagePath.push({ from: sender, to: recipient });
      });
      node.dht.on('messageReceived', () => this.messagesReceived++)
    }
  }

  async sendMessage(fromId: string, toId: string, messageText: string): Promise<void> {
    const sourceNode = this.nodes.find(n => n.id === fromId);
    const targetNode = this.nodes.find(n => n.id === toId);
    if (!sourceNode || !sourceNode.online) {
      console.log(`Source node ${fromId} is offline or not found`);
      return;
    }
    if (!targetNode) {
      console.log(`Target node ${toId} not found`);
      return;
    }

    const message: MessageDTO = {
      id: uuid(),
      encryptedMessage: messageText,
      timestamp: Date.now(),
      senderId: fromId
    };

    console.log(`Sending message from ${fromId} to ${toId}: ${messageText}`);
    await sourceNode.dht.sendMessage(toId, message);
  }

  getStatistics(): { messagesSent: number; messagesDelivered: number; successRate: number, nodesProcessingMessage: number,
    messagesReceived: number
   } {
    const successRate = this.messagesSent > 0 ? this.messagesDelivered / this.messagesSent : 0;
    return {
      messagesSent: this.messagesSent,
      messagesDelivered: this.messagesDelivered,
      successRate,
      nodesProcessingMessage: this.nodesProcessingMessage,
      messagesReceived: this.messagesReceived,
    };
  }

  generateVisualization(senderId?: string, recipientId?: string): void {
    const nodes = this.nodes.map(node => ({
      id: node.id,
      label: node.online ? `${node.id.slice(0, 8)} (online)` : `${node.id.slice(0, 8)} (offline)`,
      color: node.online ? '#90EE90' : '#FF6347',
      // color: node.dht.cachedMessages.size > 0 ? '#FFFF00' : (node.online ? '#90EE90' : '#FF6347'),
    }));

    const edges = this.messagePath.map(path => ({
      from: path.from,
      to: path.to,
      color: '#0000FF',
    }));

    generateVisualizer(nodes, edges, './output/network.html', senderId, recipientId);
  }


  isNodeOnline(nodeId: string): boolean {
    const node = this.nodes.find(n => n.id === nodeId);
    return node ? node.online : false;
  }

  getNodesDHT(nodeId: string): DHT | null {
    const dht = this.nodes.find(n => n.id === nodeId)?.dht
    if (!dht) return null;
    return dht
  }
}

async function runSimulation() {
  const simulator = new Simulator({
    numNodes: 500,
    onlineProbability: 0.2,
    k: 20,
    forwardThreshold: 1 << 20,
  });

  await simulator.initialize();

  const onlineNodes = simulator.nodes.filter(n => n.online);
  if (onlineNodes.length < 2) {
    console.log('Not enough online nodes to send a message');
    return;
  }

  const fromId = onlineNodes[14].id;
  const toId = onlineNodes[70].id;
  await simulator.sendMessage(fromId, toId, 'Hello, Kademlia!');

  function summarize() {
    const stats = simulator.getStatistics();
    console.log('Simulation Statistics:');
    console.log(`Messages Sent: ${stats.messagesSent}`);
    console.log(`Messages received ${stats.messagesSent}`);
    console.log(`Nodes that saw the message ${stats.nodesProcessingMessage}`);
    console.log(`Messages received ${stats.messagesSent}`);
    console.log(`Nodes that cached the message`);
    console.log(`Messages Delivered: ${stats.messagesDelivered}`);
    console.log(`Success Rate: ${(stats.successRate * 100).toFixed(2)}%`);


    simulator.generateVisualization(fromId, toId);
    console.log('Visualization generated at ./output/network.html');
  }

  setTimeout(summarize, 5000);
  // summarize();
}

runSimulation().catch(console.error);