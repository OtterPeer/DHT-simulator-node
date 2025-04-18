import fs from 'fs';
import path from 'path';

interface VisNode {
  id: string;
  label: string;
  color: string;
}

interface VisEdge {
  from: string;
  to: string;
  color: string;
}

export function generateVisualizer(nodes: VisNode[], edges: VisEdge[], outputPath: string) {
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
    const nodes = new vis.DataSet(${JSON.stringify(nodes)});
    const edges = new vis.DataSet(${JSON.stringify(edges)});
    const container = document.getElementById('network');
    const data = { nodes, edges };
    const options = {
      nodes: { shape: 'dot', size: 10 },
      edges: { arrows: 'to' },
      layout: { randomSeed: 42 },
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
