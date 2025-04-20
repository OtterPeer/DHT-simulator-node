import subprocess
import json
import os
import time
import psutil
import numpy as np
import matplotlib.pyplot as plt
from itertools import product
from datetime import datetime
from typing import Dict, List, Tuple

PARAMS = {
    'numNodes': [1000],  # Fixed
    'onlineProbability': [0.1, 0.2, 0.5, 0.8],
    'k': [20],
    # 'referenceDistance': [1e10, 1e12],  # Only for probabilistic
    'referenceDistance': [137438953472.0, 1099511627776.0, 17592186044416],  # 2^37, 2^40, 2^44 Only for probabilistic forwardStrategy
    'networkAwareness': [0.05, 0.1, 0.3, 0.5, 0.8],
    # 'forwardStrategy': ['default', 'probabilistic'],
    'forwardStrategy': ['probabilistic', 'distance'],
    'cacheStrategy': ['default'],  # Fixed
}

NUM_RUNS = 100
SIMULATION_TIMEOUT = 60

OUTPUT_DIR = './output'
PLOT_DIR = './output/plots'
CPU_LOG_FILE = './output/cpu_usage.csv'
RESULTS_FILE = './output/simulation_results.json'

def ensure_directories():
    """Create output and plot directories if they don't exist."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(PLOT_DIR, exist_ok=True)

def is_valid_combination(params: Dict) -> bool:
    """Check if the parameter combination is valid (referenceDistance only for probabilistic)."""
    if params['forwardStrategy'] != 'probabilistic' and params['referenceDistance'] != PARAMS['referenceDistance'][0]:
        return False
    return True

def run_simulation(params: Dict, run_id: str) -> Tuple[Dict, float]:
    """Run a single simulation and measure CPU usage."""
    output_file = f"{OUTPUT_DIR}/result_{run_id}.json"
    cmd = [
        'node', 'dist/src/simulator.js',
        '--numNodes', str(params['numNodes']),
        '--onlineProbability', str(params['onlineProbability']),
        '--k', str(params['k']),
        '--referenceDistance', str(params['referenceDistance']),
        '--networkAwareness', str(params['networkAwareness']),
        '--forwardStrategy', params['forwardStrategy'],
        '--cacheStrategy', params['cacheStrategy'],
        '--outputFile', output_file
    ]

    # Start the process
    start_time = time.time()
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    pid = process.pid
    ps_process = psutil.Process(pid)

    # Measure CPU usage
    cpu_usages = []
    try:
        # Poll process with timeout
        timeout_occurred = False
        while process.poll() is None:
            elapsed = time.time() - start_time
            if elapsed > SIMULATION_TIMEOUT:
                timeout_occurred = True
                process.terminate()  # Try graceful termination
                try:
                    process.wait(timeout=1)  # Give 1 second to terminate
                except subprocess.TimeoutExpired:
                    process.kill()  # Force kill if termination fails
                break
            try:
                cpu_percent = ps_process.cpu_percent(interval=0.1)
                cpu_usages.append(cpu_percent)
            except psutil.NoSuchProcess:
                break
            time.sleep(0.1)  # Small sleep to avoid excessive CPU usage

        if timeout_occurred:
            print(f"Run {run_id} with params {params} timed out after {SIMULATION_TIMEOUT} seconds")
            return {}, 0.0

        stdout, stderr = process.communicate()
        if process.returncode != 0:
            print(f"Error in run {run_id} with params {params}: {stderr}")
            return {}, 0.0
    except Exception as e:
        print(f"Exception in run {run_id}: {e}")
        try:
            process.terminate()
            process.wait(timeout=1)
        except:
            process.kill()
        return {}, 0.0

    # Calculate average CPU usage
    avg_cpu = np.mean(cpu_usages) if cpu_usages else 0.0

    # Read results
    try:
        with open(output_file, 'r') as f:
            result = json.load(f)
        return result, avg_cpu
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Failed to read output {output_file}: {e}")
        return {}, 0.0

def collect_results() -> List[Dict]:
    """Run simulations for all valid parameter combinations and collect results."""
    results = []
    cpu_logs = []
    param_combinations = list(product(*[v for v in PARAMS.values()]))
    valid_combinations = [p for p in param_combinations if is_valid_combination(dict(zip(PARAMS.keys(), p)))]
    total_combinations = len(valid_combinations)
    combination_count = 0

    for param_tuple in valid_combinations:
        combination_count += 1
        params = dict(zip(PARAMS.keys(), param_tuple))
        print(f"Running combination {combination_count}/{total_combinations}: {params}")

        combination_results = []
        combination_cpu = []

        for run_id in range(NUM_RUNS):
            run_id_str = f"{combination_count}_{run_id}"
            print(f"  Run {run_id + 1}/{NUM_RUNS}")
            result, cpu = run_simulation(params, run_id_str)
            if result:
                combination_results.append(result['stats'])
                combination_cpu.append(cpu)
                cpu_logs.append({
                    'run_id': run_id_str,
                    'params': params,
                    'cpu_percent': cpu,
                    'timestamp': datetime.now().isoformat()
                })

        # Aggregate results
        if combination_results:
            avg_stats = {
                'messagesSent': np.mean([r['messagesSent'] for r in combination_results]),
                'messagesReceived': np.mean([r['messagesReceived'] for r in combination_results]),
                'successRate': np.mean([r['successRate'] for r in combination_results]),
                'messagesDelivered': np.mean([r['messagesDelivered'] for r in combination_results]),
                'messagesCached': np.mean([r['messagesCached'] for r in combination_results]),
                'nodesProcessingMessage': np.mean([r['nodesProcessingMessage'] for r in combination_results]),
            }
            std_stats = {
                'messagesSent_std': np.std([r['messagesSent'] for r in combination_results]),
                'messagesReceived_std': np.std([r['messagesReceived'] for r in combination_results]),
                'successRate_std': np.std([r['successRate'] for r in combination_results]),
                'messagesDelivered_std': np.std([r['messagesDelivered'] for r in combination_results]),
                'messagesCached_std': np.std([r['messagesCached'] for r in combination_results]),
                'nodesProcessingMessage_std': np.std([r['nodesProcessingMessage'] for r in combination_results]),
            }
            results.append({
                'params': params,
                'avg_stats': avg_stats,
                'std_stats': std_stats,
                'avg_cpu_percent': np.mean(combination_cpu),
                'runs': NUM_RUNS,
                'timestamp': datetime.now().isoformat()
            })

    # Save CPU logs
    with open(CPU_LOG_FILE, 'w') as f:
        f.write('run_id,params,cpu_percent,timestamp\n')
        for log in cpu_logs:
            params_str = json.dumps(log['params'])
            f.write(f"{log['run_id']},{params_str},{log['cpu_percent']},{log['timestamp']}\n")

    # Save results
    with open(RESULTS_FILE, 'w') as f:
        json.dump(results, f, indent=2)

    return results

def plot_results(results: List[Dict]):
    """Generate plots for success rate, messages cached, and CPU usage."""
    ensure_directories()

    # Plot messagesSent vs. onlineProbability for each forwardStrategy
    for k in PARAMS['k']:
        for network_awareness in PARAMS['networkAwareness']:
            for reference_distance in PARAMS['referenceDistance']:
                plt.figure(figsize=(10, 6))
                for strategy in PARAMS['forwardStrategy']:
                    strategy_results = [
                        r for r in results
                        if r['params']['forwardStrategy'] == strategy
                           and r['params']['networkAwareness'] == network_awareness
                           and r['params']['k'] == k
                           and (strategy != 'probabilistic' or r['params']['referenceDistance'] == reference_distance)
                    ]
                    if not strategy_results:
                        continue
                    online_probability = [r['params']['onlineProbability'] for r in strategy_results]
                    messages_sent = [r['avg_stats']['messagesSent'] for r in strategy_results]
                    messages_sent_std = [r['std_stats']['messagesSent_std'] for r in strategy_results]
                    plt.errorbar(online_probability, messages_sent, yerr=messages_sent_std, label=strategy, marker='o',
                                 capsize=5)
                plt.xlabel('Online Probability')
                plt.ylabel('Average Messages Sent')
                plt.title(
                    f'Messages Sent vs. Online Probability (k={k}, networkAwareness={network_awareness}, referenceDistance={reference_distance})')
                plt.legend()
                plt.grid(True)
                plt.savefig(
                    f"{PLOT_DIR}/messages_sent_vs_online_probability_k{k}_networkAwareness{network_awareness}_referenceDistance{reference_distance}.png")
                plt.close()

    # Plot messagesSent vs. networkAwareness for each forwardStrategy
    for k in PARAMS['k']:
        for online_probability in PARAMS['onlineProbability']:
            for reference_distance in PARAMS['referenceDistance']:
                plt.figure(figsize=(10, 6))
                for strategy in PARAMS['forwardStrategy']:
                    strategy_results = [
                        r for r in results
                        if r['params']['forwardStrategy'] == strategy
                           and r['params']['onlineProbability'] == online_probability
                           and r['params']['k'] == k
                           and (strategy != 'probabilistic' or r['params']['referenceDistance'] == reference_distance)
                    ]
                    if not strategy_results:
                        continue
                    network_awareness = [r['params']['networkAwareness'] for r in strategy_results]
                    messages_sent = [r['avg_stats']['messagesSent'] for r in strategy_results]
                    messages_sent_std = [r['std_stats']['messagesSent_std'] for r in strategy_results]
                    plt.errorbar(network_awareness, messages_sent, yerr=messages_sent_std, label=strategy, marker='o',
                                 capsize=5)
                plt.xlabel('Network Awareness')
                plt.ylabel('Average Messages Sent')
                plt.title(
                    f'Messages Sent vs. Network Awareness (k={k}, onlineProbability={online_probability}, referenceDistance={reference_distance})')
                plt.legend()
                plt.grid(True)
                plt.savefig(
                    f"{PLOT_DIR}/messages_sent_vs_network_awareness_k{k}_onlineProbability{online_probability}_referenceDistance{reference_distance}.png")
                plt.close()

    # Plot messagesCached vs. onlineProbability for each forwardStrategy
    for k in PARAMS['k']:
        for network_awareness in PARAMS['networkAwareness']:
            for reference_distance in PARAMS['referenceDistance']:
                plt.figure(figsize=(10, 6))
                for strategy in PARAMS['forwardStrategy']:
                    strategy_results = [
                        r for r in results
                        if r['params']['forwardStrategy'] == strategy
                           and r['params']['networkAwareness'] == network_awareness
                           and r['params']['k'] == k
                           and (strategy != 'probabilistic' or r['params']['referenceDistance'] == reference_distance)
                    ]
                    if not strategy_results:
                        continue
                    online_probability = [r['params']['onlineProbability'] for r in strategy_results]
                    messages_cached = [r['avg_stats']['messagesCached'] for r in strategy_results]
                    messages_cached_std = [r['std_stats']['messagesCached_std'] for r in strategy_results]
                    plt.errorbar(online_probability, messages_cached, yerr=messages_cached_std, label=strategy,
                                 marker='o', capsize=5)
                plt.xlabel('Online Probability')
                plt.ylabel('Average Messages Cached')
                plt.title(
                    f'Messages Cached vs. Online Probability (k={k}, networkAwareness={network_awareness}, referenceDistance={reference_distance})')
                plt.legend()
                plt.grid(True)
                plt.savefig(
                    f"{PLOT_DIR}/messages_cached_vs_online_probability_k{k}_networkAwareness{network_awareness}_referenceDistance{reference_distance}.png")
                plt.close()

    # Plot messagesCached vs. networkAwareness for each forwardStrategy
    for k in PARAMS['k']:
        for online_probability in PARAMS['onlineProbability']:
            for reference_distance in PARAMS['referenceDistance']:
                plt.figure(figsize=(10, 6))
                for strategy in PARAMS['forwardStrategy']:
                    strategy_results = [
                        r for r in results
                        if r['params']['forwardStrategy'] == strategy
                           and r['params']['onlineProbability'] == online_probability
                           and r['params']['k'] == k
                           and (strategy != 'probabilistic' or r['params']['referenceDistance'] == reference_distance)
                    ]
                    if not strategy_results:
                        continue
                    network_awareness = [r['params']['networkAwareness'] for r in strategy_results]
                    messages_cached = [r['avg_stats']['messagesCached'] for r in strategy_results]
                    messages_cached_std = [r['std_stats']['messagesCached_std'] for r in strategy_results]
                    plt.errorbar(network_awareness, messages_cached, yerr=messages_cached_std, label=strategy,
                                 marker='o', capsize=5)
                plt.xlabel('Network Awareness')
                plt.ylabel('Average Messages Cached')
                plt.title(
                    f'Messages Cached vs. Network Awareness (k={k}, onlineProbability={online_probability}, referenceDistance={reference_distance})')
                plt.legend()
                plt.grid(True)
                plt.savefig(
                    f"{PLOT_DIR}/messages_cached_vs_network_awareness_k{k}_onlineProbability{online_probability}_referenceDistance{reference_distance}.png")
                plt.close()

def main():
    ensure_directories()
    total_combinations = len([p for p in product(*[v for v in PARAMS.values()]) if is_valid_combination(dict(zip(PARAMS.keys(), p)))])
    print(f"Starting {NUM_RUNS} runs for each of {total_combinations} parameter combinations")
    results = collect_results()
    print(f"Results saved to {RESULTS_FILE}")
    plot_results(results)
    print(f"Plots saved to {PLOT_DIR}")

if __name__ == '__main__':
    main()