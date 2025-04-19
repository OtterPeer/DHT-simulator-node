import DHT, { DHTOptions } from './dht';
import { MockWebRTCRPC } from './mock-webrtc';
import { v4 as uuid } from 'uuid';
import { MessageDTO } from './dht';
import { generateVisualizer } from './visualizer';
import { DefaultForwardStrategy, DistanceBasedForwardStrategy, ForwardStrategy, ProbabilisticForwardStrategy } from './forward-strategy';
import * as yargs from 'yargs';
import { CacheStrategy, DefaultCacheStrategy, LRUCacheStrategy } from './cache-strategy';
import * as fs from 'fs/promises';

interface SimulatorConfig {
  numNodes: number;
  onlineProbability: number;
  k: number;
  referenceDistance: number;
  cacheStrategy: CacheStrategy;
  forwardStrategy: ForwardStrategy;
  networkAwareness: number;
  outputFile?: string;
}

export class Simulator {
  private config: SimulatorConfig;
  public nodes: { id: string; dht: DHT; online: boolean }[];
  private messagesSent: number;
  private messagesDelivered: number;
  private nodesProcessingMessage: number;
  private messagePath: { from: string; to: string }[];
  private messagesReceived: number;
  private messagesCached: number;
  private lastEventTimestamp: number;
  private checkInterval: NodeJS.Timeout | null;
  private resolveScenario: (() => void) | null;
  private scenarioPromise: Promise<void>;

  constructor(config: Partial<SimulatorConfig> = {}) {
    this.config = {
      numNodes: config.numNodes || 50,
      onlineProbability: config.onlineProbability || 0.2,
      k: config.k || 20,
      referenceDistance: config.referenceDistance || 2 ** 42,
      forwardStrategy: config.forwardStrategy || new DefaultForwardStrategy(),
      cacheStrategy: config.cacheStrategy || new DefaultCacheStrategy(),
      networkAwareness: config.networkAwareness || 0.1,
    };
    this.nodes = [];
    this.messagesSent = 0;
    this.messagesDelivered = 0;
    this.nodesProcessingMessage = 0;
    this.messagesReceived = 0;
    this.messagePath = [];
    this.messagesCached = 0;
    this.resolveScenario = null;
    this.scenarioPromise = new Promise((resolve) => {
      this.resolveScenario = resolve;
    })
    this.lastEventTimestamp = Date.now();
    this.checkInterval = null;
  }

  async initialize(): Promise<void> {
    for (let i = 0; i < this.config.numNodes; i++) {
      const id = uuid().replace(/-/g, '');
      const online = true;
      const mockRpc = new MockWebRTCRPC(this.nodes, this, id);
      const dht = new DHT({
        nodeId: id,
        k: this.config.k,
        rpc: mockRpc,
        forwardStrategy: this.config.forwardStrategy,
      });
      this.nodes.push({ id, dht, online });
    }

    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].online) {
        for (let j = 0; j < this.nodes.length; j++) {
          if (i !== j && Math.random() < this.config.networkAwareness) { // each node has seen about ~10% of a network
            this.nodes[i].dht.addNode({id: this.nodes[j].id})
          }
        }
      }
    }

    const updateTimestamp = () => {
      this.lastEventTimestamp = Date.now();
    };

    for (const node of this.nodes) {
      node.online = Math.random() < this.config.onlineProbability;
      node.dht.on('sent', () => {
        this.messagesSent++
        updateTimestamp()
      });
      node.dht.on('chatMessage', () => {
        this.messagesDelivered++;
      });
      node.dht.on('nodeProcessesMessage', () => this.nodesProcessingMessage++)
      node.dht.on('forward', ({ sender, recipient }) => {
        this.messagePath.push({ from: sender, to: recipient });
      });
      node.dht.on('messageReceived', () => this.messagesReceived++)
      node.dht.on('messageCached', () => this.messagesCached++)
    }

    this.checkInterval = setInterval(() => this.checkScenarioComplete(), 1000);
  }


  private checkScenarioComplete(): void {
    if (Date.now() - this.lastEventTimestamp > 1000 && this.resolveScenario) {
      console.log('No DHT events for 1 second; scenario complete');
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
      this.resolveScenario();
      this.resolveScenario = null;
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
    messagesReceived: number, messagesCached: number
   } {
    const successRate = this.messagesSent > 0 ? this.messagesDelivered / this.messagesSent : 0;
    return {
      messagesSent: this.messagesSent,
      messagesDelivered: this.messagesDelivered,
      successRate,
      nodesProcessingMessage: this.nodesProcessingMessage,
      messagesReceived: this.messagesReceived,
      messagesCached: this.messagesCached
    };
  }

  generateVisualization(senderId?: string, recipientId?: string): void {
    const nodes = this.nodes.map(node => ({
      id: node.id,
      label: node.online ? `${node.id.slice(0, 8)} (online)` : `${node.id.slice(0, 8)} (offline)`,
      color: node.dht.getCachedMessageCount() > 0 ? '#FFFF00' : (node.online ? '#90EE90' : '#FF6347'),
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

  async waitForScenarioComplete(timeoutMs: number = 10000): Promise<void> {
    try {
      await Promise.race([
        this.scenarioPromise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Scenario timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      console.log('Scenario completed successfully');
    } catch (error) {
      console.error('waitForScenarioComplete error:', error);
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
      throw error;
    }
  }
}

function createForwardStrategy(name: string, referenceDistance: number): ForwardStrategy {
  switch (name.toLowerCase()) {
    case 'default':
      return new DefaultForwardStrategy();
    case 'probabilistic':
      return new ProbabilisticForwardStrategy(referenceDistance);
    case 'deterministic':
      return new DistanceBasedForwardStrategy();
    default:
      throw new Error(`Unknown forward strategy: ${name}. Valid options: default, distance, random, probabilistic`);
  }
}

function createCacheStrategy(name: string): CacheStrategy {
  switch (name.toLowerCase()) {
    case 'default':
      return new DefaultCacheStrategy();
    case 'lru':
      return new LRUCacheStrategy(100);
    default:
      throw new Error(`Unknown cache strategy: ${name}. Valid options: default, lru`);
  }
}

async function runSimulation(params: {
  numNodes: number,
  onlineProbability: number,
  k: number,
  networkAwareness: number;
  referenceDistance: number,
  forwardStrategy: string,
  cacheStrategy: string,
  outputFile?: string
}) {
  const config: SimulatorConfig = {
    numNodes: params.numNodes,
    onlineProbability: params.onlineProbability,
    k: params.k,
    networkAwareness: params.networkAwareness,
    referenceDistance: params.referenceDistance,
    cacheStrategy: createCacheStrategy(params.cacheStrategy),
    forwardStrategy: createForwardStrategy(params.forwardStrategy, params.referenceDistance),
    outputFile: params.outputFile,
  };

  console.log(`Running simulation with: numNodes=${config.numNodes}, onlineProbability=${config.onlineProbability}, k=${config.k}, referenceDistance=${config.referenceDistance}, forwardStrategy=${params.forwardStrategy}, cacheStrategy=${params.cacheStrategy}`);

  const simulator = new Simulator(config);
  await simulator.initialize();

  const onlineNodes = simulator.nodes.filter(n => n.online);

  const offlineNodes = simulator.nodes.filter(n => !n.online);

  const fromId = onlineNodes[Math.floor(Math.random() * (onlineNodes.length - 1))].id;
  const toId = offlineNodes[Math.floor(Math.random() * (offlineNodes.length - 1))].id;
  await simulator.sendMessage(fromId, toId, 'Hello, Kademlia!');
  await simulator.sendMessage(fromId, toId, 'Second message!');

  await simulator.waitForScenarioComplete();

  const stats = simulator.getStatistics();
  console.log(`Simulation Statistics:`);
  console.log(`Messages Sent: ${stats.messagesSent}`);
  console.log(`Messages Received: ${stats.messagesReceived}`);
  console.log(`Nodes that saw the message: ${stats.nodesProcessingMessage}`);
  console.log(`Messages Delivered: ${stats.messagesDelivered}`);
  console.log(`Cached Messages: ${stats.messagesCached}`);
  console.log(`Success Rate: ${(stats.successRate * 100).toFixed(2)}%`);

  simulator.generateVisualization(fromId, toId);
  console.log(`Visualization generated at ./output/network_${params.forwardStrategy}_${params.cacheStrategy}.html`);

  // Prepare result object
  const result = {
    params: {
      numNodes: config.numNodes,
      onlineProbability: config.onlineProbability,
      k: config.k,
      referenceDistance: config.referenceDistance,
      forwardStrategy: params.forwardStrategy,
      cacheStrategy: params.cacheStrategy,
    },
    stats,
    timestamp: new Date().toISOString(),
  };

  // Write results to output file if specified
  if (config.outputFile) {
    await fs.writeFile(config.outputFile, JSON.stringify(result, null, 2));
    console.log(`Results written to ${config.outputFile}`);
  }

  return result;
}

const argv = yargs
  .option('numNodes', {
    type: 'number',
    description: 'Number of nodes in the simulation',
    default: 500,
  })
  .option('onlineProbability', {
    type: 'number',
    description: 'Probability a node is online',
    default: 0.2,
  })
  .option('k', {
    type: 'number',
    description: 'Kademlia k parameter (bucket size)',
    default: 20,
  })
  .option('networkAwareness', {
    type: 'number',
    description: 'Average fraction of network each node is aware of',
    default: 0.3,
  })
  .option('referenceDistance', {
    type: 'number',
    description: 'Reference distance for ProbabilisticForwardStrategy',
    default: 2 ** 40,
  })
  .option('forwardStrategy', {
    type: 'string',
    description: 'Forwarding strategy (default, distance, random, probabilistic)',
    default: 'probabilistic',
  })
  .option('cacheStrategy', {
    type: 'string',
    description: 'Caching strategy (default, lru)',
    default: 'default',
  })
  .option('outputFile', {
    type: 'string',
    description: 'Output file for simulation results (JSON)',
    default: './output/simulation_result.json',
  })
  .help()
  .parseSync();

async function main() {
  const result = await runSimulation({
    numNodes: argv.numNodes,
    onlineProbability: argv.onlineProbability,
    k: argv.k,
    networkAwareness: argv.networkAwareness,
    referenceDistance: argv.referenceDistance,
    forwardStrategy: argv.forwardStrategy,
    cacheStrategy: argv.cacheStrategy,
    outputFile: argv.outputFile,
  });
}

main().catch(console.error);