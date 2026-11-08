// store.js — сохранение прогресса, уровни, награды

const KEY = 'arenacars_v1';
const def = () => ({ name: '', coins: 0, xp: 0, owned: [0], car: 0, arena: 0, vol: 0.8, mus: 0.55, side: 'left', btn: 1, server: '', token: '', pid: '', icon: 0, boxes: 0, claimed: 1 });

function load() {
  try {
    return { ...def(), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return def();
  }
}

export const S = load();

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch {
    /* память недоступна — играем без сохранения */
  }
}

export const MAX_LEVEL = 100;
// сколько опыта нужно, чтобы перейти с уровня l на l+1
export const xpFor = (l) => 40 + 2 * l;

export function levelInfo(xp) {
  let l = 1;
  let need = xpFor(1);
  while (l < MAX_LEVEL && xp >= need) {
    xp -= need;
    l++;
    need = xpFor(l);
  }
  return { level: l, cur: l >= MAX_LEVEL ? need : xp, need };
}

export const REWARD = {
  win: { coins: 20, xp: 50 },
  lose: { coins: 5, xp: -5 },
};

export const ICONS = ['😎', '🤖', '🦊', '🐯', '🐲', '👽', '🦁', '🐼', '🔥', '⚡', '👑', '💀'];
export const BOX_PRICE = 400;
export const LEVEL_COINS = 10; // монеты за каждый новый уровень

// награда за матч + награды за новые уровни (ящик на 10, 20, ... 90 уровне, лучшая машина на 100)
export function applyReward(won) {
  const r = won ? REWARD.win : REWARD.lose;
  const before = levelInfo(S.xp).level;
  S.coins += r.coins;
  S.xp = Math.max(0, S.xp + r.xp);
  const after = levelInfo(S.xp).level;
  const gifts = { coins: 0, boxes: 0, car: -1 };
  for (let l = S.claimed + 1; l <= after; l++) {
    gifts.coins += LEVEL_COINS;
    if (l % 10 === 0 && l < MAX_LEVEL) gifts.boxes++;
    if (l === MAX_LEVEL) gifts.car = 19;
  }
  if (after > S.claimed) S.claimed = after;
  S.coins += gifts.coins;
  S.boxes += gifts.boxes;
  if (gifts.car >= 0 && !S.owned.includes(gifts.car)) S.owned.push(gifts.car);
  else gifts.car = -1;
  persist();
  return { coins: r.coins, xp: r.xp, before, after, gifts };
}
