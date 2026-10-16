'use strict';
/**
 * 唯一真相（Single Source of Truth）
 * 所有战斗数值只在这里定义，服务器在玩家入房时下发给客户端。
 * 客户端本地数值仅用于预测显示，任何伤害/胜负都由服务器决定。
 */
const CONFIG = {
  net: {
    tickHz: 30,             // 服务器模拟频率
    snapshotHz: 20,         // 广播快照频率
    inputTimeoutMs: 1500    // 超过此时长没收到输入就视为静止
  },
  room: {
    maxPlayers: 2,          // 每房间最多两人
    codeLength: 4,          // 房间号位数
    countdownMs: 3000,      // 3、2、1 倒计时
    emptyRoomTtlMs: 60000   // 房间空了多久后回收
  },
  stage: {
    width: 960,
    height: 540,
    floor: 425,
    gravity: 1500,
    wallPadding: 70,
    // 纵深轴（画面上的“上/下”）：3D 里角色可以前后走位，走出对方攻击纵深就会打空
    depthMin: -130,
    depthMax: 130,
    depthReach: 70
  },
  fighter: {
    maxHp: 100,
    maxDrunk: 100,
    speed: 250,
    depthSpeed: 200,
    jumpVelocity: 520,
    bodyWidth: 60,
    bodyHeight: 170
  },
  attacks: {
    // windup 前摇 / active 判定窗口 / recover 后摇 / cooldown 冷却（秒）
    punch: { damage: 8,  reach: 150, windup: 0.10, active: 0.08, recover: 0.16, cooldown: 0.32, minDrunk: 0 },
    beat:  { damage: 13, reach: 390, windup: 0.19, active: 0.12, recover: 0.25, cooldown: 0.70, minDrunk: 0 },
    super: { damage: 30, reach: 455, windup: 0.40, active: 0.20, recover: 0.30, cooldown: 1.30, minDrunk: 30 },
    // 呕吐攻击：饮酒值满后，J+K 同时按触发，固定 50 伤害
    vomit: { damage: 50, reach: 190, windup: 0.25, active: 0.20, recover: 0.35, cooldown: 2.50, minDrunk: 100 }
  },
  drunk: {
    beer: 30,                 // 拾取啤酒增加的饮酒值
    shot: 20,                 // 拾取 shot 增加的饮酒值
    damageBonusPerPoint: 0.01,  // 每点饮酒值提升的伤害（满值 +100%）
    speedPenaltyPerPoint: 0.004,// 每点饮酒值降低的移速比例（上限 50%）
    maxSpeedPenalty: 0.5,
    fullAt: 100,              // 达到此值＝酒满了，解锁呕吐攻击
    vomitDamage: 50,          // 呕吐固定伤害
    vomitConsumesDrunk: true  // 吐完清空饮酒值，避免无限连发
  },
  items: {
    kinds: ['beer', 'shot'],
    spawnEveryMs: 7000,       // 道具刷新间隔
    maxOnStage: 3,
    radius: 22,
    margin: 120,
    // 刷新更随机：整体仍在全场随机，但更大几率刷在“弱势方”附近，给落后的人追分机会
    weakBiasChance: 0.7,      // 刷在弱势方附近的概率
    weakBiasRange: 170,       // 弱势方附近刷新的横向半径
    beerBiasWhenWeak: 0.75,   // 明显落后时，刷新啤酒（增伤）的概率
    weakThresholdHp: 20,      // 落后多少血算“明显弱势”
    depthSpread: 110          // 道具在纵深方向上的散布半径
  },
  match: {
    roundTimeMs: 90000,       // 单局时长
    roundsToWin: 1            // 先赢几局获胜
  }
};

module.exports = CONFIG;
