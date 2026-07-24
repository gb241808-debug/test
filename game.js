(() => {
  "use strict";

  const canvas = document.querySelector("#gameCanvas");
  const ctx = canvas.getContext("2d");
  const shoichiSprite = new Image();
  shoichiSprite.src = "assets/characters/shoichi-v2.png";
  const combatLog = document.querySelector("#combatLog");
  const toast = document.querySelector("#toast");
  const skillElements = new Map(
    [...document.querySelectorAll(".skill")].map((element) => [element.dataset.key, element])
  );

  const CONFIG = {
    playerRadius: 17,
    moveSpeed: 235,
    attackRange: 49,
    attackDamage: 60,
    attackWindup: 0.13,
    dummyMaxHp: 1200,
    passiveDuration: 5,
    daggerPickupRadius: 48,
    daggerPickupRadiusY: 25,
    daggerThrowRange: 380,
    daggerDamage: 72,
    q: { cooldown: 6, range: 135, empoweredRange: 195, empoweredDaggerDistance: 160, width: 24, damage: 105, empoweredDamage: 135, windup: 0.1, recovery: 0.16 },
    w: { cooldown: 8, range: 420, width: 24, damage: 88, windup: 0, recovery: 0 },
    e: { cooldown: 12, range: 285, backstep: 46, backstepDuration: 0.14, width: 18, damage: 92, windup: 0.16, recovery: 0.24 },
    r: { cooldown: 55, radius: 155, daggerDistance: 178, damage: 150, windup: 0.22, recovery: 0.34 },
    d: { cooldown: 20, stealthDuration: 1.5, range: 420, damage: 115, behindDistance: 52 },
    f: { cooldown: 45, range: 230 },
  };

  const state = {
    width: 0,
    height: 0,
    dpr: 1,
    lastTime: performance.now(),
    now: 0,
    mouse: { x: 0, y: 0 },
    rightMouseHeld: false,
    rightPointerId: null,
    placingDummy: false,
    cooldownResetMode: true,
    cooldownInput: 40,
    attackSpeed: 1.08,
    nextId: 1,
    movingDummies: false,
    recording: false,
    recordStartedAt: 0,
    recordedCombo: [],
    playbackSpeed: 1,
    player: {
      x: 0,
      y: 0,
      radius: CONFIG.playerRadius,
      facing: { x: -0.7, y: -0.7 },
      spriteFacingX: -1,
      moveTarget: null,
      targetId: null,
      attackTimer: 0,
      attackFlash: 0,
      passiveStacks: 0,
      passiveExpireAt: 0,
      qEmpoweredUntil: 0,
      actionLockUntil: 0,
      actionKey: null,
      actionCancelableByW: false,
      pendingSkill: null,
      forcedMovement: null,
      dRecastUntil: 0,
    },
    cooldowns: { Q: 0, W: 0, E: 0, R: 0, D: 0, F: 0 },
    dummies: [],
    daggers: [],
    pendingDaggers: [],
    projectiles: [],
    effects: [],
  };

  let toastTimer;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const length = (x, y) => Math.hypot(x, y);

  function normalized(x, y, fallback = state.player.facing) {
    const magnitude = length(x, y);
    if (magnitude < 0.0001) return { x: fallback.x, y: fallback.y };
    return { x: x / magnitude, y: y / magnitude };
  }

  function pointSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const denominator = dx * dx + dy * dy;
    if (denominator === 0) return distance(point, start);
    const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator, 0, 1);
    return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
  }

  function getDirectionToMouse() {
    return normalized(state.mouse.x - state.player.x, state.mouse.y - state.player.y);
  }

  function currentCooldown(base) {
    const reduction = Math.min(0.8, state.cooldownInput * 0.007);
    return base * (1 - reduction);
  }

  function isAlive(dummy) {
    return dummy.hp > 0 && state.now >= dummy.respawnAt;
  }

  function getDummyById(id) {
    return state.dummies.find((dummy) => dummy.id === id) || null;
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1300);
  }

  function log(message, className = "system") {
    const row = document.createElement("p");
    row.className = className;
    row.textContent = message;
    combatLog.append(row);
    while (combatLog.children.length > 7) combatLog.firstElementChild.remove();
  }

  function addEffect(effect) {
    state.effects.push({ maxLife: effect.life, ...effect });
  }

  function damageNumber(x, y, amount, color = "#ffd7dc") {
    addEffect({ type: "text", x, y, text: `-${Math.round(amount)}`, color, life: 0.72 });
  }

  function addPassiveStack() {
    const player = state.player;
    player.passiveStacks = Math.min(5, player.passiveStacks + 1);
    player.passiveExpireAt = state.now + CONFIG.passiveDuration;
    if (player.passiveStacks === 5) {
      log("부당거래 최대 중첩", "action");
      notify("부당거래 5중첩 · 다음 기본 공격 강화");
    }
  }

  function dealDamage(dummy, amount, options = {}) {
    if (!dummy || !isAlive(dummy)) return false;
    let finalDamage = amount;
    if (options.thrownDagger && dummy.markUntil > state.now) finalDamage *= 1.25;

    dummy.damageTaken += finalDamage;
    if (!dummy.infiniteHealth) {
      dummy.hp = Math.max(0, dummy.hp - finalDamage);
    }
    dummy.hitFlash = 0.16;
    damageNumber(dummy.x, dummy.y - 28, finalDamage, options.color);

    if (options.slowDuration) {
      dummy.slowUntil = Math.max(dummy.slowUntil, state.now + options.slowDuration);
      dummy.slowRatio = options.slowRatio ?? 0.5;
    }

    if (dummy.hp <= 0) {
      dummy.respawnAt = state.now + 1.25;
      if (dummy.markUntil > state.now) {
        state.cooldowns.E *= 0.1;
        log("협상 대상 처치 · E 쿨다운 90% 감소", "action");
      }
      dummy.markUntil = 0;
      state.player.targetId = null;
      addEffect({ type: "burst", x: dummy.x, y: dummy.y, color: "#bb263a", radius: 44, life: 0.5 });
    }
    return true;
  }

  function spawnDummy(x, y) {
    const margin = 55;
    const dummy = {
      id: state.nextId++,
      x: clamp(x, margin, state.width - margin),
      y: clamp(y, margin, state.height - margin),
      radius: 22,
      hp: CONFIG.dummyMaxHp,
      maxHp: CONFIG.dummyMaxHp,
      infiniteHealth: true,
      damageTaken: 0,
      markUntil: 0,
      slowUntil: 0,
      slowRatio: 1,
      hitFlash: 0,
      respawnAt: 0,
      wanderAngle: Math.random() * Math.PI * 2,
      wanderTimer: 0.7 + Math.random() * 1.5,
    };
    state.dummies.push(dummy);
    log("연습용 더미 생성");
    return dummy;
  }

  function spawnDagger(x, y, options = {}) {
    const landingX = clamp(x, 24, state.width - 24);
    const landingY = clamp(y, 24, state.height - 24);
    const id = state.nextId++;
    const pendingDagger = {
      id,
      x: landingX,
      y: landingY,
      startX: options.startX ?? state.player.x,
      startY: options.startY ?? state.player.y,
      elapsed: 0,
      duration: options.duration ?? 0.24,
      arcHeight: options.arcHeight ?? 34,
      curve: options.curve ?? (id % 2 === 0 ? 20 : -20),
      spinTurns: options.spinTurns ?? 2.75,
      pulse: Math.random() * Math.PI * 2,
    };
    state.pendingDaggers.push(pendingDagger);
    addEffect({
      type: "burst",
      x: pendingDagger.startX,
      y: pendingDagger.startY,
      color: "#f5dce2",
      radius: 24,
      life: 0.16,
    });
    return pendingDagger;
  }

  function landDagger(pendingDagger) {
    const dagger = {
      id: pendingDagger.id,
      x: pendingDagger.x,
      y: pendingDagger.y,
      createdAt: state.now,
      pulse: pendingDagger.pulse,
    };
    state.daggers.push(dagger);
    addEffect({ type: "burst", x: dagger.x, y: dagger.y, color: "#ff304d", radius: 34, life: 0.34 });
    addEffect({ type: "ring", x: dagger.x, y: dagger.y + 4, radius: 46, color: "#249eea", width: 3, life: 0.38 });
    for (let index = 0; index < 4; index += 1) {
      const angle = Math.PI / 4 + index * Math.PI / 2;
      addEffect({
        type: "line",
        x1: dagger.x + Math.cos(angle) * 5,
        y1: dagger.y + Math.sin(angle) * 5,
        x2: dagger.x + Math.cos(angle) * 30,
        y2: dagger.y + Math.sin(angle) * 30,
        color: index % 2 ? "#298ed2" : "#ff4059",
        width: 3,
        life: 0.22,
      });
    }
    if (isPlayerTouchingDagger(state.player, dagger)) {
      pickUpDagger(dagger, true);
    }
    return dagger;
  }

  function updatePendingDaggers(dt) {
    for (let index = state.pendingDaggers.length - 1; index >= 0; index -= 1) {
      const pendingDagger = state.pendingDaggers[index];
      pendingDagger.elapsed = Math.min(pendingDagger.duration, pendingDagger.elapsed + dt);
      if (pendingDagger.elapsed >= pendingDagger.duration) {
        state.pendingDaggers.splice(index, 1);
        landDagger(pendingDagger);
      }
    }
  }

  function finishPendingDaggers() {
    const pending = state.pendingDaggers.splice(0);
    pending.forEach(landDagger);
  }

  function isPlayerTouchingDagger(player, dagger) {
    const pulse = 1 + Math.sin(state.now * 5 + dagger.pulse) * 0.08;
    const radiusX = CONFIG.daggerPickupRadius * pulse + player.radius;
    const radiusY = CONFIG.daggerPickupRadiusY * pulse + player.radius;
    const dx = player.x - dagger.x;
    const dy = player.y - (dagger.y + 4);
    return (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) <= 1;
  }

  function removeDagger(id) {
    const index = state.daggers.findIndex((dagger) => dagger.id === id);
    if (index >= 0) return state.daggers.splice(index, 1)[0];
    return null;
  }

  function chooseDaggerTarget(origin) {
    const candidates = state.dummies
      .filter(isAlive)
      .filter((dummy) => distance(origin, dummy) <= CONFIG.daggerThrowRange);
    const marked = candidates
      .filter((dummy) => dummy.markUntil > state.now)
      .sort((a, b) => distance(origin, a) - distance(origin, b));
    if (marked.length) return marked[0];
    return candidates.sort((a, b) => distance(origin, a) - distance(origin, b))[0] || null;
  }

  function pickUpDagger(dagger, resetW = false) {
    const removed = removeDagger(dagger.id);
    if (!removed) return;

    if (resetW) {
      state.cooldowns.W = 0;
      log("단검 회수 · W 쿨다운 초기화", "action");
    }

    const target = chooseDaggerTarget(state.player);
    if (!target) {
      addEffect({ type: "burst", x: removed.x, y: removed.y, color: "#54b8ff", radius: 24, life: 0.3 });
      return;
    }

    state.projectiles.push({
      type: "passiveDagger",
      visual: "whiteDagger",
      x: state.player.x,
      y: state.player.y,
      targetId: target.id,
      speed: 720,
      radius: 5,
    });
    log(target.markUntil > state.now ? "단검 투척 · 협상 대상 우선" : "단검 투척");
  }

  function getDummyAt(x, y, extra = 8) {
    return state.dummies
      .filter(isAlive)
      .filter((dummy) => Math.hypot(x - dummy.x, y - dummy.y) <= dummy.radius + extra)
      .sort((a, b) => distance({ x, y }, a) - distance({ x, y }, b))[0] || null;
  }

  function getNearestDummy(origin = state.player, maxRange = Infinity) {
    return state.dummies
      .filter(isAlive)
      .filter((dummy) => distance(origin, dummy) <= maxRange)
      .sort((a, b) => distance(origin, a) - distance(origin, b))[0] || null;
  }

  function issueAttack(dummy) {
    if (!dummy) {
      log("기본 공격 대상 없음");
      return;
    }
    state.player.targetId = dummy.id;
    state.player.moveTarget = null;
    log("기본 공격 대상 지정");
  }

  function performBasicAttack(dummy) {
    const player = state.player;
    const direction = normalized(dummy.x - player.x, dummy.y - player.y);
    player.facing = direction;
    player.attackTimer = 1 / state.attackSpeed;
    player.attackFlash = CONFIG.attackWindup;

    let damage = CONFIG.attackDamage;
    let empowered = false;
    if (player.passiveStacks >= 5) {
      empowered = true;
      damage += 88;
      player.passiveStacks = 0;
      player.passiveExpireAt = 0;
      spawnDagger(dummy.x + direction.x * 72, dummy.y + direction.y * 72);
      log("부당거래 강화 기본 공격 · 단검 생성", "action");
    }

    dealDamage(dummy, damage, { color: empowered ? "#ff566a" : "#f4e7c3" });
    addEffect({
      type: "line",
      x1: player.x,
      y1: player.y,
      x2: dummy.x,
      y2: dummy.y,
      color: empowered ? "#ff2d49" : "#e8d4a8",
      width: empowered ? 7 : 3,
      life: empowered ? 0.26 : 0.16,
    });
    recordAction("A");
  }

  function dummiesAlongLine(start, end, width) {
    return state.dummies.filter(isAlive).filter(
      (dummy) => pointSegmentDistance(dummy, start, end) <= width + dummy.radius
    );
  }

  function daggersAlongLine(start, end) {
    return state.daggers
      .filter((dagger) => pointSegmentDistance(dagger, start, end) <= CONFIG.daggerPickupRadius)
      .sort((a, b) => distance(start, a) - distance(start, b));
  }

  function canCast(key) {
    if (state.player.actionLockUntil > state.now) {
      log(`동작 중 · ${key} 입력 불가`);
      return false;
    }
    if (state.cooldowns[key] > 0) {
      log(`${key} 쿨다운 ${state.cooldowns[key].toFixed(1)}초`);
      return false;
    }
    return true;
  }

  function startCooldown(key, duration) {
    state.cooldowns[key] = state.cooldownResetMode ? 0 : duration;
  }

  function beginSkill(key, config, execute, options = {}) {
    if (!canCast(key)) return false;
    const player = state.player;
    player.pendingSkill = {
      key,
      executeAt: state.now + config.windup,
      execute,
    };
    player.actionLockUntil = state.now + config.windup + config.recovery;
    player.actionKey = key;
    player.actionCancelableByW = Boolean(options.cancelableByW);
    player.moveTarget = null;
    pulseSkill(key);
    recordAction(key);
    addEffect({
      type: "ring",
      x: player.x,
      y: player.y,
      radius: player.radius + 9,
      color: "#f3d9bd",
      width: 2,
      life: config.windup + 0.08,
    });
    if (config.windup === 0) {
      player.pendingSkill = null;
      execute();
      if (config.recovery === 0) {
        player.actionLockUntil = state.now;
        player.actionKey = null;
        player.actionCancelableByW = false;
      }
    }
    return true;
  }

  function cancelCurrentActionForW() {
    const player = state.player;
    if (player.actionLockUntil <= state.now || !player.actionCancelableByW) return false;
    const canceledKey = player.actionKey;
    player.pendingSkill = null;
    player.forcedMovement = null;
    player.actionLockUntil = state.now;
    player.actionKey = null;
    player.actionCancelableByW = false;
    log(`${canceledKey} 동작 취소 · 비약 연계`, "action");
    return true;
  }

  function processPendingSkill() {
    const pending = state.player.pendingSkill;
    if (!pending || state.now < pending.executeAt) return;
    state.player.pendingSkill = null;
    pending.execute();
  }

  function updateForcedMovement(dt) {
    const player = state.player;
    const movement = player.forcedMovement;
    if (!movement) return;

    movement.elapsed = Math.min(movement.duration, movement.elapsed + dt);
    const progress = movement.duration > 0 ? movement.elapsed / movement.duration : 1;
    const eased = 1 - Math.pow(1 - progress, 3);
    player.x = movement.startX + (movement.endX - movement.startX) * eased;
    player.y = movement.startY + (movement.endY - movement.startY) * eased;

    if (progress >= 1) player.forcedMovement = null;
  }

  function finishForcedMovement() {
    const player = state.player;
    const movement = player.forcedMovement;
    if (!movement) return;
    player.x = movement.endX;
    player.y = movement.endY;
    player.forcedMovement = null;
  }

  function castQ() {
    const player = state.player;
    const direction = getDirectionToMouse();
    const empowered = player.qEmpoweredUntil > state.now;
    player.facing = direction;
    beginSkill("Q", CONFIG.q, () => {
      const range = empowered ? CONFIG.q.empoweredRange : CONFIG.q.range;
      const width = empowered ? CONFIG.q.width * 1.7 : CONFIG.q.width;
      const start = { x: player.x, y: player.y };
      const end = { x: player.x + direction.x * range, y: player.y + direction.y * range };
      const hits = dummiesAlongLine(start, end, width);

      if (empowered) player.qEmpoweredUntil = 0;
      startCooldown("Q", currentCooldown(CONFIG.q.cooldown));
      hits.forEach((dummy) => dealDamage(dummy, empowered ? CONFIG.q.empoweredDamage : CONFIG.q.damage));

      if (hits.length) {
        state.cooldowns.Q = Math.max(0, state.cooldowns.Q - 3);
        if (!empowered) player.qEmpoweredUntil = state.now + 10;
        addPassiveStack();
        log(empowered ? "강화 표리 적중" : "표리 적중 · 다음 표리 강화", "action");
      }

      if (empowered) {
        spawnDagger(
          player.x + direction.x * CONFIG.q.empoweredDaggerDistance,
          player.y + direction.y * CONFIG.q.empoweredDaggerDistance
        );
      }

      addEffect({
        type: empowered ? "arc" : "line",
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        angle: Math.atan2(direction.y, direction.x),
        color: "#ff314b",
        width: empowered ? 14 : 6,
        radius: range,
        life: empowered ? 0.34 : 0.22,
      });
    }, { cancelableByW: empowered });
  }

  function getWTarget() {
    const range = CONFIG.w.range;
    const mouse = state.mouse;
    const candidates = [
      ...state.daggers.map((dagger) => ({ type: "dagger", value: dagger })),
      ...state.pendingDaggers.map((dagger) => ({ type: "pendingDagger", value: dagger })),
      ...state.dummies.filter(isAlive).map((dummy) => ({ type: "dummy", value: dummy })),
    ].filter((candidate) => distance(state.player, candidate.value) <= range);

    const hovered = candidates
      .filter((candidate) => distance(mouse, candidate.value) <= (candidate.type === "dummy" ? 52 : 42))
      .sort((a, b) => distance(mouse, a.value) - distance(mouse, b.value))[0];
    if (hovered) return hovered;

    const attackTarget = getDummyById(state.player.targetId);
    if (attackTarget && isAlive(attackTarget) && distance(state.player, attackTarget) <= range) {
      return { type: "dummy", value: attackTarget };
    }
    return null;
  }

  function castW() {
    const player = state.player;
    const canCancelCurrentAction = player.actionLockUntil > state.now && player.actionCancelableByW;
    if (player.actionLockUntil > state.now && !canCancelCurrentAction) {
      canCast("W");
      return;
    }
    if (state.cooldowns.W > 0) {
      canCast("W");
      return;
    }
    const target = getWTarget();
    if (!target) {
      log("비약 대상 없음");
      notify("마우스를 적 또는 단검 위에 두고 W를 사용하세요.");
      return;
    }

    if (canCancelCurrentAction) cancelCurrentActionForW();
    beginSkill("W", CONFIG.w, () => {
      const player = state.player;
      const start = { x: player.x, y: player.y };
      const direction = normalized(target.value.x - player.x, target.value.y - player.y);
      const end = target.type === "dummy"
        ? { x: target.value.x - direction.x * 25, y: target.value.y - direction.y * 25 }
        : { x: target.value.x, y: target.value.y };
      const crossedDaggers = daggersAlongLine(start, end);

      startCooldown("W", currentCooldown(CONFIG.w.cooldown));
      const hits = dummiesAlongLine(start, end, CONFIG.w.width);
      hits.forEach((dummy) => dealDamage(dummy, CONFIG.w.damage));
      if (hits.length) addPassiveStack();

      player.x = clamp(end.x, 20, state.width - 20);
      player.y = clamp(end.y, 20, state.height - 20);
      player.facing = direction;
      player.moveTarget = null;

      addEffect({ type: "line", x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: "#168dde", width: 18, life: 0.34 });
      addEffect({ type: "line", x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: "#ff3049", width: 3, life: 0.24 });

      crossedDaggers.forEach((dagger) => pickUpDagger(dagger, true));
      if (crossedDaggers.length) {
        log(`비약 경로 단검 ${crossedDaggers.length}개 회수`, "action");
      } else {
        log("비약 · 적 대상", "action");
      }
    });
  }

  function castE() {
    const player = state.player;
    const direction = getDirectionToMouse();
    player.facing = direction;
    beginSkill("E", CONFIG.e, () => {
      const start = { x: player.x, y: player.y };
      const end = { x: start.x + direction.x * CONFIG.e.range, y: start.y + direction.y * CONFIG.e.range };
      const candidates = dummiesAlongLine(start, end, CONFIG.e.width)
        .sort((a, b) => distance(start, a) - distance(start, b));
      const target = candidates[0] || null;

      startCooldown("E", currentCooldown(CONFIG.e.cooldown));
      player.forcedMovement = {
        startX: player.x,
        startY: player.y,
        endX: clamp(player.x - direction.x * CONFIG.e.backstep, 20, state.width - 20),
        endY: clamp(player.y - direction.y * CONFIG.e.backstep, 20, state.height - 20),
        elapsed: 0,
        duration: CONFIG.e.backstepDuration,
      };
      player.moveTarget = null;

      addEffect({ type: "ring", x: start.x, y: start.y, radius: 38, color: "#e6ecf0", width: 5, life: 0.38 });
      addEffect({ type: "line", x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: "#ff314b", width: 4, life: 0.28 });

      if (target) {
        dealDamage(target, CONFIG.e.damage, { slowDuration: 1.5, slowRatio: 0.65 });
        target.markUntil = state.now + 5;
        spawnDagger(target.x + direction.x * 78, target.y + direction.y * 78);
        addPassiveStack();
        log("협상 적중 · 표식과 단검 생성", "action");
      } else {
        log("협상 빗나감");
      }
    }, { cancelableByW: true });
  }

  function castR() {
    const player = state.player;
    beginSkill("R", CONFIG.r, () => {
      startCooldown("R", currentCooldown(CONFIG.r.cooldown));
      const hits = state.dummies.filter(isAlive).filter((dummy) => distance(player, dummy) <= CONFIG.r.radius + dummy.radius);
      hits.forEach((dummy) => dealDamage(dummy, CONFIG.r.damage, { slowDuration: 1, slowRatio: 0.5 }));
      if (hits.length) addPassiveStack();

      [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4].forEach((angle) => {
        const x = player.x + Math.cos(angle) * CONFIG.r.daggerDistance;
        const y = player.y + Math.sin(angle) * CONFIG.r.daggerDistance;
        const dagger = spawnDagger(x, y);
        const lineHits = dummiesAlongLine(player, dagger, 12);
        lineHits.forEach((dummy) => {
          if (!hits.includes(dummy)) dealDamage(dummy, 72);
        });
        addEffect({ type: "line", x1: player.x, y1: player.y, x2: dagger.x, y2: dagger.y, color: "#ff3049", width: 4, life: 0.3 });
      });

      addEffect({ type: "ring", x: player.x, y: player.y, radius: CONFIG.r.radius, color: "#ec1f43", width: 18, life: 0.48 });
      log("궁극기 · 사방 단검 생성", "action");
    });
  }

  function getDTarget() {
    const player = state.player;
    const hovered = getDummyAt(state.mouse.x, state.mouse.y, 28);
    if (hovered && distance(player, hovered) <= CONFIG.d.range) return hovered;

    const attackTarget = getDummyById(player.targetId);
    if (attackTarget && isAlive(attackTarget) && distance(player, attackTarget) <= CONFIG.d.range) {
      return attackTarget;
    }

    return state.dummies
      .filter(isAlive)
      .filter((dummy) => distance(player, dummy) <= CONFIG.d.range)
      .sort((a, b) => distance(player, a) - distance(player, b))[0] || null;
  }

  function castD() {
    const player = state.player;
    if (player.dRecastUntil > state.now) {
      const target = getDTarget();
      if (!target) {
        notify("D를 다시 사용할 대상을 지정하세요.");
        log("망토와 단검 2타 대상 없음");
        return;
      }

      const start = { x: player.x, y: player.y };
      const direction = normalized(target.x - player.x, target.y - player.y);
      const destination = {
        x: clamp(target.x + direction.x * CONFIG.d.behindDistance, 20, state.width - 20),
        y: clamp(target.y + direction.y * CONFIG.d.behindDistance, 20, state.height - 20),
      };

      dealDamage(target, CONFIG.d.damage, { slowDuration: 1, slowRatio: 0.8, color: "#fff2a8" });
      player.x = destination.x;
      player.y = destination.y;
      player.facing = normalized(target.x - player.x, target.y - player.y);
      player.moveTarget = null;
      player.targetId = target.id;
      player.dRecastUntil = 0;
      startCooldown("D", CONFIG.d.cooldown);

      addEffect({ type: "line", x1: start.x, y1: start.y, x2: destination.x, y2: destination.y, color: "#fff4b0", width: 9, life: 0.24 });
      addEffect({ type: "line", x1: start.x, y1: start.y, x2: destination.x, y2: destination.y, color: "#b78d18", width: 3, life: 0.34 });
      addEffect({ type: "burst", x: target.x, y: target.y, color: "#fff2a8", radius: 34, life: 0.32 });
      log("망토와 단검 2타 · 대상 뒤로 이동", "action");
      pulseSkill("D");
      recordAction("D");
      return;
    }

    if (!canCast("D")) return;
    player.dRecastUntil = state.now + CONFIG.d.stealthDuration;
    player.targetId = null;
    addEffect({ type: "ring", x: player.x, y: player.y, radius: 44, color: "#fff1a1", width: 4, life: 0.45 });
    log("망토와 단검 1타 · 1.5초 은신", "action");
    notify("은신 중 · D를 다시 눌러 대상 뒤로 이동");
    pulseSkill("D");
    recordAction("D");
  }

  function castF() {
    if (!canCast("F")) return;

    const player = state.player;
    const start = { x: player.x, y: player.y };
    const dx = state.mouse.x - start.x;
    const dy = state.mouse.y - start.y;
    const targetDistance = Math.hypot(dx, dy);
    if (targetDistance < 1) {
      notify("블링크 방향을 지정하세요.");
      return;
    }

    const direction = normalized(dx, dy);
    const travelDistance = Math.min(CONFIG.f.range, targetDistance);
    const destination = {
      x: clamp(start.x + direction.x * travelDistance, player.radius, state.width - player.radius),
      y: clamp(start.y + direction.y * travelDistance, player.radius, state.height - player.radius),
    };

    player.x = destination.x;
    player.y = destination.y;
    player.facing = direction;
    player.spriteFacingX = direction.x < 0 ? -1 : 1;
    player.moveTarget = null;
    player.targetId = null;
    player.forcedMovement = null;
    startCooldown("F", CONFIG.f.cooldown);

    addEffect({ type: "ring", x: start.x, y: start.y, radius: 38, color: "#27bfff", width: 6, life: 0.34 });
    addEffect({ type: "line", x1: start.x, y1: start.y, x2: destination.x, y2: destination.y, color: "#30b6ff", width: 12, life: 0.18 });
    addEffect({ type: "line", x1: start.x, y1: start.y, x2: destination.x, y2: destination.y, color: "#d8f7ff", width: 3, life: 0.24 });
    addEffect({ type: "burst", x: destination.x, y: destination.y, color: "#77dcff", radius: 42, life: 0.34 });
    addEffect({ type: "ring", x: destination.x, y: destination.y, radius: 46, color: "#8ee8ff", width: 4, life: 0.4 });

    log("블링크 · 마우스 방향으로 순간이동", "action");
    pulseSkill("F");
    recordAction("F");
  }

  function resetCooldowns({ includeUltimate = true, includeUtility = true, announce = true } = {}) {
    state.cooldowns.Q = 0;
    state.cooldowns.W = 0;
    state.cooldowns.E = 0;
    if (includeUltimate) state.cooldowns.R = 0;
    if (includeUtility) {
      state.cooldowns.D = 0;
      state.cooldowns.F = 0;
    }

    if (announce) {
      const resetKeys = ["Q", "W", "E"];
      if (includeUltimate) resetKeys.push("R");
      if (includeUtility) resetKeys.push("D", "F");
      log(`${resetKeys.join(" · ")} 쿨다운 초기화`, "action");
      notify(`${resetKeys.join(" · ")} 스킬이 준비되었습니다.`);
    }
  }

  function setCooldownResetMode(enabled) {
    state.cooldownResetMode = enabled;
    const button = document.querySelector("#cooldownResetMode");
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = `쿨타임 초기화 모드: ${enabled ? "ON" : "OFF"}`;
    if (enabled) resetCooldowns({ announce: false });
    notify(`쿨타임 초기화 모드를 ${enabled ? "ON" : "OFF"}으로 변경했습니다.`);
    log(`쿨타임 초기화 모드 · ${enabled ? "ON" : "OFF"}`, "action");
  }

  function resetPractice() {
    stopHeldRightClick();
    resetCooldowns();
    state.daggers.length = 0;
    state.pendingDaggers.length = 0;
    state.projectiles.length = 0;
    state.effects.length = 0;
    state.player.passiveStacks = 0;
    state.player.passiveExpireAt = 0;
    state.player.qEmpoweredUntil = 0;
    state.player.actionLockUntil = 0;
    state.player.actionKey = null;
    state.player.actionCancelableByW = false;
    state.player.pendingSkill = null;
    state.player.forcedMovement = null;
    state.player.dRecastUntil = 0;
    state.player.targetId = null;
    state.player.moveTarget = null;
    state.player.x = state.width * 0.54;
    state.player.y = state.height * 0.56;
    state.dummies.forEach((dummy) => {
      dummy.hp = dummy.maxHp;
      dummy.damageTaken = 0;
      dummy.respawnAt = 0;
      dummy.markUntil = 0;
    });
    notify("연습 상태를 초기화했습니다.");
  }

  function recordAction(key) {
    if (!state.recording) return;
    state.recordedCombo.push({ key, time: performance.now() - state.recordStartedAt });
  }

  function startOrStopRecording(button) {
    state.recording = !state.recording;
    button.classList.toggle("active", state.recording);
    button.textContent = state.recording ? "■ 중지" : "● 녹화";
    if (state.recording) {
      state.recordedCombo = [];
      state.recordStartedAt = performance.now();
      notify("콤보 녹화를 시작합니다.");
    } else {
      notify(`${state.recordedCombo.length}개 입력을 저장했습니다.`);
    }
  }

  function executeAction(key) {
    if (key === "Q") castQ();
    else if (key === "W") castW();
    else if (key === "E") castE();
    else if (key === "R") castR();
    else if (key === "D") castD();
    else if (key === "F") castF();
    else if (key === "A") issueAttack(getNearestDummy());
    else if (key === "S") stopPlayerCommand();
    else if (key === "T") resetPractice();
  }

  function stopPlayerCommand() {
    state.player.targetId = null;
    state.player.moveTarget = null;
    stopHeldRightClick();
    log("정지 명령 · 이동 및 기본 공격 중단", "action");
  }

  function playRecordedCombo() {
    if (!state.recordedCombo.length) {
      notify("먼저 콤보를 녹화하세요.");
      return;
    }
    resetCooldowns();
    state.recordedCombo.forEach((entry) => {
      setTimeout(() => executeAction(entry.key), entry.time / state.playbackSpeed);
    });
    notify("녹화한 콤보를 재생합니다.");
  }

  function pulseSkill(key) {
    const element = skillElements.get(key);
    if (!element) return;
    element.classList.remove("pressed");
    void element.offsetWidth;
    element.classList.add("pressed");
  }

  function updatePlayer(dt) {
    const player = state.player;
    player.attackTimer = Math.max(0, player.attackTimer - dt);
    player.attackFlash = Math.max(0, player.attackFlash - dt);
    processPendingSkill();
    updateForcedMovement(dt);

    if (player.actionLockUntil <= state.now) {
      player.actionKey = null;
      player.actionCancelableByW = false;
    }

    if (player.passiveStacks > 0 && state.now >= player.passiveExpireAt) {
      player.passiveStacks = 0;
      player.passiveExpireAt = 0;
    }

    if (player.dRecastUntil > 0 && state.now >= player.dRecastUntil) {
      player.dRecastUntil = 0;
      startCooldown("D", CONFIG.d.cooldown);
      log("망토와 단검 은신 종료", "action");
    }

    if (player.actionLockUntil > state.now) return;

    const target = getDummyById(player.targetId);
    if (target && isAlive(target)) {
      const targetDistance = distance(player, target);
      if (targetDistance > CONFIG.attackRange + target.radius) {
        moveToward(target.x, target.y, dt);
      } else if (player.attackTimer <= 0) {
        performBasicAttack(target);
      }
    } else {
      player.targetId = null;
      if (player.moveTarget) {
        const remaining = moveToward(player.moveTarget.x, player.moveTarget.y, dt);
        if (remaining < 4) player.moveTarget = null;
      }
    }

    for (const dagger of [...state.daggers]) {
      if (isPlayerTouchingDagger(player, dagger)) pickUpDagger(dagger, true);
    }
  }

  function moveToward(x, y, dt) {
    const player = state.player;
    const dx = x - player.x;
    const dy = y - player.y;
    const remaining = Math.hypot(dx, dy);
    if (remaining < 0.01) return 0;
    const direction = { x: dx / remaining, y: dy / remaining };
    const step = Math.min(remaining, CONFIG.moveSpeed * dt);
    player.x += direction.x * step;
    player.y += direction.y * step;
    player.facing = direction;
    return remaining - step;
  }

  function updateDummies(dt) {
    for (const dummy of state.dummies) {
      dummy.hitFlash = Math.max(0, dummy.hitFlash - dt);
      if (dummy.hp <= 0 && state.now >= dummy.respawnAt) {
        dummy.hp = dummy.maxHp;
        dummy.respawnAt = 0;
        dummy.markUntil = 0;
        addEffect({ type: "burst", x: dummy.x, y: dummy.y, color: "#79d79d", radius: 28, life: 0.36 });
      }

      if (!state.movingDummies || !isAlive(dummy)) continue;
      dummy.wanderTimer -= dt;
      if (dummy.wanderTimer <= 0) {
        dummy.wanderTimer = 0.8 + Math.random() * 1.6;
        dummy.wanderAngle += (Math.random() - 0.5) * 2.1;
      }
      const slow = dummy.slowUntil > state.now ? dummy.slowRatio : 1;
      const speed = 58 * slow;
      dummy.x += Math.cos(dummy.wanderAngle) * speed * dt;
      dummy.y += Math.sin(dummy.wanderAngle) * speed * dt;
      if (dummy.x < 45 || dummy.x > state.width - 45) dummy.wanderAngle = Math.PI - dummy.wanderAngle;
      if (dummy.y < 45 || dummy.y > state.height - 45) dummy.wanderAngle = -dummy.wanderAngle;
      dummy.x = clamp(dummy.x, 45, state.width - 45);
      dummy.y = clamp(dummy.y, 45, state.height - 45);
    }
  }

  function updateProjectiles(dt) {
    for (let index = state.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = state.projectiles[index];
      const target = getDummyById(projectile.targetId);
      if (!target || !isAlive(target)) {
        state.projectiles.splice(index, 1);
        continue;
      }
      const direction = normalized(target.x - projectile.x, target.y - projectile.y);
      const remaining = distance(projectile, target);
      const step = projectile.speed * dt;
      if (remaining <= step + target.radius) {
        dealDamage(target, CONFIG.daggerDamage, { thrownDagger: true, color: "#ff5368" });
        if (target.markUntil > state.now) {
          state.cooldowns.E = Math.max(0, state.cooldowns.E - 1);
          log("협상 대상 단검 적중 · E 쿨다운 1초 감소", "action");
        }
        addEffect({ type: "burst", x: target.x, y: target.y, color: "#ff3049", radius: 30, life: 0.3 });
        state.projectiles.splice(index, 1);
      } else {
        projectile.x += direction.x * step;
        projectile.y += direction.y * step;
      }
    }
  }

  function updateEffects(dt) {
    for (let index = state.effects.length - 1; index >= 0; index -= 1) {
      state.effects[index].life -= dt;
      if (state.effects[index].life <= 0) state.effects.splice(index, 1);
    }
  }

  function updateCooldowns(dt) {
    for (const key of ["Q", "W", "E", "R", "D", "F"]) {
      state.cooldowns[key] = Math.max(0, state.cooldowns[key] - dt);
    }
  }

  function drawDagger(dagger) {
    const pulse = 1 + Math.sin(state.now * 5 + dagger.pulse) * 0.08;
    ctx.save();
    ctx.translate(dagger.x, dagger.y);
    ctx.strokeStyle = "rgba(35, 157, 255, .42)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 4, 48 * pulse, 25 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(16, 90, 155, .08)";
    ctx.fill();

    ctx.shadowColor = "#ff304c";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "#ff3e57";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(0, 5);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#e8e9ef";
    ctx.beginPath();
    ctx.moveTo(0, -31);
    ctx.lineTo(-5, -18);
    ctx.lineTo(5, -18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#8d1d2d";
    ctx.fillRect(-7, 3, 14, 5);
    ctx.restore();
  }

  function drawDummy(dummy) {
    const alive = isAlive(dummy);
    const alpha = alive ? 1 : 0.28;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dummy.x, dummy.y);

    if (state.player.targetId === dummy.id) {
      ctx.strokeStyle = "#e8d36c";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 12, 33, 18, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (dummy.markUntil > state.now) {
      ctx.fillStyle = "#ff334d";
      ctx.shadowColor = "#ff2945";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(0, -42);
      ctx.lineTo(7, -34);
      ctx.lineTo(0, -27);
      ctx.lineTo(-7, -34);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = dummy.hitFlash > 0 ? "#ff7882" : "#bd303b";
    ctx.strokeStyle = "#731922";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 23, 21, -0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(-8, -2, 3, 0, Math.PI * 2);
    ctx.arc(8, -2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#5c1118";
    ctx.fillRect(-7, 9, 14, 3);

    ctx.fillStyle = "#14161a";
    ctx.fillRect(-29, -34, 58, 6);
    ctx.fillStyle = "#b83845";
    ctx.fillRect(-28, -33, 56 * (dummy.infiniteHealth ? 1 : dummy.hp / dummy.maxHp), 4);
    if (dummy.infiniteHealth) {
      ctx.fillStyle = "#f4d9dc";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("∞", 0, -38);
    }
    ctx.restore();
  }

  function drawPlayer() {
    const player = state.player;
    ctx.save();
    ctx.translate(player.x, player.y);

    ctx.strokeStyle = "rgba(60, 99, 145, .32)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 12, 37, 20, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (player.qEmpoweredUntil > state.now) {
      ctx.strokeStyle = `rgba(255, 45, 70, ${0.45 + Math.sin(state.now * 8) * 0.2})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 10, 30, 16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (player.facing.x > 0.08) player.spriteFacingX = 1;
    else if (player.facing.x < -0.08) player.spriteFacingX = -1;
    ctx.scale(player.spriteFacingX > 0 ? -1 : 1, 1);
    if (shoichiSprite.complete && shoichiSprite.naturalWidth > 0) {
      ctx.imageSmoothingEnabled = false;
      ctx.filter = player.attackFlash > 0 ? "brightness(1.45)" : "none";
      ctx.globalAlpha = player.dRecastUntil > state.now ? 0.32 : 1;
      const spriteScale = Math.min(62 / shoichiSprite.naturalWidth, 68 / shoichiSprite.naturalHeight);
      const spriteWidth = shoichiSprite.naturalWidth * spriteScale;
      const spriteHeight = shoichiSprite.naturalHeight * spriteScale;
      ctx.drawImage(shoichiSprite, -spriteWidth / 2, -spriteHeight / 2, spriteWidth, spriteHeight);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = "#8d8273";
      ctx.beginPath();
      ctx.ellipse(0, 0, 17, 21, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (player.dRecastUntil > state.now) {
      ctx.save();
      ctx.fillStyle = "#fff2a8";
      ctx.font = "700 10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`은신 ${(player.dRecastUntil - state.now).toFixed(1)}`, player.x, player.y - 43);
      ctx.restore();
    }

    const stackY = player.y - 43;
    for (let index = 0; index < 5; index += 1) {
      ctx.fillStyle = index < player.passiveStacks ? "#e72b45" : "#271219";
      ctx.strokeStyle = index < player.passiveStacks ? "#ff6374" : "#6d2732";
      ctx.beginPath();
      ctx.arc(player.x - 16 + index * 8, stackY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawProjectiles() {
    for (const projectile of state.projectiles) {
      const target = getDummyById(projectile.targetId);
      const angle = target
        ? Math.atan2(target.y - projectile.y, target.x - projectile.x)
        : 0;
      ctx.save();
      ctx.translate(projectile.x, projectile.y);
      ctx.rotate(angle);

      ctx.strokeStyle = "rgba(238, 247, 255, .32)";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-25, 0);
      ctx.lineTo(-8, 0);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255, 255, 255, .72)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-20, 0);
      ctx.lineTo(-6, 0);
      ctx.stroke();

      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#f7f7f2";
      ctx.strokeStyle = "#8e98a3";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(-4, -5);
      ctx.lineTo(-9, 0);
      ctx.lineTo(-4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 5;
      ctx.fillStyle = "#c9233e";
      ctx.fillRect(-10, -4, 4, 8);
      ctx.fillStyle = "#38252a";
      ctx.fillRect(-15, -2, 6, 4);
      ctx.restore();
    }
  }

  function drawPendingDaggers() {
    for (const dagger of state.pendingDaggers) {
      const progress = clamp(dagger.elapsed / dagger.duration, 0, 1);
      const travelX = dagger.x - dagger.startX;
      const travelY = dagger.y - dagger.startY;
      const travelLength = Math.max(1, Math.hypot(travelX, travelY));
      const sideX = -travelY / travelLength;
      const sideY = travelX / travelLength;
      const positionAt = (value) => {
        const t = clamp(value, 0, 1);
        const curve = Math.sin(t * Math.PI) * dagger.curve;
        return {
          x: dagger.startX + travelX * t + sideX * curve,
          y: dagger.startY + travelY * t + sideY * curve - Math.sin(t * Math.PI) * dagger.arcHeight,
        };
      };
      ctx.save();
      ctx.translate(dagger.x, dagger.y);
      ctx.globalAlpha = 0.3 + Math.sin(state.now * 14) * 0.1;
      ctx.strokeStyle = "#ff5368";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();

      for (let trailIndex = 4; trailIndex >= 0; trailIndex -= 1) {
        const trailProgress = progress - trailIndex * 0.035;
        if (trailProgress < 0) continue;
        const position = positionAt(trailProgress);
        const isHead = trailIndex === 0;
        ctx.save();
        ctx.translate(position.x, position.y);
        ctx.rotate(trailProgress * Math.PI * 2 * dagger.spinTurns);
        ctx.globalAlpha = isHead ? 1 : (5 - trailIndex) * 0.075;
        ctx.shadowColor = isHead ? "#ff3351" : "#1c8dd5";
        ctx.shadowBlur = isHead ? 16 : 8;
        ctx.fillStyle = isHead ? "#f8e6e9" : "#ff3451";
        ctx.beginPath();
        ctx.moveTo(isHead ? 14 : 11, 0);
        ctx.lineTo(-8, -3.5);
        ctx.lineTo(-5, 3.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = isHead ? "#c51f3b" : "#218ac8";
        ctx.fillRect(-9, -4, 4, 8);
        ctx.restore();
      }

      if (progress > 0.72) {
        const anticipation = (progress - 0.72) / 0.28;
        ctx.save();
        ctx.translate(dagger.x, dagger.y);
        ctx.globalAlpha = anticipation * 0.65;
        ctx.strokeStyle = "#f2dce2";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 8 + anticipation * 24, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawEffects() {
    for (const effect of state.effects) {
      const progress = 1 - effect.life / effect.maxLife;
      const alpha = clamp(effect.life / effect.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = effect.color;
      ctx.fillStyle = effect.color;
      ctx.lineWidth = effect.width || 3;
      ctx.shadowColor = effect.color;
      ctx.shadowBlur = 10;

      if (effect.type === "line") {
        ctx.beginPath();
        ctx.moveTo(effect.x1, effect.y1);
        ctx.lineTo(effect.x2, effect.y2);
        ctx.stroke();
      } else if (effect.type === "ring") {
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, effect.radius * (0.78 + progress * 0.22), 0, Math.PI * 2);
        ctx.stroke();
      } else if (effect.type === "arc") {
        ctx.beginPath();
        ctx.arc(effect.x1, effect.y1, effect.radius * 0.72, effect.angle - 0.4, effect.angle + 0.4);
        ctx.stroke();
      } else if (effect.type === "burst") {
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, effect.radius * progress, 0, Math.PI * 2);
        ctx.stroke();
      } else if (effect.type === "text") {
        ctx.shadowBlur = 4;
        ctx.font = "700 14px Pretendard, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(effect.text, effect.x, effect.y - progress * 28);
      }
      ctx.restore();
    }
  }

  function drawCursor() {
    const hoveredDummy = getDummyAt(state.mouse.x, state.mouse.y, 14);
    const hoveredDagger = [...state.daggers, ...state.pendingDaggers]
      .find((dagger) => distance(state.mouse, dagger) < 35);
    ctx.save();
    ctx.translate(state.mouse.x, state.mouse.y);
    ctx.strokeStyle = hoveredDummy || hoveredDagger ? "#ffda68" : "rgba(130, 170, 215, .75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, hoveredDummy || hoveredDagger ? 12 : 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-15, 0);
    ctx.lineTo(-7, 0);
    ctx.moveTo(7, 0);
    ctx.lineTo(15, 0);
    ctx.moveTo(0, -15);
    ctx.lineTo(0, -7);
    ctx.moveTo(0, 7);
    ctx.lineTo(0, 15);
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, state.width, state.height);
    drawEffects();
    drawPendingDaggers();
    state.daggers.forEach(drawDagger);
    state.dummies.forEach(drawDummy);
    drawProjectiles();
    drawPlayer();
    drawCursor();
  }

  function updateSkillHud() {
    for (const key of ["Q", "W", "E", "R", "D", "F"]) {
      const element = skillElements.get(key);
      const mask = element.querySelector(".cooldown-mask");
      const remaining = state.cooldowns[key];
      element.classList.toggle("cooling", remaining > 0);
      mask.textContent = remaining >= 10 ? Math.ceil(remaining) : remaining.toFixed(1);
    }
    const qElement = skillElements.get("Q");
    const qEmpoweredRemaining = Math.max(0, state.player.qEmpoweredUntil - state.now);
    const qEmpowered = qEmpoweredRemaining > 0;
    qElement.classList.toggle("empowered", qEmpowered);
    const qTimerBorder = qElement.querySelector(".q-empower-timer rect");
    const qTimerProgress = clamp(qEmpoweredRemaining / 10, 0, 1);
    qTimerBorder.style.strokeDasharray = `${(qTimerProgress * 100).toFixed(2)} 100`;
    skillElements.get("D").classList.toggle("recast", state.player.dRecastUntil > state.now);
  }

  function frame(timestamp) {
    const dt = Math.min(0.034, Math.max(0, (timestamp - state.lastTime) / 1000));
    state.lastTime = timestamp;
    state.now += dt;

    updateCooldowns(dt);
    updatePlayer(dt);
    updateDummies(dt);
    updatePendingDaggers(dt);
    updateProjectiles(dt);
    updateEffects(dt);
    updateSkillHud();
    render();
    requestAnimationFrame(frame);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const oldWidth = state.width || rect.width;
    const oldHeight = state.height || rect.height;
    state.width = rect.width;
    state.height = rect.height;
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    if (state.player.x === 0) {
      state.player.x = state.width * 0.54;
      state.player.y = state.height * 0.56;
      state.mouse.x = state.width * 0.5;
      state.mouse.y = state.height * 0.5;
      spawnDummy(state.width * 0.5, state.height * 0.49);
    } else {
      const sx = state.width / oldWidth;
      const sy = state.height / oldHeight;
      state.player.x *= sx;
      state.player.y *= sy;
      state.dummies.forEach((dummy) => { dummy.x *= sx; dummy.y *= sy; });
      state.daggers.forEach((dagger) => { dagger.x *= sx; dagger.y *= sy; });
    }
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function updateRightClickCommand(point, showMarker = false) {
    const dummy = getDummyAt(point.x, point.y, 10);
    if (dummy) {
      if (state.player.targetId !== dummy.id) issueAttack(dummy);
      return;
    }

    state.player.targetId = null;
    state.player.moveTarget = { x: point.x, y: point.y };
    if (showMarker) {
      addEffect({ type: "ring", x: point.x, y: point.y, radius: 16, color: "#55b6ff", width: 2, life: 0.35 });
    }
  }

  canvas.addEventListener("pointermove", (event) => {
    state.mouse = canvasPoint(event);
    if (state.rightMouseHeld && event.pointerId === state.rightPointerId) {
      updateRightClickCommand(state.mouse);
    }
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("pointerdown", (event) => {
    const point = canvasPoint(event);
    state.mouse = point;
    if (state.placingDummy && event.button === 0) {
      spawnDummy(point.x, point.y);
      state.placingDummy = false;
      canvas.style.cursor = "crosshair";
      notify("연습용 더미를 생성했습니다.");
      return;
    }
    if (event.button !== 2) return;
    event.preventDefault();
    state.rightMouseHeld = true;
    state.rightPointerId = event.pointerId;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 합성 이벤트 등 포인터 캡처가 불가능한 입력도 이동 명령은 처리한다.
    }
    updateRightClickCommand(point, true);
  });

  function stopHeldRightClick(event) {
    if (event && event.button !== undefined && event.button !== 2) return;
    if (event && state.rightPointerId !== null && event.pointerId !== state.rightPointerId) return;
    const pointerId = state.rightPointerId;
    state.rightMouseHeld = false;
    state.rightPointerId = null;
    if (pointerId !== null && canvas.hasPointerCapture?.(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  }

  canvas.addEventListener("pointerup", stopHeldRightClick);
  canvas.addEventListener("pointercancel", stopHeldRightClick);
  canvas.addEventListener("lostpointercapture", () => {
    state.rightMouseHeld = false;
    state.rightPointerId = null;
  });
  window.addEventListener("blur", () => stopHeldRightClick());

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const key = event.key.toUpperCase();
    if (!["Q", "W", "E", "R", "D", "F", "A", "S", "T"].includes(key)) return;
    event.preventDefault();
    executeAction(key);
  });

  skillElements.forEach((element, key) => {
    element.addEventListener("click", () => executeAction(key));
  });

  document.querySelectorAll(".option-title").forEach((title) => {
    title.addEventListener("click", () => title.closest(".option-panel").classList.toggle("collapsed"));
  });

  document.querySelectorAll("[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const delta = Number(button.dataset.delta);
      if (button.dataset.step === "cooldown") {
        state.cooldownInput = clamp(state.cooldownInput + delta, 0, 100);
        document.querySelector("#cooldownValue").textContent = state.cooldownInput;
        document.querySelector("#reductionValue").textContent = Math.round(state.cooldownInput * 0.7);
      } else {
        state.attackSpeed = clamp(state.attackSpeed + delta, 0.1, 3);
        document.querySelector("#attackSpeedValue").textContent = state.attackSpeed.toFixed(2);
      }
    });
  });

  document.querySelector("#spawnDummy").addEventListener("click", () => {
    state.placingDummy = true;
    canvas.style.cursor = "copy";
    notify("연습장에서 더미를 배치할 위치를 클릭하세요.");
  });

  document.querySelector("#removeDummy").addEventListener("click", () => {
    state.dummies.length = 0;
    state.player.targetId = null;
    log("모든 더미 삭제");
    notify("더미를 삭제했습니다.");
  });

  document.querySelector("#cooldownResetMode").addEventListener("click", () => {
    setCooldownResetMode(!state.cooldownResetMode);
  });
  document.querySelector("#movingDummy").addEventListener("change", (event) => {
    state.movingDummies = event.currentTarget.checked;
    notify(state.movingDummies ? "이동 더미를 활성화했습니다." : "이동 더미를 비활성화했습니다.");
  });

  document.querySelector("#recordCombo").addEventListener("click", (event) => startOrStopRecording(event.currentTarget));
  document.querySelector("#playCombo").addEventListener("click", playRecordedCombo);
  document.querySelector("#shareCombo").addEventListener("click", () => {
    if (!state.recordedCombo.length) {
      notify("공유할 콤보가 없습니다.");
      return;
    }
    const code = btoa(JSON.stringify(state.recordedCombo));
    window.prompt("콤보 공유 코드", code);
  });
  document.querySelector("#settings").addEventListener("click", () => notify("주요 설정은 현재 패널에서 바로 조절할 수 있습니다."));

  document.querySelectorAll(".speed-row button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".speed-row button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.playbackSpeed = Number(button.textContent.replace("x", ""));
    });
  });

  document.querySelectorAll(".guide-row button").forEach((button) => {
    button.addEventListener("click", () => notify(`${button.textContent} 가이드 표시는 다음 단계에서 연결합니다.`));
  });

  window.addEventListener("resize", resize);
  resize();
  log("우클릭으로 이동할 수 있습니다.", "system");
  log("적 우클릭 또는 A로 기본 공격", "system");
  window.__shoichiGame = {
    state,
    executeAction,
    resetPractice,
    resetCooldowns,
    spawnDummy,
    spawnDagger,
    finishPendingDaggers,
    updateSkillHud,
    flushPendingSkill(keepRecoveryLock = false) {
      const pending = state.player.pendingSkill;
      if (pending) {
        state.player.pendingSkill = null;
        pending.execute();
      }
      if (!keepRecoveryLock) {
        finishForcedMovement();
        state.player.actionLockUntil = state.now;
        state.player.actionKey = null;
        state.player.actionCancelableByW = false;
      }
    },
    setMouse(x, y) {
      state.mouse.x = x;
      state.mouse.y = y;
    },
  };
  requestAnimationFrame(frame);
})();
