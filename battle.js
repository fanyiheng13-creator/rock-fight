'use strict';
const CONFIG = require('./config');

/**
 * 权威战斗模拟。
 * 客户端只发送「输入意图」，命中、伤害、饮酒值、道具、胜负全部在这里计算。
 * 通过 attackId 去重，保证同一攻击不会被重复结算伤害。
 */
class BattleSim {
  constructor(playerIds) {
    const startX = [220, CONFIG.stage.width - 220];
    this.fighters = new Map();
    playerIds.forEach((id, index) => {
      this.fighters.set(id, {
        id,
        x: startX[index] !== undefined ? startX[index] : 220,
        y: CONFIG.stage.floor,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        onGround: true,
        facing: index === 0 ? 1 : -1,
        hp: CONFIG.fighter.maxHp,
        drunk: 0,
        attack: null,          // { type, phase, t, id, resolved }
        stun: 0,
        stumbled: false,
        lastSeq: 0,
        processedAttackIds: new Set(),
        input: { left: false, right: false, up: false, down: false, jump: false },
        pendingAttack: null,
        lastInputAt: Date.now()
      });
    });
    this.items = [];
    this.nextItemId = 1;
    this.itemTimer = 0;
    this.timeLeftMs = CONFIG.match.roundTimeMs;
    this.events = [];      // 本 tick 产生的事件，广播后清空
    this.finished = false;
    this.winnerId = null;
  }

  emit(type, payload) { this.events.push({ type, ...payload }); }

  /** 接收客户端输入（幂等 + 去重） */
  applyInput(playerId, msg) {
    const f = this.fighters.get(playerId);
    if (!f || this.finished) return;
    const seq = Number(msg && msg.seq);
    if (Number.isFinite(seq) && seq <= f.lastSeq) return;  // 过期或重放，直接丢弃
    if (Number.isFinite(seq)) f.lastSeq = seq;
    f.lastInputAt = Date.now();

    f.input.left = !!(msg && msg.left);
    f.input.right = !!(msg && msg.right);
    f.input.up = !!(msg && msg.up);
    f.input.down = !!(msg && msg.down);
    if (msg && msg.jump) f.input.jump = true;

    const atk = msg && msg.attack;
    if (atk && atk.id && atk.type && CONFIG.attacks[atk.type]) {
      if (!f.processedAttackIds.has(atk.id)) {       // 去重：同一攻击只受理一次
        f.processedAttackIds.add(atk.id);
        f.pendingAttack = { type: atk.type, id: atk.id };
      }
    }
  }

  speedOf(f) {
    const penalty = Math.min(CONFIG.drunk.maxSpeedPenalty, f.drunk * CONFIG.drunk.speedPenaltyPerPoint);
    return CONFIG.fighter.speed * (1 - penalty);
  }

  damageOf(f, type) {
    const base = CONFIG.attacks[type].damage;
    if (type === 'vomit') return base;                 // 呕吐固定 50，不吃饮酒加成
    const bonus = 1 + f.drunk * CONFIG.drunk.damageBonusPerPoint;
    return Math.round(base * bonus);
  }

  step(dt) {
    if (this.finished) return;
    this.timeLeftMs = Math.max(0, this.timeLeftMs - dt * 1000);
    if (this.timeLeftMs === 0) return this.finishByTimeout();

    for (const f of this.fighters.values()) this.stepFighter(f, dt);
    this.resolveOverlap();
    this.stepItems(dt);
    this.checkDrunkFull();
    this.checkDefeat();
  }

  /** 身体阻挡：两名角色不能重叠，也不能互相穿过（否则朝向会翻转、判定落空） */
  resolveOverlap() {
    const list = [...this.fighters.values()];
    if (list.length < 2) return;
    const [a, b] = list;
    const minGap = 56;
    const pad = CONFIG.stage.wallPadding;
    const maxX = CONFIG.stage.width - pad;
    const gap = b.x - a.x;
    if (Math.abs(gap) < minGap) {
      const dir = gap >= 0 ? 1 : -1;
      const push = (minGap - Math.abs(gap)) / 2 * dir;
      a.x -= push;
      b.x += push;
      a.x = Math.max(pad, Math.min(maxX, a.x));
      b.x = Math.max(pad, Math.min(maxX, b.x));
    }
  }

  stepFighter(f, dt) {
    if (f.stumbled) return;
    const stage = CONFIG.stage;
    const maxX = stage.width - stage.wallPadding;

    if (f.stun > 0) {
      f.stun = Math.max(0, f.stun - dt);
      f.vx = 0; f.vz = 0;
    } else {
      const speed = this.speedOf(f);
      const dir = (f.input.right ? 1 : 0) - (f.input.left ? 1 : 0);
      f.vx = dir * speed;
      if (dir !== 0) f.facing = dir;
      // 纵深（画面上的“上/下”）移动
      const depthDir = (f.input.down ? 1 : 0) - (f.input.up ? 1 : 0);
      f.vz = depthDir * CONFIG.fighter.depthSpeed * (speed / CONFIG.fighter.speed);
      if (f.input.jump && f.onGround) { f.vy = -CONFIG.fighter.jumpVelocity; f.onGround = false; }
      f.input.jump = false;
      this.startPendingAttack(f);
    }

    if (f.attack) this.stepAttack(f, dt);

    // 物理
    f.vy += stage.gravity * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.y >= stage.floor) { f.y = stage.floor; f.vy = 0; f.onGround = true; }
    f.x = Math.max(stage.wallPadding, Math.min(maxX, f.x));
    f.z = (f.z || 0) + f.vz * dt;
    f.z = Math.max(stage.depthMin, Math.min(stage.depthMax, f.z));
    f.vx = 0; f.vz = 0;

    // 转身面向对手
    const opponent = this.opponentOf(f);
    if (opponent && !f.attack && f.stun <= 0) f.facing = opponent.x >= f.x ? 1 : -1;
  }

  startPendingAttack(f) {
    if (!f.pendingAttack) return;
    const spec = CONFIG.attacks[f.pendingAttack.type];
    if (f.drunk < spec.minDrunk) { f.pendingAttack = null; return; }  // 饮酒值不足，大招无效
    f.attack = { type: f.pendingAttack.type, phase: 'windup', t: 0, id: f.pendingAttack.id, resolved: false };
    f.pendingAttack = null;
    f.vx = 0;
    this.emit('attackStart', { playerId: f.id, type: f.attack.type });
  }

  stepAttack(f, dt) {
    const a = f.attack;
    const spec = CONFIG.attacks[a.type];
    a.t += dt;
    if (a.phase === 'windup' && a.t >= spec.windup) { a.phase = 'active'; a.t = 0; }
    else if (a.phase === 'active') {
      if (!a.resolved) { a.resolved = true; this.resolveHit(f, a, spec); }
      if (a.t >= spec.active) { a.phase = 'recover'; a.t = 0; }
    } else if (a.phase === 'recover' && a.t >= spec.recover) {
      f.attack = null;
      f.stun = spec.cooldown - spec.windup - spec.active - spec.recover > 0
        ? spec.cooldown - spec.windup - spec.active - spec.recover : 0;
    }
  }

  resolveHit(attacker, a, spec) {
    const target = this.opponentOf(attacker);
    if (!target || target.stumbled) return;
    const gap = (target.x - attacker.x) * attacker.facing;
    if (gap <= 0 || gap > spec.reach) return;               // 未命中
    if (Math.abs(target.y - attacker.y) > 140) return;      // 高度差过大
    if (Math.abs((target.z || 0) - (attacker.z || 0)) > CONFIG.stage.depthReach) return;  // 纵深错位，打空

    const damage = this.damageOf(attacker, a.type);
    target.hp = Math.max(0, target.hp - damage);
    target.stun = a.type === 'super' ? 0.65 : 0.38;
    target.x = Math.max(CONFIG.stage.wallPadding, Math.min(CONFIG.stage.width - CONFIG.stage.wallPadding,
      target.x + attacker.facing * (a.type === 'super' ? 22 : 9)));

    this.emit('hit', {
      attackerId: attacker.id, targetId: target.id, type: a.type,
      damage, hp: target.hp, attackId: a.id
    });

    // 吐完就清醒：清空饮酒值，避免无限连发
    if (a.type === 'vomit' && CONFIG.drunk.vomitConsumesDrunk) {
      attacker.drunk = 0;
      attacker.drunkFull = false;
      this.emit('vomitUsed', { playerId: attacker.id });
    }
  }

  /** 弱势方 = 血量较低的一方；血量相同则随机，避免固定偏向某一边 */
  weakerFighter() {
    const list = [...this.fighters.values()];
    if (list.length < 2) return list[0] || null;
    const [a, b] = list;
    if (a.hp === b.hp) return Math.random() < 0.5 ? a : b;
    return a.hp < b.hp ? a : b;
  }

  /** 谁明显落后（用于提高其啤酒刷新概率） */
  trailingFighter() {
    const list = [...this.fighters.values()];
    if (list.length < 2) return null;
    const [a, b] = list;
    const cfg = CONFIG.items;
    if (a.hp + cfg.weakThresholdHp <= b.hp) return a;
    if (b.hp + cfg.weakThresholdHp <= a.hp) return b;
    return null;
  }

  /**
   * 道具刷新位置：默认全场随机；有较大概率刷在弱势方附近形成追分机会。
   * 弱势方是“当前血量较低者”，不是固定某一侧，所以两边都有机会。
   */
  pickSpawnX() {
    const cfg = CONFIG.items;
    const pad = CONFIG.stage.wallPadding;
    const maxX = CONFIG.stage.width - pad;
    const weak = this.weakerFighter();
    if (weak && Math.random() < cfg.weakBiasChance) {
      const x = weak.x + (Math.random() * 2 - 1) * cfg.weakBiasRange;
      return Math.max(pad, Math.min(maxX, x));
    }
    return pad + Math.random() * (maxX - pad);
  }

  /** 弱势方明显落后时更容易掉啤酒（啤酒＝增伤），让局势更容易翻盘 */
  pickItemKind() {
    const cfg = CONFIG.items;
    const trailing = this.trailingFighter();
    if (trailing && Math.random() < cfg.beerBiasWhenWeak) return 'beer';
    return cfg.kinds[Math.floor(Math.random() * cfg.kinds.length)];
  }

  stepItems(dt) {
    const cfg = CONFIG.items;
    this.itemTimer += dt * 1000;
    if (this.itemTimer >= cfg.spawnEveryMs && this.items.length < cfg.maxOnStage) {
      this.itemTimer = 0;
      const kind = this.pickItemKind();
      const x = this.pickSpawnX();
      const z = (Math.random() * 2 - 1) * cfg.depthSpread;
      this.items.push({ id: this.nextItemId++, kind, x, z });
      this.emit('itemSpawn', { id: this.items[this.items.length - 1].id, kind, x, z });
    }
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      for (const f of this.fighters.values()) {
        if (f.stumbled) continue;
        if (Math.abs(f.x - item.x) <= cfg.radius + 20 && Math.abs((f.z || 0) - (item.z || 0)) <= cfg.radius + 25) {
          f.drunk = Math.min(CONFIG.fighter.maxDrunk, f.drunk + CONFIG.drunk[item.kind]);
          this.items.splice(i, 1);
          this.emit('itemPickup', { itemId: item.id, kind: item.kind, playerId: f.id, drunk: f.drunk });
          break;
        }
      }
    }
  }

  checkDrunkFull() {
    for (const f of this.fighters.values()) {
      const full = f.drunk >= CONFIG.drunk.fullAt;
      if (full && !f.drunkFull) { f.drunkFull = true; this.emit('drunkFull', { playerId: f.id }); }
      else if (!full && f.drunkFull) f.drunkFull = false;
    }
  }

  checkDefeat() {
    for (const f of this.fighters.values()) {
      if (f.hp <= 0) { const other = this.opponentOf(f); if (other) this.finish(other.id, 'ko'); }
    }
  }

  finishByTimeout() {
    const list = [...this.fighters.values()];
    if (list.length < 2) return this.finish(null, 'timeout');
    const [a, b] = list;
    const winner = a.hp === b.hp ? null : (a.hp > b.hp ? a.id : b.id);
    this.finish(winner, 'timeout');
  }

  finish(winnerId, reason) {
    if (this.finished) return;
    this.finished = true;
    this.winnerId = winnerId;
    this.emit('matchEnd', { winnerId, reason });
  }

  opponentOf(f) {
    for (const other of this.fighters.values()) if (other.id !== f.id) return other;
    return null;
  }

  snapshot() {
    return {
      t: this.timeLeftMs,
      finished: this.finished,
      winnerId: this.winnerId,
      items: this.items.map((i) => ({ id: i.id, kind: i.kind, x: i.x, z: i.z || 0 })),
      fighters: [...this.fighters.values()].map((f) => ({
        id: f.id, x: Math.round(f.x), y: Math.round(f.y), z: Math.round(f.z || 0),
        facing: f.facing, onGround: f.onGround, hp: f.hp, drunk: f.drunk,
        stun: Number(f.stun.toFixed(3)), stumbled: f.stumbled,
        attack: f.attack ? { type: f.attack.type, phase: f.attack.phase } : null
      }))
    };
  }

  drainEvents() { const out = this.events; this.events = []; return out; }
}

module.exports = { BattleSim, CONFIG };
