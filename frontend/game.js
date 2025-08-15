const GRID_SIZE = 8;
const BASE_POS = [GRID_SIZE-1, Math.floor(GRID_SIZE/2)];
const CELL_TYPE = { EMPTY: 0, TOWER: 1, ENEMY: 2, BASE: 3 };

let health = 100;
let money = 100;
let wave = 1;
let towers = [];
let enemies = [];
let placingTower = false;
let waveInProgress = false;
let aiMessage = '';
let waveBar = 0;
let enemySpeed = 350; // ms per step

const gridEl = document.getElementById("grid");
const aiMsgEl = document.getElementById("ai-message");
const healthValEl = document.getElementById("health-value");
const moneyValEl = document.getElementById("money-value");
const waveNumEl = document.getElementById("wave-num");
const waveBarEl = document.getElementById("wave-bar");

function makeGrid() {
  gridEl.innerHTML = '';
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = document.createElement('div');
      cell.classList.add('cell');
      cell.dataset.r = r;
      cell.dataset.c = c;
      if (BASE_POS[0] === r && BASE_POS[1] === c) cell.classList.add('base');
      cell.addEventListener('click', () => onCellClick(r, c));
      gridEl.appendChild(cell);
    }
  }
}

function drawGrid() {
  for (let i = 0; i < gridEl.children.length; i++) {
    gridEl.children[i].classList.remove('tower', 'enemy');
  }
  for (const [r, c] of towers) {
    getCell(r, c).classList.add('tower');
  }
  for (const enemy of enemies) {
    if (!enemy.dead) getCell(enemy.r, enemy.c).classList.add('enemy');
  }
}

function getCell(r, c) {
  return gridEl.children[r * GRID_SIZE + c];
}

function onCellClick(r, c) {
  if (placingTower && !isOccupied(r, c) && !(BASE_POS[0] === r && BASE_POS[1] === c)) {
    if (money >= 20) {
      towers.push([r, c]);
      money -= 20;
      updateHUD();
      drawGrid();
    }
  }
}

function isOccupied(r, c) {
  return towers.some(([tr, tc]) => tr === r && tc === c) ||
    (BASE_POS[0] === r && BASE_POS[1] === c);
}

function updateHUD() {
  healthValEl.textContent = health;
  moneyValEl.textContent = money;
  waveNumEl.textContent = wave;
  waveBarEl.textContent = `${waveBar}/${wave}`;
  aiMsgEl.textContent = aiMessage;
}

document.getElementById("place-tower-btn").onclick = () => {
  placingTower = !placingTower;
  document.getElementById("place-tower-btn").textContent = placingTower ? "Stop Placing" : "Place Tower";
};
document.getElementById("upgrade-tower-btn").onclick = () => {
  if (money >= 50 && towers.length > 0) {
    money -= 50;
    // Just double the damage for all towers for simplicity
    towers.upgraded = true;
    aiMessage = "Your towers seem stronger now!";
    updateHUD();
  }
};

document.getElementById("start-wave-btn").onclick = async () => {
  if (waveInProgress) return;
  waveInProgress = true;
  aiMessage = "AI is preparing its attack...";
  updateHUD();
  const aiRes = await fetch("/ai/next_wave", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ towers, round: wave })
  });
  const aiData = await aiRes.json();
  let attackRow = aiData.attack_row;
  let waveType = aiData.wave_type; // 0 = weak, 1 = normal, 2 = strong
  startEnemyWave(attackRow, waveType);
};

function shortestPath(row) {
  // Enemies start from left edge at (row, 0)
  // Move right toward BASE_POS
  let path = [];
  let c = 0, r = row;
  while (c < GRID_SIZE) {
    path.push([r, c]);
    if (r < BASE_POS[0]) r++;
    else if (r > BASE_POS[0]) r--;
    c++;
  }
  path.push([BASE_POS[0], BASE_POS[1]]);
  return path;
}

function startEnemyWave(row, waveType) {
  enemies = [];
  let count = 3 + waveType * 2;
  for (let i = 0; i < count; i++) {
    enemies.push({
      r: row,
      c: 0,
      path: shortestPath(row),
      pathIdx: 0,
      hp: 10 + 10 * waveType + 2 * wave,
      dead: false
    });
  }
  waveBar = count;
  updateHUD();
  animateEnemies();
}

function animateEnemies() {
  if (enemies.every(e => e.dead || e.pathIdx >= e.path.length)) {
    waveInProgress = false;
    wave++;
    waveBar = 0;
    money += enemies.filter(e => e.dead).length * 10;
    updateHUD();
    // Send result & feedback to AI
    sendAIResults();
    return;
  }
  for (const enemy of enemies) {
    if (!enemy.dead && enemy.pathIdx < enemy.path.length) {
      // Tower attack
      let [er, ec] = enemy.path[enemy.pathIdx];
      for (const [tr, tc] of towers) {
        if (Math.abs(tr-er) + Math.abs(tc-ec) <= 1) {
          enemy.hp -= towers.upgraded ? 16 : 8;
        }
      }
      if (enemy.hp <= 0) { enemy.dead = true; waveBar--; }
      // Move enemy
      if (!enemy.dead) enemy.pathIdx++;
      // Damage base
      if (!enemy.dead && enemy.pathIdx === enemy.path.length-1) {
        health -= 10;
        enemy.dead = true;
        waveBar--;
      }
    }
  }
  drawGrid();
  updateHUD();
  setTimeout(animateEnemies, enemySpeed);
}

async function sendAIResults() {
  // Reward: AI gets +1 if any enemy reaches base, -1 otherwise
  let anyBreach = enemies.some(e => !e.dead && e.pathIdx === e.path.length-1);
  let reward = anyBreach ? 1 : -1;
  let state = Array(GRID_SIZE*GRID_SIZE).fill(0);
  for (const [r, c] of towers) state[r*GRID_SIZE+c] = 1;
  state[BASE_POS[0]*GRID_SIZE+BASE_POS[1]] = 3;
  let action_idx = 0; // Not tracked here, for demo pick attack_row*3+waveType
  let attack_row = enemies.length > 0 ? enemies[0].r : 0;
  let wave_type = Math.floor((enemies.length-3)/2);
  action_idx = attack_row*3 + wave_type;
  let next_state = state.slice();
  let done = true;
  const aiRes = await fetch("/ai/feedback", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      reward, state, action_idx, next_state, done, attack_row
    })
  });
  const aiData = await aiRes.json();
  aiMessage = aiData.message;
  updateHUD();
  // Optionally, ask backend to train after each round
  fetch("/ai/train", { method: "POST" });
}

makeGrid();
drawGrid();
updateHUD();