Install dependencies:
```shell
npm install
```

Compile ts files:
```shell
tsc
```

Run simulation with given params:
```
node dist/src/simulator.js --numNodes 1000 --onlineProbability 0.1 --k 20 --referenceDistance 10000000000000.0 --networkAwareness 0.2 --forwardStrategy probabilistic --cacheStrategy distance
```

or

```
node dist/src/simulator.js --numNodes 1000 --onlineProbability 0.1 --k 20 --networkAwareness 0.2 --forwardStrategy distance --cacheStrategy distance
```