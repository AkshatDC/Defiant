import random
import numpy as np
from flask import Flask, request, jsonify
import torch
import torch.nn as nn
import torch.optim as optim

# ---- RL Environment Setup ----
GRID_SIZE = 8  # 8x8 grid

# Simple state: 0=empty, 1=tower, 2=path, 3=base
# Action: Choose a path (row/column) and wave type

class SimpleTDEnv:
    def __init__(self):
        self.grid = np.zeros((GRID_SIZE, GRID_SIZE))
        self.base_pos = (GRID_SIZE-1, GRID_SIZE//2)
        self.reset()
    
    def reset(self):
        self.grid = np.zeros((GRID_SIZE, GRID_SIZE))
        self.grid[self.base_pos] = 3
        self.towers = []
        self.steps = 0
        self.done = False
        return self.grid.copy()
    
    def set_towers(self, tower_positions):
        self.grid = np.zeros((GRID_SIZE, GRID_SIZE))
        self.grid[self.base_pos] = 3
        for pos in tower_positions:
            self.grid[pos[0], pos[1]] = 1
        self.towers = tower_positions

    def get_state(self):
        # Flatten grid for simple agent
        return self.grid.flatten().astype(np.float32)
    
    def get_weakest_row(self):
        # Weakest = fewest towers in row
        tower_counts = [sum([self.grid[r, c] == 1 for c in range(GRID_SIZE)]) for r in range(GRID_SIZE)]
        return int(np.argmin(tower_counts))
    
    def step(self, action):
        # action: (attack_row, wave_type)
        attack_row, wave_type = action
        # Simulate outcome: more towers = less likely to succeed
        towers_in_row = sum([self.grid[attack_row, c] == 1 for c in range(GRID_SIZE)])
        base_defense = towers_in_row + 1
        attack_strength = wave_type + 1
        success_prob = attack_strength / (base_defense + attack_strength)
        result = np.random.rand() < success_prob
        reward = 1 if result else -1
        self.steps += 1
        self.done = self.steps >= 1  # one step per attack
        return self.get_state(), reward, self.done, {"success": result}

# ---- RL Agent ----

class SimpleAgent(nn.Module):
    def __init__(self, state_dim, action_dim):
        super().__init__()
        self.fc = nn.Sequential(
            nn.Linear(state_dim, 64),
            nn.ReLU(),
            nn.Linear(64, action_dim)
        )
    def forward(self, x):
        return self.fc(x)

# Discrete action space: all (row, wave_type) pairs
NUM_WAVE_TYPES = 3
ACTION_SPACE = [(row, wt) for row in range(GRID_SIZE) for wt in range(NUM_WAVE_TYPES)]

env = SimpleTDEnv()
state_dim = GRID_SIZE * GRID_SIZE
action_dim = len(ACTION_SPACE)
agent = SimpleAgent(state_dim, action_dim)
optimizer = optim.Adam(agent.parameters(), lr=0.001)
memory = []

# ---- Flask API ----

app = Flask(__name__)

@app.route("/ai/next_wave", methods=["POST"])
def ai_next_wave():
    data = request.json
    towers = data["towers"]  # List of [row, col]
    round_num = data.get("round", 1)
    env.set_towers([tuple(t) for t in towers])
    state = torch.tensor(env.get_state()).unsqueeze(0)
    with torch.no_grad():
        q_values = agent(state)
        # Encourage exploration in early rounds
        if random.random() < max(0.3, 1.0 - round_num * 0.05):
            action_idx = random.randrange(action_dim)
        else:
            action_idx = q_values.argmax().item()
    action = ACTION_SPACE[action_idx]
    return jsonify({
        "attack_row": int(action[0]),
        "wave_type": int(action[1])
    })

@app.route("/ai/feedback", methods=["POST"])
def ai_feedback():
    data = request.json
    reward = float(data["reward"])
    state = np.array(data["state"], dtype=np.float32)
    action_idx = int(data["action_idx"])
    next_state = np.array(data["next_state"], dtype=np.float32)
    done = bool(data["done"])
    # Store experience for replay
    memory.append((state, action_idx, reward, next_state, done))
    # Taunt logic
    taunts = [
        "Your defense is weak at row {}!",
        "Nice try, but I see an opening at row {}.",
        "Impressive defense, but I’m getting stronger!",
        "You’re doing great, but I will adapt soon."
    ]
    msg = random.choice(taunts).format(data["attack_row"])
    return jsonify({"message": msg})

@app.route("/ai/train", methods=["POST"])
def ai_train():
    # Train on collected memory
    if len(memory) < 10:
        return jsonify({"trained": False})
    batch = random.sample(memory, min(32, len(memory)))
    gamma = 0.95
    for state, action_idx, reward, next_state, done in batch:
        state_t = torch.tensor(state).unsqueeze(0)
        next_state_t = torch.tensor(next_state).unsqueeze(0)
        q_vals = agent(state_t)
        target = q_vals.clone().detach()
        with torch.no_grad():
            next_q = agent(next_state_t).max().item()
        target[0, action_idx] = reward + (0 if done else gamma * next_q)
        loss = nn.MSELoss()(q_vals, target)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    return jsonify({"trained": True})

if __name__ == "__main__":
    app.run(debug=True)