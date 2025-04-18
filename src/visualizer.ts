import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';

interface VisNode {
  id: string;
  label: string;
  color: string;
  x?: number;
  y?: number;
}

interface VisEdge {
  from: string;
  to: string;
  color: string;
}

function xorDistance(id1: string, id2: string): string {
  const b1 = Buffer.from(id1, 'hex');
  const b2 = Buffer.from(id2, 'hex');
  const result = Buffer.alloc(Math.max(b1.length, b2.length));
  for (let i = 0; i < result.length; i++) {
    result[i] = (b1[i] || 0) ^ (b2[i] || 0);
  }
  return result.toString('hex');
}

export function generateVisualizer(
  nodes: VisNode[],
  edges: VisEdge[],
  outputPath: string,
  senderId?: string,
  recipientId?: string
) {
  // Sort nodes by XOR distance from the first node
  const referenceId = nodes[0]?.id || '';
  const sortedNodes = nodes.map(node => ({
    ...node,
    distance: xorDistance(node.id, referenceId),
  })).sort((a, b) => a.distance.localeCompare(b.distance));

  // Calculate positions with scaled gaps
  const positions: VisNode[] = [];
  let currentX = 0;
  const baseGap = 100;
  const maxGap = 300;
  const scaleFactor = 0.0001;

  for (let i = 0; i < sortedNodes.length; i++) {
    const node = sortedNodes[i];
    positions.push({
      ...node,
      x: currentX,
      y: 0,
    });

    if (i < sortedNodes.length - 1) {
      const currentDistance = BigInt('0x' + node.distance);
      const nextDistance = BigInt('0x' + sortedNodes[i + 1].distance);
      const distanceDiff = Number(nextDistance - currentDistance) * scaleFactor;
      const gap = Math.min(maxGap, baseGap + distanceDiff);
      currentX += gap;
    }
  }

  // Apply colors for sender and recipient
  const finalNodes = positions.map(node => ({
    ...node,
    color: node.id === senderId ? '#0000FF' : // Blue for sender
           node.id === recipientId ? '#800080' : // Purple for recipient
           node.color,
  }));

  // Add unique IDs and curved edges with randomized radius
  const finalEdges = edges.map((edge, index) => ({
    ...edge,
    smooth: {
      enabled: true,
      type: index % 2 === 0 ? 'curvedCW' : 'curvedCCW', // Alternate clockwise/counterclockwise
      roundness: 0.2 + Math.random() * 0.3, // Random radius between 0.2 and 0.5
    },
  }));

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Kademlia DHT Simulation</title>
  <script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.2/dist/vis-network.min.js"></script>
  <style>
    #network {
      width: 100%;
      height: 600px;
      border: 1px solid lightgray;
    }
  </style>
</head>
<body>
  <div id="network"></div>
  <script>
    const nodes = new vis.DataSet(${JSON.stringify(finalNodes)});
    const edges = new vis.DataSet(${JSON.stringify(finalEdges)});
    const container = document.getElementById('network');
    const data = { nodes, edges };
    const options = {
      nodes: { shape: 'dot', size: 10 },
      edges: { arrows: 'to' },
      layout: { hierarchical: false },
      physics: { enabled: false },
    };
    new vis.Network(container, data, options);
  </script>
</body>
</html>
  `;

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, htmlContent);
}