// Hive — the game-feel command view (ported from romp-hive plans/hive.md): a 3D honeycomb,
// one hex pad + one little character per session, acting out that session's live state.
// The scene is built ONCE and then mutated only by the model's diff events, never rebuilt
// per push, so nothing here can flap without new information.
//
// The world is TRON — near-black glossy ground with a faint accent grid, pads as dark slabs
// whose status color is their glowing rim, bloom doing the neon work — and the characters
// are CUTE AND BLOBBY: session-colored bean bodies with squash-and-stretch, dark glossy
// visors, glowing eyes, stubby arms. All geometry procedural; no runtime assets.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { delegate } from "./actions";
import { assignSlots, axialToXZ, frameDt, frameRadius, HEX_SIZE, hexCorner, hexDistance, latticeSegments, PAD_R, PAD_THETA, RIM_THETA, ringOf, slotOfAxial, spiralSlot, xzToAxial } from "./hive-layout";
import { diffSessions, finishedLine, foldEnding, foldSeenAsk, foldSeenDone, hiveAge, isFaded, isKnownState, stateLine, type HiveSession, type SeenDone } from "./hive-model";
import { backOut, cycleBeat, popOut, springStep } from "./motion";
import type { ClientOp, Defaults, ModelChoice, ShelfItem } from "../server/proto";

// what the world needs from the page around it — the whole outside contract
export interface Bridge {
  op(o: ClientOp): void;                 // fire an op at the server
  openChat(sid: string): void;           // reveal the chat dock on this session
  closeChat(): void;                     // a clean click on empty ground dismisses it
}

// ── status palette. WebGL can't read CSS vars, so the values are pinned here; the romp
//    accent #9cd2ff is reserved for selection/hover chrome, never status. A state outside
//    the vocabulary gets the pale UNKNOWN treatment — visible, never coerced. ─────────────
const ST: Record<string, number> = {
  working: 0xe0b020,     // gold — actively in a turn
  ready: 0x2b7fb8,       // calm blue — idle, nothing owed
  awaiting: 0xc0392b,    // needs YOU: a live permission/question prompt
  blocked: 0xe5484d,     // alarm red — stopped on an error
  retrying: 0xe08020,    // amber — riding an api-retry storm
  awaitingBg: 0x54b204,  // green — idle main thread, waiting on background work
  compacting: 0x14b8a6,  // teal — context operation in flight
  clearing: 0x14b8a6,
  interrupting: 0x8a8a8a,
  opening: 0x9aa0a6,     // pale — CLI still coming up
};
const UNKNOWN_ST = 0xd8dee8;             // a state hive doesn't know: pale steel + the ? bubble
function stColor(state: string): number { return ST[state] ?? UNKNOWN_ST; }

const ACCENT = 0x9cd2ff;
const PAD_H = 0.06;           // a hair of thickness so a lifted tile isn't paper
// The nameplate is written flat ON the tile, map-label style, sized to FIT ITS CELL — so a
// name can geometrically never leave its hex or pile onto a neighbour's. Fit math against
// the cell: across-flats width √3·HEX_SIZE ≈ 3.55 ≥ LABEL_W_MAX, and the plate's far edge
// LABEL_FRONT + LABEL_H/2 = 1.12 stays inside the apothem (≈ 1.78).
const LABEL_W_MAX = 2.7;
const LABEL_H = 0.4;
const LABEL_FRONT = 0.92;     // parked in the camera-side half of the cell, clear of the bean
const CARRY_Y = 1.05;         // the flat plane a carried bean rides — parallel to the board,
                              // so cursor→bean stays projectively exact anywhere on screen
const WORLD_BG = 0x090b10;

// exponential smoothing toward a target — frame-rate independent; `rate`/s is the snap speed
function ease(cur: number, target: number, dt: number, rate: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

// one thin hex outline in the XZ plane (hexCorner — the corners the prism uses), for a
// LineLoop: THE line treatment of the board. Per-instance so Pad.dispose() can dispose it.
function hexLineGeo(r: number): THREE.BufferGeometry {
  const pos = new Float32Array(18);
  for (let k = 0; k < 6; k++) {
    const c = hexCorner(0, 0, r, k);
    pos[k * 3] = c.x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = c.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

// ── one session's pad: hex prism + status ring + label + its dweller ─────────────────────
class Pad {
  group = new THREE.Group();
  private padMesh: THREE.Mesh;
  private ring: THREE.LineLoop;
  private ringMat: THREE.LineBasicMaterial;
  private sonar: THREE.LineLoop;
  private sonarMat: THREE.LineBasicMaterial;
  private labelYaw = new THREE.Group();     // yaws to face the camera; the nameplate rides its +z
  private labelMesh: THREE.Mesh;
  private bang: THREE.Sprite;              // the ❗ that bobs over a needs-you pad
  private tick: THREE.Sprite;              // the ✓ held up over an unseen-finished pad
  private quest: THREE.Sprite;             // the ? over a pad in a state hive doesn't know
  unseenDone = false;                       // finished work the user hasn't gone to look at
  // a FILED ask the user has already looked at: the ring keeps its honest red but the
  // SHOUT (bang/sonar/wave) stops. A live prompt is never acked (always now).
  private askAck = false;
  private guy: Dweller;
  carrier = new THREE.Group();              // rides the pointer while the user carries them
  private carryTarget: THREE.Vector3 | null = null;
  private carryWant = new THREE.Vector3(); // scratch — no per-frame allocation
  private homeX = 0; private homeZ = 0;    // the pad's cell — eased toward, so a re-home GLIDES
  lift = 0;                                 // hover/press target offset, eased in update()
  hover = false;                            // under the pointer: the selector ring answers
  portrait = false;                         // the close-up subject: face the viewer
  private liftCur = 0;
  private selMat: THREE.LineBasicMaterial;  // the Switch-style accent selector outline
  private sel: THREE.LineLoop;
  private ringColor = new THREE.Color(ST.ready);
  private ringTarget = new THREE.Color(ST.ready);
  private t = Math.random() * 100;          // free-running clock, de-synced per pad
  private spawnT = 0;                       // 0→1 arrival pop
  dyingT = -1;                              // ≥0 → departure animation clock
  sess: HiveSession;

  private fadedCur = false;                 // dozing, derived per frame from lastT

  constructor(sess: HiveSession, slot: number) {
    this.sess = sess;
    const { x, z } = axialToXZ(spiralSlot(slot), HEX_SIZE);
    this.group.position.set(x, 0, z);
    this.homeX = x; this.homeZ = z;

    const tint = new THREE.Color(sess.color?.bg || "#8a8a8a");
    // Tron slab: near-black glossy top with only a whisper of the identity color; the
    // pad's LIGHT is its rim. CylinderGeometry with 6 radial segments IS the hex prism;
    // PAD_THETA turns an edge (not a corner) toward each axial neighbour, so flush
    // neighbours meet edge-to-edge.
    const top = new THREE.Color(0x0e1116).lerp(tint, 0.06);
    const side = new THREE.Color(0x080a0d).lerp(tint, 0.03);
    const geo = new THREE.CylinderGeometry(PAD_R, PAD_R * 1.04, PAD_H, 6, 1, false, PAD_THETA);
    this.padMesh = new THREE.Mesh(geo, [
      new THREE.MeshStandardMaterial({ color: side, roughness: 0.55, metalness: 0.35 }),
      new THREE.MeshStandardMaterial({ color: top, roughness: 0.3, metalness: 0.45 }),
      new THREE.MeshStandardMaterial({ color: side, roughness: 0.55, metalness: 0.35 }),
    ]);
    this.padMesh.position.y = PAD_H / 2;
    this.group.add(this.padMesh);

    // the status LIGHT: ONE thin neon line tracing the cell's EXACT boundary — the same
    // corners (hexCorner) and radius the lattice draws, so a used cell's walls ARE segments
    // of the shared web. Where two live sessions share a wall the additive lines blend.
    // Bloom does the glow; no halo, no thickness.
    this.ringMat = new THREE.LineBasicMaterial({
      color: stColor(sess.state), transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.ring = new THREE.LineLoop(hexLineGeo(PAD_R), this.ringMat);
    this.ring.position.y = PAD_H + 0.012;
    this.group.add(this.ring);

    // sonar ping: an expanding, fading copy of the line — the needs-you beacon (awaiting only)
    this.sonarMat = new THREE.LineBasicMaterial({
      color: ST.awaiting, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sonar = new THREE.LineLoop(hexLineGeo(PAD_R), this.sonarMat);
    this.sonar.position.y = this.ring.position.y;
    this.group.add(this.sonar);

    // the SELECTOR: a second hex outline a hair outside the status ring, in the accent —
    // the one "this is where your hand is" treatment (pulsing on hover, steady on the
    // portrait subject). Accent for selection chrome only, never status.
    this.selMat = new THREE.LineBasicMaterial({
      color: ACCENT, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sel = new THREE.LineLoop(hexLineGeo(PAD_R * 1.05), this.selMat);
    this.sel.position.y = PAD_H + 0.03;
    this.group.add(this.sel);

    this.labelMesh = makeNameDecal(sess.name, sess.color?.bg || "#cccccc");
    this.labelMesh.position.z = LABEL_FRONT;
    this.labelYaw.position.y = PAD_H + 0.02;
    this.labelYaw.add(this.labelMesh);
    this.group.add(this.labelYaw);

    this.bang = makeTextSprite("!", "#ffffff", "#c0392b");
    this.bang.position.y = 2.05;             // floats over the bean — the one deliberate float
    this.bang.visible = false;
    this.group.add(this.bang);

    // the finished note: the done-check (white ✓ on #1EA1EB) held up like the bang, but
    // calm. Shown only while the session sits ready with a completion the user hasn't
    // looked at: the one-shot confetti marks the MOMENT; this holds the FACT until their
    // own click clears it. Needs-you outranks it by construction.
    this.tick = makeTextSprite("✓", "#ffffff", "#1EA1EB");
    this.tick.position.y = 2.05;
    this.tick.visible = false;
    this.group.add(this.tick);

    // the unknown-state note: a quiet ? in the bang's spot — the pad's state string is not
    // in this app's vocabulary (fail loudly; the tip/card show the raw value verbatim)
    this.quest = makeTextSprite("?", "#ffffff", "#5a6472");
    this.quest.position.y = 2.05;
    this.quest.visible = false;
    this.group.add(this.quest);

    this.guy = new Dweller(sess.color?.bg || "#9cd2ff");
    this.guy.group.position.y = PAD_H;
    // the CARRIER wraps the dweller: the bean's own animation moves guy.group, a user
    // drag moves the carrier — so picking them up never fights the idle animation
    this.carrier.add(this.guy.group);
    this.group.add(this.carrier);
    this.fadedCur = isFaded(sess, Math.floor(Date.now() / 1000));
    this.guy.setState(this.guyState(), this.fadedCur);
    this.guy.setDuty(!!sess.duty);

    // one flat pick list per pad, tagged for the world's single-raycast hover
    this.padMesh.userData = { sid: sess.sid, kind: "pad" };
    this.guy.hit.userData = { sid: sess.sid, kind: "bean" };
    this.labelMesh.userData = { sid: sess.sid, kind: "name" };

    this.group.scale.setScalar(0.001);      // arrival pop plays from ~zero
    this.ringColor.setHex(stColor(sess.state));
    this.ringTarget.setHex(stColor(sess.state));
  }

  dozing(): boolean { return this.fadedCur; }
  pickTargets(): THREE.Object3D[] { return [this.guy.hit, this.labelMesh, this.padMesh]; }

  // the pose the bean acts out: an ACKNOWLEDGED filed ask stands calm (ready) under its red
  // ring — the wave is part of the shout, and the shout is for unseen needs-you only
  private guyState(): string {
    return this.sess.state === "awaiting" && this.askAck ? "ready" : this.sess.state;
  }

  // the user's look (or a new filed ask) flips the shout without any chip state change
  setAskAck(ack: boolean) {
    if (this.askAck === ack) return;
    this.askAck = ack;
    if (this.sess.state === "awaiting") this.guy.setState(this.guyState(), this.fadedCur);
  }

  // a real state/name change arrived (diff event) — retarget; update() animates the morph.
  // Returns true when the pick list changed (a rebuilt nameplate), so the world re-lists.
  apply(sess: HiveSession, stateChanged: boolean): boolean {
    const prevName = this.sess.name, prevColor = this.sess.color?.bg;
    this.sess = sess;
    this.guy.setDuty(!!sess.duty);
    if (stateChanged) {
      this.ringTarget.setHex(stColor(sess.state));
      this.guy.setState(this.guyState(), this.fadedCur);
    }
    if (sess.name !== prevName || sess.color?.bg !== prevColor) {
      this.labelYaw.remove(this.labelMesh);
      disposeDecal(this.labelMesh);
      this.labelMesh = makeNameDecal(sess.name, sess.color?.bg || "#cccccc");
      this.labelMesh.position.z = LABEL_FRONT;
      this.labelMesh.userData = { sid: sess.sid, kind: "name" };
      this.labelYaw.add(this.labelMesh);
      return true;
    }
    return false;
  }

  pokeBean() { this.guy.poke(); }
  wave() { this.guy.greet(); }

  // the nameplate is a click target (board rename) only when actually readable — an
  // invisible plate must never be a secret button, and hover already fades it in
  nameVisible(): boolean {
    return this.labelMesh.visible && (this.labelMesh.material as THREE.MeshBasicMaterial).opacity > 0.5;
  }
  setNameHidden(h: boolean) { this.labelMesh.visible = !h; }
  labelWorldPos(): THREE.Vector3 { return this.labelMesh.getWorldPosition(new THREE.Vector3()); }

  // world-space carry target while the user drags them; null → spring home (update() eases)
  carryTo(p: THREE.Vector3 | null) { this.carryTarget = p ? p.clone() : null; }
  // move the pad's HOME to another cell (drag-to-re-home); update() glides it
  homeTo(x: number, z: number) { this.homeX = x; this.homeZ = z; }
  beanWorldPos(): THREE.Vector3 { return this.carrier.getWorldPosition(new THREE.Vector3()); }
  beanWorldPosInto(v: THREE.Vector3): THREE.Vector3 { return this.carrier.getWorldPosition(v); }
  consumeBean() {
    this.guy.group.visible = false;
    this.carrier.position.set(0, 0, 0);
    this.carryTarget = null;
  }

  update(dt: number, camYaw: number, camDist: number, focus: boolean): boolean {
    this.t += dt;
    // map-label behavior: the plate faces the camera in yaw and FADES with altitude —
    // zoomed out, the board is shapes and colors; zoom in (or hover/select) to read names.
    // Never scaled up: an inflated label is how billboards pile into fog.
    this.labelYaw.rotation.y = camYaw;
    const lmat = this.labelMesh.material as THREE.MeshBasicMaterial;
    lmat.opacity = ease(lmat.opacity, focus ? 1 : Math.min(1, Math.max(0, (42 - camDist) / 12)), dt, 10);
    if (this.spawnT < 1) {
      this.spawnT = Math.min(1, this.spawnT + dt / 0.5);
      const s = this.spawnT;
      const overshoot = 1 + 0.28 * Math.sin(s * Math.PI) * (1 - s);   // pop past 1, settle back
      this.group.scale.setScalar(Math.max(0.001, s * overshoot));
    }
    if (this.dyingT >= 0) {
      // departure: a small farewell hop, then sink through the floor and fade
      this.dyingT += dt;
      const d = this.dyingT;
      this.group.position.y = d < 0.25 ? Math.sin(d / 0.25 * Math.PI) * 0.3 : -(d - 0.25) * 2.2;
      const sc = Math.max(0.001, 1 - Math.max(0, d - 0.25) * 1.1);
      this.group.scale.setScalar(sc);
      return d > 1.15;                      // done → caller disposes
    }
    this.liftCur = ease(this.liftCur, this.lift, dt, 14);
    this.group.position.y = this.liftCur;
    // the tile glides to its home cell (a re-home moves it; at rest this is a no-op)
    this.group.position.x = ease(this.group.position.x, this.homeX, dt, 10);
    this.group.position.z = ease(this.group.position.z, this.homeZ, dt, 10);

    // carried: the bean rides the pointer (world target → pad-local); released, it
    // springs home — the same everything-springs rule as the rest of the board
    if (this.carryTarget) this.carryWant.copy(this.carryTarget).sub(this.group.position);
    else this.carryWant.set(0, 0, 0);
    this.carrier.position.lerp(this.carryWant, 1 - Math.exp(-30 * dt));   // tight to the hand
    // juice: carried beans grow a size, hovered beans lean in a touch
    const cs = this.carryTarget ? 1.12 : this.hover ? 1.05 : 1;
    this.carrier.scale.x = ease(this.carrier.scale.x, cs, dt, 12);
    this.carrier.scale.y = this.carrier.scale.z = this.carrier.scale.x;
    // the selector: a gentle pulse under the pointer, a steady presence on the portrait
    const selTarget = this.hover ? 0.42 + 0.22 * (0.5 + 0.5 * Math.sin(this.t * 4.6))
      : this.portrait ? 0.3 : 0;
    this.selMat.opacity = ease(this.selMat.opacity, selTarget, dt, 14);

    this.ringColor.lerp(this.ringTarget, 1 - Math.exp(-8 * dt));
    // a 1px line carries less light than a fat rim, so overdrive the color past 1 —
    // that's what pushes it over the bloom threshold into neon
    this.ringMat.color.copy(this.ringColor).multiplyScalar(1.6);
    const st = this.sess.state;
    // pulse only the states that are genuinely in motion; steady states hold steady
    if (st === "working") this.ringMat.opacity = 0.62 + 0.3 * (0.5 + 0.5 * Math.sin(this.t * 3.6));
    else if (st === "awaiting" && !this.askAck) this.ringMat.opacity = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.t * 7));
    else if (st === "retrying") this.ringMat.opacity = 0.5 + 0.5 * (Math.sin(this.t * 11) > 0.2 ? 1 : 0.35);
    else this.ringMat.opacity = 0.95;

    if (st === "awaiting" && !this.askAck) {
      // the SHOUT — sonar ping (1.4s loop, ring swells ~1.8× and fades, visible from any
      // zoom) + the bobbing ❗ — is for needs-you the user hasn't seen. Once looked at,
      // the red ring alone carries the standing fact.
      const p = (this.t % 1.4) / 1.4;
      this.sonarMat.opacity = (1 - p) * 0.5;
      this.sonar.scale.setScalar(1 + p * 0.85);
      this.bang.visible = true;
      this.bang.position.y = 2.05 + 0.14 * Math.abs(Math.sin(this.t * 5));
    } else {
      this.sonarMat.opacity = 0;
      this.bang.visible = false;
    }
    // the finished note holds only over a READY pad: a new turn hides it (working again),
    // needs-you replaces it (the bang), and the user's own click retires it for good
    this.tick.visible = st === "ready" && this.unseenDone;
    if (this.tick.visible) this.tick.position.y = 2.05 + 0.07 * Math.sin(this.t * 2.1);
    // the unknown-state note: quiet, steady — the ? is a fact, not a shout
    this.quest.visible = !isKnownState(st);
    if (this.quest.visible) this.quest.position.y = 2.05 + 0.05 * Math.sin(this.t * 1.6);
    // dozing derives from lastT right here, per frame — the bean nods off (and wakes)
    // the moment its own clock crosses the line, no push or timer involved
    const faded = isFaded(this.sess, Date.now() / 1000);
    if (faded !== this.fadedCur) {
      this.fadedCur = faded;
      this.guy.setState(this.guyState(), faded);
    }
    this.guy.update(dt, this.t, camYaw);
    // the portrait subject looks at YOU — whatever its pose, the face finds the camera
    if (this.portrait) this.guy.group.rotation.y = camYaw;
    return false;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { const t = (mat as THREE.MeshBasicMaterial).map; if (t) t.dispose(); mat.dispose(); }
    });
  }
}

// ── the bean: cute and blobby. A lathe-profile bean in the session's identity color, dark
//    glossy visor with big glowing eyes, stubby nub arms, squash-and-stretch on every
//    landing. The TORSO group pivots at the feet so leans read as body language. ──────────
class Dweller {
  group = new THREE.Group();
  private torso = new THREE.Group();        // feet-pivot: body + face + arms live here
  private body: THREE.Mesh;
  private bodyMat: THREE.MeshStandardMaterial;
  private face: THREE.Mesh;
  private eyeL: THREE.Mesh; private eyeR: THREE.Mesh;
  private armL: THREE.Mesh; private armR: THREE.Mesh;
  hit!: THREE.Mesh;                         // invisible click body — see the ctor
  private aura: THREE.Mesh;                 // compacting swirl marker, recolored per state
  private auraMat: THREE.MeshBasicMaterial;
  private orb!: THREE.Mesh;                 // awaitingBg: spinning gem overhead
  private orbMat!: THREE.MeshBasicMaterial;
  private desk: THREE.Group;                // tiny desk + glowing laptop — the "working" silhouette
  private hat: THREE.Group;                 // the hard-hat: this bean holds a standing duty
  private screenMat: THREE.MeshStandardMaterial;
  private state: string = "ready";
  private faded = false;
  private blinkAt = 2 + Math.random() * 4;
  private blinkT = -1;
  private phase = Math.random() * Math.PI * 2;
  private baseColor: THREE.Color;
  private pop = 0;                          // hatch flourish clock (opening → live)
  private greetT = 0;                       // greeting-wave clock (portrait open)
  private squash = 1;                       // landing squash factor, springs back to 1
  private prevY = 0;
  private paceYaw = Math.PI / 2;            // retrying waddle heading — eased, so turns SKID
  private paceDir = 1;
  private cheerT = 0;                       // goal-done celebration clock
  private perkT = 0;                        // hover notice: eyes widen for a beat
  private carried: "no" | "held" | "scared" = "no";
  private leanX = 0; private leanZ = 0;     // carried dangle — feet trailing the hand
  proud = false;                            // unseen finished work: stand tall, hop for joy
  landed = false;                           // a real touchdown — the world turns it into dust

  constructor(tint: string) {
    this.baseColor = new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 0.1);
    // the suit self-lights a little (Tron creature), so beans stay cute against the dark
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: this.baseColor.clone(), roughness: 0.45, metalness: 0.1,
      emissive: this.baseColor.clone(), emissiveIntensity: 0.22,
    });
    // the bean silhouette: chubby low waist, rounded shoulders, narrow rounded crown
    const prof: [number, number][] = [
      [0.001, 0], [0.30, 0.03], [0.42, 0.14], [0.475, 0.32], [0.48, 0.52],
      [0.44, 0.72], [0.375, 0.90], [0.29, 1.04], [0.18, 1.13], [0.001, 1.17],
    ];
    this.body = new THREE.Mesh(
      new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 26),
      this.bodyMat,
    );
    this.torso.add(this.body);
    // dark glossy visor sunk into the front, with two GLOWING eyes inside it — bloom
    // turns them into the character's light
    this.face = new THREE.Mesh(
      new THREE.SphereGeometry(0.27, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.15, metalness: 0.6 }),
    );
    this.face.scale.set(1, 1.28, 0.45);
    this.face.position.set(0, 0.78, 0.29);
    this.torso.add(this.face);
    const mkEye = () => new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xdff1ff }),
    );
    this.eyeL = mkEye(); this.eyeR = mkEye();
    this.eyeL.position.set(-0.095, 0.83, 0.405);
    this.eyeR.position.set(0.095, 0.83, 0.405);
    this.torso.add(this.eyeL, this.eyeR);
    const armGeo = new THREE.CapsuleGeometry(0.085, 0.2, 4, 10);
    armGeo.translate(0, -0.12, 0);          // hang from the shoulder joint, so rotation swings
    this.armL = new THREE.Mesh(armGeo, this.bodyMat);
    this.armR = new THREE.Mesh(armGeo, this.bodyMat);
    this.armL.position.set(-0.44, 0.72, 0.05);
    this.armR.position.set(0.44, 0.72, 0.05);
    this.armL.rotation.z = 0.35; this.armR.rotation.z = -0.35;
    this.torso.add(this.armL, this.armR);
    this.group.add(this.torso);

    // the bean's HIT BODY: an invisible capsule over the whole character, so clicking THEM
    // is easy — colorWrite:false draws nothing but still raycasts. Clicking the bean is
    // the direct line to their chat.
    this.hit = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.55, 0.55, 4, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    this.hit.position.y = 0.62;
    this.group.add(this.hit);

    this.auraMat = new THREE.MeshBasicMaterial({ color: ST.compacting, transparent: true, opacity: 0 });
    this.aura = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.035, 6, 24), this.auraMat);
    this.aura.position.y = 0.66;
    this.aura.rotation.x = Math.PI / 2.4;
    this.group.add(this.aura);
    // the awaitingBg marker: a little hourglass-ish gem spinning overhead — "my work is
    // out there running" — green like its status
    this.orbMat = new THREE.MeshBasicMaterial({ color: ST.awaitingBg, transparent: true, opacity: 0 });
    this.orb = new THREE.Mesh(new THREE.OctahedronGeometry(0.1), this.orbMat);
    this.orb.position.y = 1.55;
    this.group.add(this.orb);

    // the desk: tabletop + laptop with an emissive screen, parked in front of the bean;
    // shown only while working (the strongest one-glance "busy" silhouette there is)
    this.desk = new THREE.Group();
    const slab = new THREE.MeshStandardMaterial({ color: 0x141920, roughness: 0.35, metalness: 0.5 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.05, 0.42), slab);
    top.position.y = 0.5;
    this.desk.add(top);
    // a hairline of accent light along the desk's front edge — the Tron detail line
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.012, 0.012),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    edge.position.set(0, 0.527, 0.21);
    this.desk.add(edge);
    for (const [lx, lz] of [[-0.34, -0.16], [0.34, -0.16], [-0.34, 0.16], [0.34, 0.16]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), slab);
      leg.position.set(lx, 0.25, lz);
      this.desk.add(leg);
    }
    const shell = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.4, metalness: 0.3 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 0.24), shell);
    base.position.set(0, 0.535, 0.02);
    this.screenMat = new THREE.MeshStandardMaterial({
      color: 0x10151c, roughness: 0.3, emissive: 0x9fd8ff, emissiveIntensity: 0.9,
    });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.015), this.screenMat);
    screen.position.set(0, 0.65, 0.13);
    screen.rotation.x = -0.22;
    this.desk.add(base, screen);
    this.desk.position.set(0, 0, 0.58);
    this.desk.rotation.y = Math.PI;         // screen faces the bean
    this.desk.visible = false;
    this.group.add(this.desk);

    // the hard-hat: a bean with a standing duty wears it — one glance says "on the job".
    // Rides the TORSO so leans and squash carry it like a worn thing, not a decal.
    this.hat = new THREE.Group();
    const hatMat = new THREE.MeshStandardMaterial({
      color: 0xf4c430, roughness: 0.35, metalness: 0.2,
      emissive: 0xf4c430, emissiveIntensity: 0.12,
    });
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.335, 0.035, 18), hatMat);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.235, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
    dome.position.y = 0.012;
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.4), hatMat);
    ridge.position.y = 0.2;
    this.hat.add(brim, dome, ridge);
    this.hat.position.set(0, 1.12, -0.02);
    this.hat.rotation.x = 0.06;
    this.hat.visible = false;
    this.torso.add(this.hat);
  }

  setDuty(on: boolean) { this.hat.visible = on; }

  setState(s: string, faded: boolean) {
    if (this.state === "opening" && s !== "opening") {
      this.pop = 0.45;                       // hatched! — one pop, then normal life
      this.bodyMat.color.copy(this.baseColor);
    }
    if (s !== this.state) this.squash = 1.18;   // every real transition lands with a squash beat
    this.state = s; this.faded = faded;
  }

  // a click landed on them — the hatch pop doubles as the immediate acknowledgement
  poke() {
    this.pop = Math.max(this.pop, 0.45);
  }

  // the portrait greeting: a hop hello + one bright wave of the right arm, then back to work
  greet() {
    this.greetT = 0.9;
    this.pop = Math.max(this.pop, 0.3);
  }

  // a goal completed: they turn to you and jump for joy — twice
  cheer() { this.cheerT = 1.2; }

  // the pointer found them: eyes widen for a beat (subtle — hover sweeps are constant)
  perk() { this.perkT = 0.4; }

  // set down after a carry: a landing squash the world answers with dust
  thump() { this.squash = Math.max(this.squash, 1.25); this.landed = true; }

  setCarried(m: "no" | "held" | "scared") {
    if (m !== "no" && this.carried === "no") this.squash = 0.78;   // yanked up — a stretch
    this.carried = m;
  }

  // dangle physics input: hand velocity in the bean's camera-facing frame (right, toward)
  carryLean(vRight: number, vFwd: number, dt: number) {
    const cl = (v: number) => Math.max(-0.38, Math.min(0.38, v));
    this.leanZ = ease(this.leanZ, cl(-vRight * 0.045), dt, 10);
    this.leanX = ease(this.leanX, cl(vFwd * 0.045), dt, 10);
  }

  update(dt: number, t: number, camYaw: number) {
    const s = this.state;
    // blink (life for every state except the egg)
    if (s !== "opening") {
      this.blinkAt -= dt;
      if (this.blinkAt <= 0) { this.blinkT = 0.12; this.blinkAt = 3 + Math.random() * 4; }
      if (this.blinkT > 0) this.blinkT -= dt;
      const bl = this.blinkT > 0 ? 0.12 : 1;
      this.eyeL.scale.set(1, bl, 1); this.eyeR.scale.set(1, bl, 1);
    }

    let y = 0, rotX = 0, rotZ = 0, yaw = 0, sx = 0;
    let aura = 0, desk = false;
    // resting arm pose; states override
    let armLZ = 0.35, armRZ = -0.35, armLX = 0, armRX = 0;
    switch (s) {
      case "working": {
        desk = true;
        rotX = 0.1;
        this.bodyMat.emissiveIntensity = 0.3;   // the screen lights the bean up a touch
        // hands over the keys, tapping in bursts; the screen glow flickers with the keys
        const burst = Math.sin(t * 2.8 + this.phase) > -0.35;
        armLX = -1.15 + (burst ? 0.18 * Math.sin(t * 13) : 0);
        armRX = -1.15 + (burst ? 0.18 * Math.sin(t * 13 + Math.PI) : 0);
        armLZ = 0.12; armRZ = -0.12;
        this.screenMat.emissiveIntensity = 0.75 + (burst ? 0.3 * Math.abs(Math.sin(t * 9)) : 0.1);
        break;
      }
      case "awaiting": {                     // they need YOU: face the camera, big both-arms wave
        yaw = camYaw;
        y = 0.22 * Math.abs(Math.sin(t * 4.6));
        armLZ = 2.5 + 0.4 * Math.sin(t * 9);
        armRZ = -2.5 - 0.4 * Math.sin(t * 9 + 1);
        break;
      }
      case "blocked":
        desk = true;                          // the wreck stays on the desk, screen dead, smoking
        this.screenMat.emissiveIntensity = 0.04;
        rotX = 0.55; y = -0.05;              // folded forward over it, arms hanging dead
        armLZ = 0.05; armRZ = -0.05; armLX = -0.4; armRX = -0.4;
        break;
      case "retrying":
        sx = 0.34 * Math.sin(t * 1.6);       // pacing the pad, arms swinging with the waddle
        yaw = Math.cos(t * 1.6) > 0 ? Math.PI / 2 : -Math.PI / 2;
        rotZ = 0.08 * Math.sin(t * 7);
        armLX = 0.5 * Math.sin(t * 7); armRX = -0.5 * Math.sin(t * 7);
        break;
      case "awaitingBg":
        rotX = -0.14;                        // leaning back, watching its dispatched work spin
        armLZ = 0.9; armRZ = -0.9;
        this.orbMat.opacity = 0.9;
        this.orb.rotation.y = t * 2.2; this.orb.rotation.x = 0.5;
        this.orb.position.y = 1.55 + 0.08 * Math.sin(t * 2.6);
        break;
      case "compacting": case "clearing":
        y = 0.18 + 0.05 * Math.sin(t * 2.4); // levitating meditation, teal swirl orbiting
        yaw = t * 0.8;
        armLZ = 1.5; armRZ = -1.5;           // arms out, zen
        aura = 0.75; this.auraMat.color.setHex(ST.compacting);
        this.aura.rotation.z = t * 2.2;
        break;
      case "interrupting":
        this.squash = Math.max(this.squash, 1.12);   // freeze-frame squash; no motion at all
        break;
      case "opening":
        // the egg: eyes hidden, face hidden, wobbling toward the hatch
        this.eyeL.scale.setScalar(0.001); this.eyeR.scale.setScalar(0.001);
        this.face.visible = false; this.armL.visible = false; this.armR.visible = false;
        this.bodyMat.color.lerp(new THREE.Color(0xf2ead9), 0.2);
        rotZ = 0.09 * Math.sin(t * 9);
        break;
      default:                               // ready — and any state hive doesn't know
        if (this.faded && s === "ready") { rotX = -0.32; y = -0.06; armLZ = 0.1; armRZ = -0.1; }   // dozing
        else if (s !== "ready") {
          // unknown state: an honest, curious idle — slow look-arounds, no claims
          yaw = 0.4 * Math.sin(t * 0.7 + this.phase);
          armLZ = 0.5; armRZ = -0.5;
        } else {
          rotZ = 0.03 * Math.sin(t * 1.3 + this.phase);
          armLZ = 0.35 + 0.06 * Math.sin(t * 1.3 + this.phase);
          armRZ = -0.35 - 0.06 * Math.sin(t * 1.3 + this.phase);
        }
    }
    // the greeting outranks the pose's right arm for its moment — a clear, happy wave
    if (this.greetT > 0) {
      this.greetT -= dt;
      const g = Math.min(1, (0.9 - this.greetT) * 6);   // raise fast, wave, lower with the clock
      armRZ = -2.3 * g - 0.5 * Math.sin(t * 11) * g;
      armRX = 0;
    }
    if (s !== "opening") { this.face.visible = true; this.armL.visible = true; this.armR.visible = true; }
    if (s !== "working") this.bodyMat.emissiveIntensity = 0.22;
    if (s !== "awaitingBg") this.orbMat.opacity = ease(this.orbMat.opacity, 0, dt, 8);
    this.desk.visible = desk;

    // squash & stretch: landings compress the bean, air time stretches it — scale about the
    // feet (the lathe sits on y=0, so plain scale already pivots there), volume-ish preserved
    const vy = (y - this.prevY) / Math.max(dt, 1e-4);
    this.prevY = y;
    if (y < 0.02 && vy < -0.6) this.squash = Math.max(this.squash, 1.22);
    this.squash = ease(this.squash, 1, dt, 9);
    const airStretch = Math.min(0.12, Math.max(0, vy * 0.03));
    const syn = (1 / this.squash) + airStretch;
    const breathe = 1 + 0.018 * Math.sin(t * 2.1 + this.phase);
    let bs = syn * breathe;
    if (this.pop > 0) {
      this.pop = Math.max(0, this.pop - dt);
      const p = this.pop / 0.45;             // 1→0: a quick overshoot pulse on the whole body
      bs *= 1 + 0.3 * Math.sin(p * Math.PI);
    }
    this.torso.scale.set(this.squash * (2 - breathe), bs, this.squash * (2 - breathe));

    this.armL.rotation.set(armLX, 0, armLZ);
    this.armR.rotation.set(armRX, 0, armRZ);
    this.group.position.x = sx;
    this.group.position.y = PAD_H + y;
    this.group.rotation.y = yaw;
    this.torso.rotation.x = rotX;
    this.torso.rotation.z = rotZ;
    this.auraMat.opacity = ease(this.auraMat.opacity, aura, dt, 6);
  }
}

// name/❗ sprites: canvas-drawn, crisp at 2× — the one text surface WebGL owns; everything
// readable-at-length (the fly-in card) stays DOM
function makeTextSprite(text: string, color: string, bubble?: string): THREE.Sprite {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = "600 44px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.font = font;
  const w = Math.min(560, Math.max(bubble ? 72 : 120, ctx.measureText(text).width + (bubble ? 44 : 28)));
  c.width = Math.ceil(w); c.height = bubble ? 96 : 64;
  const ctx2 = c.getContext("2d")!;
  ctx2.font = font;
  ctx2.textAlign = "center"; ctx2.textBaseline = "middle";
  if (bubble) {
    ctx2.fillStyle = bubble;
    const r = 26, cw = c.width, ch = c.height;
    ctx2.beginPath();
    ctx2.roundRect(cw / 2 - 34, 6, 68, 68, r);
    ctx2.fill();
    ctx2.moveTo(cw / 2, ch - 2); ctx2.lineTo(cw / 2 - 12, ch - 22); ctx2.lineTo(cw / 2 + 12, ch - 22);
    ctx2.fill();
  } else {
    ctx2.shadowColor = color; ctx2.shadowBlur = 14;   // the name IS a neon sign — its own glow
  }
  ctx2.fillStyle = color;
  ctx2.fillText(text, c.width / 2, bubble ? 40 : c.height / 2, c.width - 16);
  if (!bubble) ctx2.fillText(text, c.width / 2, c.height / 2, c.width - 16);   // double-strike brightens the core
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(c.width / 72, c.height / 72, 1);   // readable from the overview orbit
  return sp;
}

// A cell's nameplate: written flat ON the tile, map-label style (a label that belongs to
// its cell can never leave it). Crisp and glow-free, the color dimmed to sit UNDER the
// bloom threshold so text never fuzzes. Long names ellipsize to the cell's width. The
// caller yaws it to the camera and fades it by zoom — a map fades labels out at altitude.
function makeNameDecal(name: string, color: string): THREE.Mesh {
  let rest = name;
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const F = 46;
  const nameFont = `600 ${F}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const px = (s: string) => { g.font = nameFont; return g.measureText(s).width; };
  const budget = (LABEL_W_MAX / LABEL_H) * (F * 1.35) - 24;   // px that fit at the fixed world height
  let cut = false;
  while (rest.length > 2 && px(rest) + (cut ? px("…") : 0) > budget) {
    rest = rest.slice(0, -1);
    cut = true;
  }
  if (cut) rest += "…";
  c.width = Math.ceil(px(rest)) + 24;
  c.height = Math.round(F * 1.35);
  const g2 = c.getContext("2d")!;                 // resizing reset the context state above
  g2.textBaseline = "middle";
  const dim = new THREE.Color(color || "#cccccc").multiplyScalar(0.82);
  g2.font = nameFont;
  g2.fillStyle = "#" + dim.getHexString();
  g2.fillText(rest, 12, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;                             // flat text at a glancing pitch smears without it
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(LABEL_H * (c.width / c.height), LABEL_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;                 // lie flat; text-top points away from the viewer
  return mesh;
}
function disposeDecal(m: THREE.Mesh) {
  m.geometry.dispose();
  const mat = m.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
}

// ── confetti / puffs: one pooled particle system for every burst ─────────────────────────
class Particles {
  points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private max = 600;
  private pos = new Float32Array(this.max * 3);
  private col = new Float32Array(this.max * 3);
  private vel: Float32Array = new Float32Array(this.max * 3);
  private life = new Float32Array(this.max);
  private grav = new Float32Array(this.max);   // per-particle: confetti falls, smoke rises
  private n = 0;

  constructor() {
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(this.geo, new THREE.PointsMaterial({
      size: 0.14, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending,      // sparks of light, not paper — they bloom
    }));
    this.points.frustumCulled = false;
    this.geo.setDrawRange(0, 0);
  }

  burst(at: THREE.Vector3, colors: number[], count: number, speed: number, gravity = -7.5, life = 1.1) {
    for (let i = 0; i < count && this.n < this.max; i++, this.n++) {
      const j = this.n * 3;
      // born spread over a small shell, not one point — a point of 50 additive sprites
      // reads as a white flashbulb on frame one, a shell reads as a firework
      const sh = 0.28;
      this.pos[j] = at.x + (Math.random() - 0.5) * sh * 2;
      this.pos[j + 1] = at.y + (Math.random() - 0.5) * sh;
      this.pos[j + 2] = at.z + (Math.random() - 0.5) * sh * 2;
      const th = Math.random() * Math.PI * 2, up = 0.5 + Math.random() * 0.9;
      this.vel[j] = Math.cos(th) * speed * (0.4 + Math.random() * 0.6);
      this.vel[j + 1] = up * speed;
      this.vel[j + 2] = Math.sin(th) * speed * (0.4 + Math.random() * 0.6);
      const c = new THREE.Color(colors[i % colors.length]);
      this.col[j] = c.r; this.col[j + 1] = c.g; this.col[j + 2] = c.b;
      this.life[this.n] = life + Math.random() * 0.5;
      this.grav[this.n] = gravity;
    }
  }

  update(dt: number) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const j = i * 3, k = w * 3;
      this.vel[j + 1] += this.grav[i] * dt;
      this.pos[k] = this.pos[j] + this.vel[j] * dt;
      this.pos[k + 1] = this.pos[j + 1] + this.vel[j + 1] * dt;
      this.pos[k + 2] = this.pos[j + 2] + this.vel[j + 2] * dt;
      if (w !== i) {
        this.vel[k] = this.vel[j]; this.vel[k + 1] = this.vel[j + 1]; this.vel[k + 2] = this.vel[j + 2];
        this.col[k] = this.col[j]; this.col[k + 1] = this.col[j + 1]; this.col[k + 2] = this.col[j + 2];
        this.life[w] = this.life[i]; this.grav[w] = this.grav[i];
      }
      w++;
    }
    this.n = w;
    this.geo.setDrawRange(0, this.n);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ── the fly-in card: the session's gist + a talk composer. DOM, not WebGL — readable text
// belongs to the page. Created ONCE and updated in place (never rebuilt per push), actions
// delegated to the stable card root, so clicks are click-safe by construction. ────────────
class HiveCard {
  el: HTMLElement;
  private dot: HTMLElement; private name: HTMLElement; private state: HTMLElement;
  private goal: HTMLElement; private brief: HTMLElement; private err: HTMLElement;
  private input: HTMLTextAreaElement; private sendBtn: HTMLButtonElement;
  sid: string | null = null;
  private curName = "";                        // latest display name (refresh keeps it current)
  private renaming = false;
  private endEdit: ((commit: boolean) => void) | null = null;   // cancel handle for a live editor
  onSend: (sid: string, text: string) => void = () => {};
  onOpen: (sid: string) => void = () => {};
  onClose: () => void = () => {};
  onRename: (sid: string, name: string) => void = () => {};

  constructor() {
    const el = document.createElement("div");
    el.id = "hive-card";
    el.innerHTML =
      '<div class="hc-head"><span class="hc-dot"></span>' +
      '<span class="hc-name" data-act="rename" title="Rename"></span>' +
      '<button class="hc-x" data-act="close" title="Back to the board (Esc)" aria-label="Close">×</button></div>' +
      '<div class="hc-state"></div>' +
      '<div class="hc-goal" hidden></div>' +
      '<div class="hc-brief" hidden></div>' +
      '<div class="hc-err" hidden></div>' +
      '<div class="hc-talk"><textarea class="hc-input" rows="2"></textarea>' +
      '<button class="hc-send" data-act="send">Send</button></div>' +
      '<div class="hc-foot"><button class="hc-open" data-act="open">Open chat ↗</button></div>';
    document.body.appendChild(el);
    this.el = el;
    this.dot = el.querySelector(".hc-dot") as HTMLElement;
    this.name = el.querySelector(".hc-name") as HTMLElement;
    this.state = el.querySelector(".hc-state") as HTMLElement;
    this.goal = el.querySelector(".hc-goal") as HTMLElement;
    this.brief = el.querySelector(".hc-brief") as HTMLElement;
    this.err = el.querySelector(".hc-err") as HTMLElement;
    this.input = el.querySelector(".hc-input") as HTMLTextAreaElement;
    this.sendBtn = el.querySelector(".hc-send") as HTMLButtonElement;
    delegate(el, {
      close: () => this.onClose(),
      open: () => { if (this.sid) this.onOpen(this.sid); },
      send: () => this.send(),
      rename: () => this.startRename(),
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
      e.stopPropagation();                   // typing must never orbit the camera / close the card
    });
  }

  private send() {
    const sid = this.sid, text = this.input.value.trim();
    if (!sid || !text) return;
    this.onSend(sid, text);
    // acknowledge NOW, before any server round-trip: the composer clears, the button says
    // so, and the world fires the send-puff at the hex (a refusal comes back as an err)
    this.input.value = "";
    this.err.hidden = true;
    const b = this.sendBtn;
    b.disabled = true; b.textContent = "Sent ✓";
    setTimeout(() => { b.disabled = false; b.textContent = "Send"; }, 1100);
  }

  // Click the name to rename — an inline editor in place. Enter/blur commits, Esc cancels;
  // the label only changes once the push lands with the new name (never optimistically —
  // the push is the truth).
  private startRename() {
    if (!this.sid || this.renaming) return;
    const sid = this.sid;                      // commit to the session the editor OPENED on —
    const base = this.curName;                 // a blur can land after the card switched sids
    const input = document.createElement("input");
    input.className = "hc-rename";
    input.value = base;
    input.spellcheck = false;
    this.renaming = true;
    this.name.style.display = "none";
    this.name.after(input);
    let finished = false;
    const done = (commit: boolean) => {
      if (finished) return;
      finished = true;
      this.endEdit = null;
      const v = input.value.trim();
      input.remove();
      this.name.style.display = "";
      this.renaming = false;
      if (commit && v && v !== base) this.onRename(sid, v);
    };
    this.endEdit = done;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();                     // typing must never orbit the camera / close the card
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    input.addEventListener("blur", () => done(true));
    for (const ev of ["click", "mousedown", "dblclick", "contextmenu"])
      input.addEventListener(ev, (e) => e.stopPropagation());
    input.focus();
    input.select();
  }

  show(s: HiveSession, now: number) {
    const fresh = this.sid !== s.sid;
    if (fresh) this.endEdit?.(false);          // switching sessions abandons a half-typed rename
    this.sid = s.sid;
    this.refresh(s, now);
    if (fresh) { this.err.hidden = true; this.input.value = ""; }
    this.el.classList.add("open");
    this.input.placeholder = "Say something to " + s.name + "…";
    if (fresh) this.input.focus();
  }

  refresh(s: HiveSession, now: number) {
    if (this.sid !== s.sid) return;
    this.curName = s.name;
    this.dot.style.background = s.color?.bg || "#8a8a8a";
    this.name.textContent = s.name;
    this.name.style.color = s.color?.bg || "#dddddd";
    this.name.dataset.act = "rename";          // a live session is renameable (gone() revokes)
    this.state.textContent = stateLine(s, now);
    this.state.dataset.state = isKnownState(s.state) ? s.state : "unknown";
    this.goal.hidden = !s.goal;
    if (s.goal) this.goal.textContent = s.goal;
    const needsYou = s.state === "awaiting" || s.state === "blocked";
    this.brief.hidden = !(s.brief && needsYou);
    if (s.brief && needsYou) this.brief.textContent = s.brief;
  }

  gone() {
    // the selected session left the board — say so rather than silently going stale, and
    // stop offering rename: there is nothing behind the sid to rename
    this.state.textContent = "this session has ended";
    this.state.dataset.state = "";
    this.endEdit?.(false);
    delete this.name.dataset.act;
  }

  error(title: string, text: string) {
    this.err.hidden = false;
    this.err.textContent = title + (text ? " — " + text : "");
  }

  hide() { this.endEdit?.(false); this.sid = null; this.el.classList.remove("open"); }
}

// ── the world ────────────────────────────────────────────────────────────────────────────
export class HiveWorld {
  private renderer: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private pads = new Map<string, Pad>();
  private slots = new Map<string, number>();
  private particles = new Particles();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-2, -2);
  private hovered: string | null = null;
  selected: string | null = null;
  // camera rig: yaw/pitch/dist orbit around an eased target — every value glides, per the
  // "everything springs, nothing teleports" rule
  private yaw = 0.0; private yawCur = 0.0;
  private pitch = 0.72; private pitchCur = 0.72;
  private dist = 26; private distCur = 30;
  private target = new THREE.Vector3(); private targetCur = new THREE.Vector3();
  private idleT = 99;                        // seconds since last user camera input
  private running = false;
  private visible = true;
  private lastFrame = 0;
  private dragging: { mode: "orbit" | "pan"; x: number; y: number } | null = null;
  private clock = 0;
  card = new HiveCard();
  // per-sid completion/ask watermarks the user has LOOKED at (localStorage — the latch
  // survives a reload); foldSeenDone / foldSeenAsk derive the unseen sets each payload
  private seenDone: SeenDone = loadSeen(SEEN_DONE_KEY);
  private seenAsk: SeenDone = loadSeen(SEEN_ASK_KEY);
  // the ghost hex: where the next session would land. It parks quietly on the first FREE
  // slot, and during a TRAY DRAG it glides under the carried bean, waking to show the
  // exact cell the drop will claim. Creation is drag-and-drop ONLY — no click-to-recruit,
  // no dialog: the drag's target cell is the whole conversation.
  private ghost = new THREE.Group();
  private ghostTarget = new THREE.Vector3();   // eased toward in frame() — the ghost glides
  private ghostSlot = 0;                       // the cell the ghost is offering right now
  private ghostHome = 0;                       // first-free slot — where it parks at rest
  private reservedSlot: number | null = null;  // cell claimed by a tray drop, honored in sync()
  // drag-to-end (TFT-style): a held press on a session that MOVES picks the bean up; it
  // rides the pointer, the trash dock slides in, and dropping on the armed dock ends the
  // session — the deliberate carry + highlighted dock IS the confirmation.
  private pressedPad: { sid: string; x: number; y: number; bean: boolean; name: boolean } | null = null;
  private renameEl: HTMLElement | null = null;   // the in-place board rename editor, when open
  private dragSession: { sid: string; over: boolean } | null = null;
  // trash-drop latch (hive-model foldEnding owns the semantics): sid → when the drop decided.
  private endingSids = new Map<string, number>();
  private trashEl: HTMLElement;
  private tipEl: HTMLElement;
  private tipText = "";
  private noteEl: HTMLElement;
  private noteT = 0;
  private emptyEl!: HTMLElement;
  private ghostRingMat = new THREE.LineBasicMaterial({
    color: ACCENT, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  private ghostFill: THREE.Mesh;
  private ghostPlus: THREE.Sprite;
  private ghostHover = false;
  // the one-layer board: every cell of the honeycomb as thin faint lines — EMPTY cells are
  // this lattice, USED cells are the pads docked flush into it. Rebuilt only when the
  // needed ring count changes, never per push.
  private lattice: THREE.LineSegments | null = null;
  private latticeRings = -1;
  // hover picking is throttled: exact on every pointer move, and a slow heartbeat
  // otherwise (the world drifts under a still cursor) — never a full-rate raycast loop
  private rayTargets: THREE.Object3D[] = [];
  private rayDirty = true;
  private pickDirty = true;
  private pickTick = 0;
  // the portrait: open a bean and the camera flies to a face-on close-up while the
  // rest of the world sinks into the fog and the board eases right of the chat dock.
  // All three (flight, fog, shift) are springs off ONE fact — portraitSid.
  private portraitSid: string | null = null;
  private fogCur = 0.013;
  private shiftCur = 0;
  private dockW = 460;                      // the dock's MEASURED width (boot observes it):
                                            // at ~a third of the viewport, the centering
                                            // math lands the face on the right third line
  private pressedEmpty: { x: number; y: number } | null = null;
  private tipV = new THREE.Vector3();       // scratch — the hot loop allocates nothing
  // The quality governor separates two different facts (conflating them stripped the
  // neon for nothing, 2026-08-19): the frame INTERVAL (how often the browser gives us a
  // frame — Energy Saver / Low Power Mode caps this at ~30Hz and no quality change can
  // move it) and our frame WORK (the milliseconds we spend inside the frame — the only
  // thing quality controls). Step down only when WORK is the cost; step back up, with
  // hysteresis, when it clearly isn't; say it out loud when the browser is the limiter.
  private quality = 2;                      // 2 full · 1 DPR1+lean bloom · 0 no bloom
  private lastRaw = -1;
  private ftAcc = 0; private ftN = 0; private ftWorst = 0;
  private workAcc = 0; private workWorst = 0;
  private lastFps = 60; private lastWorstMs = 16;
  private lastWorkMs = 0; private lastWorkWorstMs = 0;
  private fastWins = 0;                     // consecutive light windows → recover a level
  private capEl: HTMLElement;               // standing "browser is rationing frames" chip
  private gpu = "";
  private hud: HTMLElement | null = null;
  // fixed 60Hz simulation cadence: a ProMotion display (120 rAFs/s) and an Energy-Saver
  // throttle (30) otherwise make the SAME motion read fast-smooth then slow-choppy in
  // cycles (the user 2026-08-19: "I'd rather it constant"). Sim time advances on a 60Hz
  // grid; extra rAFs are skipped outright (also halving GPU work at 120Hz).
  private simAcc = 0;
  private fit: () => void;

  constructor(private root: HTMLElement, private bridge: Bridge) {
    // antialias off on purpose: every frame goes through the EffectComposer's render
    // target, where MSAA never applies — the flag only taxes the unused framebuffer
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(WORLD_BG);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    root.appendChild(this.renderer.domElement);
    // fail LOUD on the one thing no optimization can fix: a browser rendering in
    // software (hardware acceleration off / GPU process fallen back)
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      this.gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    } catch { /* diagnostics only */ }
    if (/swiftshader|software|llvmpipe/i.test(this.gpu)) {
      setTimeout(() => this.note("this browser is rendering WITHOUT the GPU — enable hardware acceleration"), 1200);
    }
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this.scene.fog = new THREE.FogExp2(WORLD_BG, 0.013);
    // cool, dim, mostly-emissive lighting — the neon does the work; the beans carry a
    // touch of self-light so they stay cute against the dark
    this.scene.add(new THREE.HemisphereLight(0x3b4a63, 0x0a0c10, 1.0));
    const key = new THREE.DirectionalLight(0xcfe0ff, 1.0);
    key.position.set(7, 12, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(ACCENT, 0.7);
    rim.position.set(-6, 6, -8);
    this.scene.add(rim);
    this.scene.add(this.particles.points);

    // the floor: a dark matte disc fading into the fog. The only pattern on it is the hex
    // LATTICE (ensureLattice) — one grid, underlining the tessellation.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(150, 64),
      // matte enough that the key light can't smear a bloom highlight across the floor
      new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.72, metalness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    this.scene.add(floor);

    // bloom is the neon: everything over the threshold (the overdriven status lines, eyes,
    // screens) halos out; the dark tiles, lattice and floor stay dark
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.45, 0.72);
    this.composer.addPass(this.bloom);

    const cv = this.renderer.domElement;
    cv.addEventListener("pointermove", (e) => this.onPointerMove(e));
    cv.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.min(70, Math.max(this.portraitSid ? 2.4 : 7, this.dist * Math.exp(e.deltaY * 0.0012)));
      this.idleT = 0;
      // pulling BACK out of a portrait is leaving the conversation — the zoom gesture
      // itself closes the chat and the camera keeps flying out to the full board
      if (this.portraitSid && this.dist > 8) this.bridge.closeChat();
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.dragSession) { this.dropSessionDrag(false, true); return; }   // Esc aborts a carry
      if (this.selected) this.deselect();
    });

    // the trash dock: hidden below the bottom edge, slides in only while a session is
    // being carried; pointer-events none — the canvas keeps the pointer, we rect-test
    this.trashEl = document.createElement("div");
    this.trashEl.id = "hive-trash";
    this.trashEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path fill="currentColor" d="M9 3v1H4v2h16V4h-5V3H9zM6 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8H6zm3 2h2v10H9V10zm4 0h2v10h-2V10z"/></svg>' +
      '<span class="ht-label">Drop to end</span>';
    document.body.appendChild(this.trashEl);

    // the hover tip: the session's LIVE STATUS floating over the hovered bean — hover is
    // the board's "one level deeper"; pointer-events none so it can never steal the hover
    this.tipEl = document.createElement("div");
    this.tipEl.id = "hive-tip";
    this.tipEl.innerHTML = '<span class="tip-dot"></span><span class="tip-state"></span>';
    document.body.appendChild(this.tipEl);

    // the board-level notice: refusals that arrive with NO card open land here instead of
    // vanishing (fail loudly) — a transient line, never a modal
    this.noteEl = document.createElement("div");
    this.noteEl.id = "hive-note";
    document.body.appendChild(this.noteEl);

    // a STANDING condition gets a standing chip, not a toast: shown exactly while the
    // browser rations frames despite light work (Energy Saver / Low Power Mode)
    this.capEl = document.createElement("div");
    this.capEl.id = "cap-chip";
    document.body.appendChild(this.capEl);

    // the empty-board hint: a hive with zero sessions must SAY so and say what to do —
    // an unexplained empty board reads as "my beans vanished" (the user 2026-08-19)
    this.emptyEl = document.createElement("div");
    this.emptyEl.id = "hive-empty";
    this.emptyEl.innerHTML = "<b>no sessions on this hive yet</b>" +
      "<span>drag a bean from the tray onto a hexagon to hatch one</span>";
    document.body.appendChild(this.emptyEl);

    this.fit = () => {
      const w = root.clientWidth || 1, h = root.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.composer.setSize(w, h);
      // bloom at fractional resolution: the glow is a blur by definition — full-res
      // bloom buys nothing visible and costs the most expensive passes on the frame
      this.bloom.setSize(w / (this.quality === 2 ? 2 : 3), h / (this.quality === 2 ? 2 : 3));
      cv.style.width = "100%"; cv.style.height = "100%";
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    this.fit();
    new ResizeObserver(this.fit).observe(root);

    // the perf beacon: real numbers from the real machine, every 10s, into the server's
    // log (authoritative measurement beats guessing at lag). #perf in the URL also shows
    // a tiny live HUD.
    if (location.hash.includes("perf")) {
      this.hud = document.createElement("div");
      this.hud.id = "perf-hud";
      document.body.appendChild(this.hud);
    }
    setInterval(() => {
      if (!this.running) return;
      const body = JSON.stringify({
        fps: Math.round(this.lastFps), worstMs: Math.round(this.lastWorstMs),
        workMs: Number(this.lastWorkMs.toFixed(1)), workWorstMs: Math.round(this.lastWorkWorstMs),
        q: this.quality, pads: this.pads.size, gpu: this.gpu.slice(0, 80),
      });
      fetch("/perf", { method: "POST", headers: { "content-type": "application/json" }, body })
        .catch(() => { /* server briefly away — the next beacon tells the story */ });
    }, 10_000);

    // render only while there's a viewer: page visible AND the board on screen.
    // Paused = zero GPU work.
    const io = new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      this.ensureLoop();
    });
    io.observe(root);
    document.addEventListener("visibilitychange", () => this.ensureLoop());
    this.ensureLoop();

    // deliberately QUIETER than any real pad: the ghost lights its whole cell like a
    // resident would, just barely — an invitation at the spiral's frontier, not a resident
    const ghostRing = new THREE.LineLoop(hexLineGeo(PAD_R), this.ghostRingMat);
    ghostRing.position.y = 0.03;
    this.ghostFill = new THREE.Mesh(
      new THREE.CircleGeometry(PAD_R, 6, RIM_THETA),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.012, depthWrite: false }));
    this.ghostFill.rotation.x = -Math.PI / 2;
    this.ghostFill.position.y = 0.02;
    this.ghostPlus = makeTextSprite("+", "#9cd2ff");
    this.ghostPlus.position.y = 0.6;
    this.ghostPlus.scale.multiplyScalar(0.7);
    this.ghostPlus.material.opacity = 0.25;
    this.ghost.add(ghostRing, this.ghostFill, this.ghostPlus);
    this.scene.add(this.ghost);

    this.card.onClose = () => this.deselect();
    this.card.onOpen = (sid) => this.openChat(sid);
    this.card.onRename = (sid, name) => {
      // the server renames and the new name rides the next push — never optimistic
      this.bridge.op({ op: "rename", sid, name });
    };
    this.card.onSend = (sid, text) => {
      this.bridge.op({ op: "send", sid, text });
      const pad = this.pads.get(sid);
      if (pad) {
        // the visible delivery: a little accent spark shower over their hex
        const at = pad.group.position.clone().setY(PAD_H + 1.6);
        this.particles.burst(at, [ACCENT, 0xd6ecff, 0x6fb7ff], 14, 1.6);
      }
    };
    (window as any).__hive = this;           // debug handle (harness + console poking)
  }

  private canvasPoint(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.pickDirty = true;
  }

  private onPointerMove(e: PointerEvent) {
    this.canvasPoint(e);
    // a held press on a session that moves becomes a PICK-UP; the gate is the gesture
    // (px travelled), the same 6px the recruit click uses
    if (this.pressedPad && !this.dragSession
        && Math.hypot(e.clientX - this.pressedPad.x, e.clientY - this.pressedPad.y) > 6) {
      this.beginSessionDrag(this.pressedPad.sid);
    }
    if (this.dragSession) { this.moveSessionDrag(e); return; }   // a carry never orbits
    if (this.dragging) {
      const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
      this.dragging.x = e.clientX; this.dragging.y = e.clientY;
      this.idleT = 0;
      if (this.dragging.mode === "orbit") {
        this.yaw -= dx * 0.0052;
        this.pitch = Math.min(1.32, Math.max(0.32, this.pitch + dy * 0.004));
      } else {
        // pan in the ground plane, screen-aligned
        const s = this.distCur * 0.0016;
        const right = new THREE.Vector3(Math.cos(this.yawCur), 0, -Math.sin(this.yawCur));
        const fwd = new THREE.Vector3(-Math.sin(this.yawCur), 0, -Math.cos(this.yawCur));
        this.target.addScaledVector(right, -dx * s).addScaledVector(fwd, dy * s);
      }
    }
  }

  private onPointerDown(e: PointerEvent) {
    this.canvasPoint(e);
    const hit = this.pick();
    const sid = hit.sid;
    if (e.button === 2 || e.shiftKey) { this.dragging = { mode: "pan", x: e.clientX, y: e.clientY }; return; }
    if (sid) {
      const pad = this.pads.get(sid);
      // the press acknowledges INSTANTLY (dip + pop) but COMMITS nothing: the gesture
      // decides on the up — a clean click opens the chat, movement becomes a carry
      // (the user 2026-08-19, who kept opening chats they only meant to drag)
      if (pad) {
        pad.lift = -0.07;
        setTimeout(() => { if (this.pads.get(sid) === pad) pad.lift = this.hovered === sid ? 0.12 : 0; }, 130);
        if (hit.bean) pad.pokeBean();
      }
      this.pressedPad = { sid, x: e.clientX, y: e.clientY, bean: hit.bean, name: hit.name };
    } else {
      this.pressedEmpty = { x: e.clientX, y: e.clientY };
      this.dragging = { mode: "orbit", x: e.clientX, y: e.clientY };
    }
  }

  private onPointerUp(e: PointerEvent) {
    const pp = this.pressedPad;
    const pe = this.pressedEmpty;
    this.pressedPad = null;
    this.pressedEmpty = null;
    this.dragging = null;
    if (this.dragSession) { this.dropSessionDrag(this.dragSession.over); return; }
    if (pp && Math.hypot(e.clientX - pp.x, e.clientY - pp.y) <= 5) {
      // the clean click: the nameplate edits in place (its own affordance); everything
      // else on the cell — hexagon or bean — opens the chat
      if (pp.name) this.beginBoardRename(pp.sid);
      else this.openChat(pp.sid);
      return;
    }
    // a clean click on EMPTY ground dismisses what's up — the card first, then the
    // chat/portrait (a drag is a camera move and dismisses nothing)
    if (pe && Math.hypot(e.clientX - pe.x, e.clientY - pe.y) <= 5) {
      if (this.selected) this.deselect();
      else if (this.portraitSid) this.bridge.closeChat();
    }
  }

  setDockWidth(px: number) {
    if (px > 40) this.dockW = px;
  }

  private beginSessionDrag(sid: string) {
    const pad = this.pads.get(sid);
    if (!pad || pad.dyingT >= 0) return;
    // the carry position itself is recomputed EVERY FRAME (see frame()) so the bean stays
    // pinned under the cursor no matter how the camera eases; the event only arms the dock
    this.dragSession = { sid, over: false };
    pad.lift = 0;
    const label = this.trashEl.querySelector(".ht-label") as HTMLElement;
    label.textContent = "Drop to end " + pad.sess.name;
    this.trashEl.classList.add("show");
    this.renderer.domElement.style.cursor = "grabbing";
  }

  private moveSessionDrag(e: PointerEvent) {
    const d = this.dragSession!;
    const pad = this.pads.get(d.sid);
    if (!pad || pad.dyingT >= 0) { this.dropSessionDrag(false, true); return; }
    const r = this.trashEl.getBoundingClientRect();
    const over = e.clientX >= r.left - 14 && e.clientX <= r.right + 14 && e.clientY >= r.top - 14;
    if (over !== d.over) { d.over = over; this.trashEl.classList.toggle("armed", over); }
  }

  private dropSessionDrag(over: boolean, cancel = false) {
    const d = this.dragSession;
    this.dragSession = null;
    this.trashEl.classList.remove("show", "armed");
    this.renderer.domElement.style.cursor = "default";
    if (!d) return;
    const pad = this.pads.get(d.sid);
    if (!pad) return;
    if (over && pad.dyingT < 0) {
      // the drop is the decision: end the session. The bean bursts where it vanished, and
      // the tile goes straight to the sink — the farewell hop is for natural exits. The
      // latch arms HERE, beside the op: stale payloads that still list the sid are the
      // kill in flight, not a comeback (sync holds them out via foldEnding).
      this.bridge.op({ op: "end", sid: d.sid });
      this.endingSids.set(d.sid, Date.now());
      this.particles.burst(pad.beanWorldPos().setY(1.0), [0xe5484d, 0x8a8a8a, 0xffb3b6], 26, 2.6);
      pad.consumeBean();
      pad.dyingT = 0.26;
      this.rayDirty = true;
      if (this.selected === d.sid) this.deselect();
      if (this.portraitSid === d.sid) this.exitPortrait();
      return;
    }
    // a FREE cell under the drop re-homes them there: the user's own gesture is the one
    // sanctioned move event for a session's hex, and the slot map + localStorage move with
    // it so the new home survives reloads. Esc / a dying pad / anywhere else springs them
    // home unharmed.
    const slot = cancel || pad.dyingT >= 0 ? null : this.freeCellAt();
    if (slot !== null) this.rehome(d.sid, slot, pad);
    else pad.carryTo(null);
  }

  private rehome(sid: string, slot: number, pad: Pad) {
    this.slots.set(sid, slot);
    saveSlots(loadSlots(this.slots));        // merge-persist, same shape sync() keeps
    const p = axialToXZ(spiralSlot(slot), HEX_SIZE);
    pad.homeTo(p.x, p.z);                    // the tile glides; the bean springs down onto it
    pad.carryTo(null);
    // the ghost's park may be stale now (the move may have taken or freed its cell)
    let free = 0;
    const taken = new Set(this.slots.values());
    while (taken.has(free)) free++;
    this.ghostHome = free;
    if (!this.ghostHover) this.ghostTo(free);
  }

  // ── the tray (model beans): spawn-drag support. The ghost is the drop's answer: it
  // glides under the carried bean and wakes over the exact free cell the drop will claim.
  trayHover(clientX: number, clientY: number): number | null {
    const slot = this.freeCellAt(clientX, clientY);
    if (slot !== null && slot !== this.ghostSlot) this.ghostTo(slot);
    this.ghostHover = slot !== null;
    return slot;
  }

  // the drag ended (spawned or not): the ghost calms and re-parks at the frontier
  trayDragEnd() {
    this.ghostHover = false;
    this.ghostTo(this.ghostHome);
    this.trashEl.classList.remove("show", "armed");
  }

  // shelf-chip drags can also end on the TRASH DOCK (remove the specialist for good):
  // the dock slides in while a shelf chip is carried, arming as the chip nears it
  shelfDragMove(clientX: number, clientY: number, label: string): "trash" | number | null {
    this.trashEl.classList.add("show");
    (this.trashEl.querySelector(".ht-label") as HTMLElement).textContent = label;
    const r = this.trashEl.getBoundingClientRect();
    const over = clientX >= r.left - 14 && clientX <= r.right + 14 && clientY >= r.top - 14;
    this.trashEl.classList.toggle("armed", over);
    if (over) { this.ghostHover = false; return "trash"; }
    return this.trayHover(clientX, clientY);
  }

  // hire a specialist onto the dropped cell: reserve it (same mechanics as a model
  // drop), spark, and let the server do the real work
  summonAt(slot: number, name: string) {
    this.reservedSlot = slot;
    const p = axialToXZ(spiralSlot(slot), HEX_SIZE);
    this.particles.burst(new THREE.Vector3(p.x, 0.6, p.z), [0xf4c430, 0xffe28a, ACCENT], 18, 2.0);
    this.bridge.op({ op: "summon", name });
  }

  autoName(alias: string): string {
    // smallest free "<alias>-<n>" among the names on the board
    const used = new Set([...this.pads.values()].map((p) => p.sess.name));
    let n = 1;
    while (used.has(alias + "-" + n)) n++;
    return alias + "-" + n;
  }

  spawnAt(slot: number, model: string, effort: string, label?: string) {
    // the dropped bean claims the cell (the same reservation a recruit click makes), the
    // spark acknowledges, and the server's create does the real work. The NAME seeds from
    // the human label ("Fable 5" → fable-1), never the raw model id.
    this.reservedSlot = slot;
    const p = axialToXZ(spiralSlot(slot), HEX_SIZE);
    this.particles.burst(new THREE.Vector3(p.x, 0.6, p.z), [ACCENT, 0xd6ecff], 16, 1.8);
    const slug = (label || model).toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9-]/g, "") || "bee";
    this.bridge.op({ op: "create", name: this.autoName(slug), model, effort });
  }

  // In-place board rename: the city-banner pattern — click the nameplate and it becomes an
  // editor exactly where it sits, in the plate's own type and the session's color.
  // Enter/blur commits the rename op, Esc cancels, and the plate only re-renders when the
  // push lands with the truth.
  beginBoardRename(sid: string) {
    const pad = this.pads.get(sid);
    if (!pad || pad.dyingT >= 0 || this.renameEl) return;
    const p = pad.labelWorldPos().project(this.camera);
    const rr = this.renderer.domElement.getBoundingClientRect();
    const x = (p.x * 0.5 + 0.5) * rr.width + rr.left;
    const y = (0.5 - p.y * 0.5) * rr.height + rr.top;
    pad.setNameHidden(true);                   // the editor stands where the plate was
    const wrap = document.createElement("div");
    wrap.id = "hive-rename";
    wrap.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%, -50%)";
    const base = pad.sess.name;
    const input = document.createElement("input");
    input.value = base;
    input.spellcheck = false;
    input.size = Math.max(base.length, 3);
    input.style.color = pad.sess.color?.bg || "#dddddd";
    wrap.appendChild(input);
    document.body.appendChild(wrap);
    this.renameEl = wrap;
    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      wrap.remove();
      this.renameEl = null;
      this.pads.get(sid)?.setNameHidden(false);
      if (commit && v && v !== base) this.bridge.op({ op: "rename", sid, name: v });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();                     // Esc cancels the EDIT, never a drag/selection
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("input", () => { input.size = Math.max(input.value.length, 3); });
    for (const ev of ["pointerdown", "click", "dblclick"])
      wrap.addEventListener(ev, (e) => e.stopPropagation());
    input.focus();
    input.select();
  }

  // a transient board-level notice for refusals with no card open (fail loudly, never vanish)
  note(text: string) {
    this.noteEl.textContent = text;
    this.noteEl.classList.add("show");
    clearTimeout(this.noteT);
    this.noteT = window.setTimeout(() => this.noteEl.classList.remove("show"), 4000);
  }

  // ONE raycast against one flat, cached target list (rebuilt only when the cast
  // changes) — the per-pad triple-intersect loop was the board's frame-time hog
  private pick(): { sid: string | null; bean: boolean; name: boolean } {
    if (this.rayDirty) {
      this.rayDirty = false;
      this.rayTargets = [];
      for (const pad of this.pads.values()) {
        if (pad.dyingT < 0) this.rayTargets.push(...pad.pickTargets());
      }
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.rayTargets, false);
    for (const h of hits) {
      const tag = h.object.userData as { sid?: string; kind?: string };
      if (!tag.sid) continue;
      const pad = this.pads.get(tag.sid);
      if (!pad || pad.dyingT >= 0) continue;
      // an unreadable nameplate must never be a secret button — fall through to the
      // next hit (its own tile is right underneath)
      if (tag.kind === "name" && !pad.nameVisible()) continue;
      return { sid: tag.sid, bean: tag.kind === "bean", name: tag.kind === "name" };
    }
    return { sid: null, bean: false, name: false };
  }

  // The FREE cell of the board under a point — the ONE ground-plane → cell mapping, shared
  // by hover (pick), drop-to-re-home, and the tray's spawn-drag. With client coords given,
  // the pointer NDC is refreshed first (tray drags arrive as window events, not canvas ones).
  freeCellAt(clientX?: number, clientY?: number): number | null {
    if (clientX !== undefined && clientY !== undefined) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const oy = this.raycaster.ray.origin.y, dy = this.raycaster.ray.direction.y;
    const t = dy !== 0 ? -oy / dy : -1;
    if (t <= 0) return null;
    const px = this.raycaster.ray.origin.x + this.raycaster.ray.direction.x * t;
    const pz = this.raycaster.ray.origin.z + this.raycaster.ray.direction.z * t;
    const cell = xzToAxial(px, pz, HEX_SIZE);
    if (!(hexDistance(cell, { q: 0, r: 0 }) <= this.latticeRings)) return null;   // the visible board only
    const slot = slotOfAxial(cell);
    return slot >= 0 && !new Set(this.slots.values()).has(slot) ? slot : null;
  }

  // the direct line to a session: its chat opens in the dock and the world goes to the
  // portrait — one path, used by the bean click and the card's Open alike.
  openChat(sid: string) {
    this.lookedAt(sid);                      // going to its chat IS looking — the ✓ note retires
    this.portraitTo(sid);
    this.bridge.openChat(sid);
  }

  // fly to the face-on close-up. Retargeting between beans mid-portrait is the same move.
  portraitTo(sid: string) {
    const pad = this.pads.get(sid);
    if (!pad || pad.dyingT >= 0) return;
    const prev = this.portraitSid && this.pads.get(this.portraitSid);
    if (prev) prev.portrait = false;
    this.portraitSid = sid;
    pad.portrait = true;
    pad.wave();                              // they see you arrive — a little greeting
    this.dist = 3.1;
    this.pitch = 0.3;
    this.yaw = Math.round(this.yawCur / (Math.PI * 2)) * Math.PI * 2;   // face-on, shortest way
    this.idleT = 0;
  }

  exitPortrait() {
    const pad = this.portraitSid && this.pads.get(this.portraitSid);
    if (pad) pad.portrait = false;
    if (this.portraitSid === null) return;
    this.portraitSid = null;
    this.frameAll();
  }

  // The user's own gesture toward a session — the ONE event that clears its finished note
  // and quiets a filed ask's shout (never a timer, never a re-render): both watermarks
  // advance to the evidence they just went to see, persisted so a reload can't resurrect
  // an acknowledged cue.
  lookedAt(sid: string) {
    const pad = this.pads.get(sid);
    if (!pad) return;
    if (pad.sess.doneT > (this.seenDone[sid] ?? 0)) {
      this.seenDone[sid] = pad.sess.doneT;
      pad.unseenDone = false;
      saveSeen(SEEN_DONE_KEY, this.seenDone);
    }
    if (pad.sess.needsYouT > (this.seenAsk[sid] ?? 0)) {
      this.seenAsk[sid] = pad.sess.needsYouT;
      pad.setAskAck(pad.sess.state === "awaiting" && !pad.sess.liveAsk);
      saveSeen(SEEN_ASK_KEY, this.seenAsk);
    }
  }

  // aim the ghost at a cell; frame() glides it there (everything springs, nothing teleports)
  private ghostTo(slot: number) {
    this.ghostSlot = slot;
    const p = axialToXZ(spiralSlot(slot), HEX_SIZE);
    this.ghostTarget.set(p.x, 0, p.z);
  }

  // The SELECTED state (camera fly-in + the fly-in card) is the DEEP-LINK presentation
  // only — a "show me" jump lands here (#focus=<sid>). A plain click never opens it: the
  // chat on the left is the click's whole answer.
  select(sid: string) {
    this.lookedAt(sid);                      // a deep-link jump is the user arriving to look
    this.selected = sid;
    const pad = this.pads.get(sid);
    if (pad) {
      this.target.copy(pad.group.position).setY(0.6);
      this.dist = 10.5;
      this.pitch = 0.62;
      this.idleT = 0;
      this.card.show(pad.sess, Math.floor(Date.now() / 1000));
    }
  }
  deselect() {
    if (this.selected === null) return;
    this.selected = null;
    this.card.hide();
    this.frameAll();
  }

  // snap every eased camera value to its target — debug/screenshot use
  settle() {
    this.yawCur = this.yaw; this.pitchCur = this.pitch; this.distCur = this.dist;
    this.targetCur.copy(this.target);
  }

  frameAll() {
    const occupied = [...this.pads.values()].filter((p) => p.dyingT < 0);
    const slots = occupied.map((p) => this.slots.get(p.sess.sid) ?? 0);
    const r = Math.max(6, frameRadius(slots, HEX_SIZE));
    let cx = 0, cz = 0;
    for (const p of occupied) { cx += p.group.position.x; cz += p.group.position.z; }
    const n = Math.max(1, occupied.length);
    this.target.set(cx / n, 0, cz / n);
    this.dist = Math.min(70, Math.max(11, (r / Math.tan((this.camera.fov * Math.PI) / 360)) * 0.48));
    this.pitch = 0.72;
  }

  // apply one payload's worth of change — called with the model's diff, never per frame
  sync(sessions: HiveSession[], first: boolean) {
    // Trashed sids are held OUT of the payload until one arrives without them (the
    // server's confirm). Past the ack window the end evidently didn't take: the sid
    // re-surfaces — a suppressed living session would be a lie on the board — and the
    // failure is said out loud.
    const fold = foldEnding(this.endingSids, new Set(sessions.map((s) => s.sid)), Date.now());
    sessions = sessions.filter((s) => !fold.drop.has(s.sid));
    for (const sid of fold.failed) {
      const name = sessions.find((s) => s.sid === sid)?.name || "that session";
      this.note(name + " didn't end — it's still running.");
    }
    const prevSessions = [...this.pads.values()].map((p) => p.sess);
    const diff = diffSessions(first ? null : prevSessions, sessions);
    const stored = loadSlots(this.slots);
    this.slots = assignSlots(stored, sessions.map((s) => s.sid));
    // a click on an empty cell reserved it for the next NEW arrival — honor it here,
    // before pads are built. A REVIVED session outranks the click: it returns to its
    // remembered hex, so the reservation only takes a sid with no remembered home.
    if (this.reservedSlot !== null && diff.added.length) {
      const want = this.reservedSlot;
      this.reservedSlot = null;
      const sid = diff.added.find((id) => !stored.has(id));
      if (sid !== undefined && (this.slots.get(sid) === want || ![...this.slots.values()].includes(want))) {
        this.slots.set(sid, want);
      }
    }
    // persist the present sessions PLUS absent sids' remembered homes (a revived session
    // returns to its old hex), dropping the memories only past 200 entries
    const keep = new Map(this.slots);
    if (stored.size <= 200) for (const [k, v] of stored) if (!keep.has(k) && ![...keep.values()].includes(v)) keep.set(k, v);
    saveSlots(keep);
    const bySid = new Map(sessions.map((s) => [s.sid, s] as const));
    // a session that comes BACK while its pad is mid-departure gets a fresh pad — the
    // dying one can't be rewound
    for (const s of sessions) {
      const pad = this.pads.get(s.sid);
      if (pad && pad.dyingT >= 0) {
        this.scene.remove(pad.group);
        pad.dispose();
        this.pads.delete(s.sid);
        if (!diff.added.includes(s.sid)) diff.added.push(s.sid);
      }
    }

    for (const sid of diff.removed) {
      const pad = this.pads.get(sid);
      if (pad && pad.dyingT < 0) { pad.dyingT = 0; this.rayDirty = true; }   // departure plays; disposal in the loop
      if (this.selected === sid) { this.card.gone(); this.selected = null; this.frameAll(); }
      if (this.portraitSid === sid) this.exitPortrait();
      if (this.hovered === sid) this.hovered = null;
    }
    for (const sid of diff.added) {
      const s = bySid.get(sid)!;
      const pad = new Pad(s, this.slots.get(sid) ?? 0);
      this.pads.set(sid, pad);
      this.scene.add(pad.group);
      this.rayDirty = true;
    }
    const changed = new Set(diff.stateChanged.map((c) => c.sid));
    const nowS = Math.floor(Date.now() / 1000);
    const pm = new Map(prevSessions.map((p) => [p.sid, p] as const));
    for (const s of sessions) {
      const pad = this.pads.get(s.sid);
      if (pad && !diff.added.includes(s.sid) && pad.apply(s, changed.has(s.sid))) this.rayDirty = true;
      // taking up a duty is a moment: the hat lands with a golden burst and a wave
      const was = pm.get(s.sid);
      if (pad && was && !was.duty && s.duty) {
        const at = pad.group.position.clone().setY(PAD_H + 1.4);
        this.particles.burst(at, [0xf4c430, 0xffe28a, ACCENT], 30, 3.2);
        pad.wave();
      }
      if (this.selected === s.sid) this.card.refresh(s, nowS);
    }
    // the unseen-finished latch: completions the user hasn't gone to look at wear the ✓
    // note until their own gesture clears it (lookedAt). The open card IS looking.
    const done = foldSeenDone(this.seenDone, sessions);
    this.seenDone = done.seen;
    let seenChanged = done.changed;
    if (this.selected && done.unseen.has(this.selected)) {
      const s = bySid.get(this.selected);
      if (s) { this.seenDone[this.selected] = s.doneT; done.unseen.delete(this.selected); seenChanged = true; }
    }
    for (const s of sessions) {
      const pad = this.pads.get(s.sid);
      if (pad) pad.unseenDone = done.unseen.has(s.sid);
    }
    if (seenChanged) saveSeen(SEEN_DONE_KEY, this.seenDone);
    // …and its ASK twin: a filed question shouts until looked at, then the pad keeps its
    // honest red ring and calms. A live prompt (liveAsk) never acks — it is now.
    const ask = foldSeenAsk(this.seenAsk, sessions);
    this.seenAsk = ask.seen;
    let askChanged = ask.changed;
    if (this.selected && ask.unseen.has(this.selected)) {
      const s = bySid.get(this.selected);
      if (s && !s.liveAsk) { this.seenAsk[this.selected] = s.needsYouT; ask.unseen.delete(this.selected); askChanged = true; }
    }
    for (const s of sessions) {
      const pad = this.pads.get(s.sid);
      if (pad) pad.setAskAck(s.state === "awaiting" && !s.liveAsk && !ask.unseen.has(s.sid));
    }
    if (askChanged) saveSeen(SEEN_ASK_KEY, this.seenAsk);
    for (const sid of diff.goalDone) {
      const pad = this.pads.get(sid);
      if (pad) {
        const at = pad.group.position.clone().setY(PAD_H + 1.1);
        const tint = new THREE.Color(pad.sess.color?.bg || "#9cd2ff").getHex();
        // no pure white in the mix — additive + bloom turns white into a supernova
        this.particles.burst(at, [tint, ACCENT, 0xffd700, tint], 48, 4.2);
      }
    }
    // the ghost's PARK is the first FREE slot — the natural "next" cell of the spiral; it
    // only re-aims now if it isn't busy following the pointer (or its cell got taken)
    let free = 0;
    const taken = new Set(this.slots.values());
    while (taken.has(free)) free++;
    this.ghostHome = free;
    if (!this.ghostHover || taken.has(this.ghostSlot)) this.ghostTo(free);
    // …and keep the one-layer lattice one ring wider than anything on it
    this.ensureLattice(Math.max(3, ringOf(Math.max(free, ...this.slots.values())) + 1));

    this.emptyEl.classList.toggle("show", sessions.length === 0);
    if (first || diff.added.length || diff.removed.length) {
      if (this.selected === null) this.frameAll();
    }
    // deep-link: #focus=<sid> flies straight to that session's hex on arrival
    if (first) {
      const m = /[#&]focus=([^&]+)/.exec(location.hash);
      const sid = m && decodeURIComponent(m[1]);
      if (sid && this.pads.has(sid)) this.select(sid);
    }
    this.ensureLoop();
  }

  // (re)build the empty-cell lattice for rings 0..n: one LineSegments of every unique edge
  // (latticeSegments dedupes shared ones), faint accent, flat on the board — the layer the
  // pads dock into
  private ensureLattice(rings: number) {
    if (rings === this.latticeRings) return;
    this.latticeRings = rings;
    if (this.lattice) {
      this.scene.remove(this.lattice);
      this.lattice.geometry.dispose();
      (this.lattice.material as THREE.Material).dispose();
    }
    const seg = latticeSegments(rings, HEX_SIZE);
    const pos = new Float32Array((seg.length / 4) * 6);
    for (let i = 0, j = 0; i < seg.length; i += 4) {
      pos[j++] = seg[i]; pos[j++] = 0; pos[j++] = seg[i + 1];
      pos[j++] = seg[i + 2]; pos[j++] = 0; pos[j++] = seg[i + 3];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.lattice = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: ACCENT, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.lattice.position.y = 0.004;
    this.scene.add(this.lattice);
  }

  private ensureLoop() {
    const want = this.visible && !document.hidden;
    if (want && !this.running) {
      this.running = true;
      this.lastFrame = -1;                   // frame() takes its dt from the rAF clock only
      this.lastRaw = -1;                     // …and the governor never counts a pause as a stall
      requestAnimationFrame(this.frame);
    } else if (!want) {
      this.running = false;                  // the in-flight rAF sees this and stops
    }
  }

  // apply ALL of a level's parameters (idempotent), so the governor can move both ways
  private setQuality(q: number) {
    this.quality = q;
    this.renderer.setPixelRatio(q === 2 ? Math.min(window.devicePixelRatio || 1, 1.5) : 1);
    this.bloom.enabled = q > 0;
    this.bloom.strength = q === 2 ? 0.7 : 0.55;
    this.fit();
    console.info(`[hive] quality → ${q}`);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    const t0 = performance.now();
    // the 60Hz grid: accumulate real time; simulate+render only when a full step is due
    const STEP = 1 / 60;
    this.simAcc = Math.min(this.simAcc + frameDt(now, this.lastFrame), 3 * STEP);
    this.lastFrame = now;
    if (this.simAcc < STEP) { requestAnimationFrame(this.frame); return; }
    const dt = STEP * Math.floor(this.simAcc / STEP);   // 30fps rAF → one 2-step tick: true speed
    this.simAcc -= dt;
    // the stats read RAW deltas (frameDt clamps at 50ms — real stalls are bigger)
    if (this.lastRaw >= 0) {
      const raw = (now - this.lastRaw) / 1000;
      if (raw > 0 && raw < 2) {
        this.ftAcc += raw; this.ftN++;
        if (raw > this.ftWorst) this.ftWorst = raw;
        if (this.ftN >= 90) {
          this.lastFps = this.ftN / this.ftAcc;
          this.lastWorstMs = this.ftWorst * 1000;
          this.lastWorkMs = this.workAcc / this.ftN;
          this.lastWorkWorstMs = this.workWorst;
          // WORK-bound → trade fidelity. Light → win the level back (three calm
          // windows in a row, so recovery can't flap).
          if (this.lastWorkMs > 11 && this.quality > 0) {
            this.fastWins = 0;
            this.setQuality(this.quality - 1);
          } else if (this.lastWorkMs < 6 && this.quality < 2) {
            if (++this.fastWins >= 3) { this.fastWins = 0; this.setQuality(this.quality + 1); }
          } else {
            this.fastWins = 0;
          }
          // slow frames while our work is light: the BROWSER is rationing frames —
          // the chip stands exactly as long as the condition does
          const capped = this.lastFps < 45 && this.lastWorkMs < 8;
          this.capEl.classList.toggle("show", capped);
          if (capped) {
            this.capEl.textContent = `browser limiting animation to ~${Math.round(this.lastFps)}fps ` +
              `(hive: ${this.lastWorkMs.toFixed(1)}ms/frame) — check Energy Saver / Low Power Mode`;
          }
          if (this.hud) {
            this.hud.textContent = `${Math.round(this.lastFps)} fps · work ${this.lastWorkMs.toFixed(1)}ms ` +
              `(worst ${Math.round(this.lastWorkWorstMs)}) · q${this.quality} · ${this.pads.size} pads`;
          }
          this.ftAcc = 0; this.ftN = 0; this.ftWorst = 0;
          this.workAcc = 0; this.workWorst = 0;
        }
      }
    }
    this.lastRaw = now;
    this.lastFrame = now;
    this.clock += dt;
    this.idleT += dt;

    // hover pick: exact whenever the POINTER moved (pickDirty), a 1-in-3-frame
    // heartbeat otherwise (the world eases under a still cursor); a carried bean
    // must not churn hover or drag the ghost around
    this.pickTick++;
    const wantPick = !this.dragSession && (this.pickDirty || this.pickTick % 3 === 0);
    this.pickDirty = false;
    const sid = wantPick ? this.pick().sid : this.hovered;
    if (sid !== this.hovered) {
      const old = this.hovered ? this.pads.get(this.hovered) : null;
      if (old) { old.lift = 0; old.hover = false; }
      this.hovered = sid;
      const nw = sid ? this.pads.get(sid) : null;
      if (nw) { nw.lift = 0.12; nw.hover = true; }
      this.renderer.domElement.style.cursor = sid ? "pointer" : "default";
    }
    // the hover tip rides the hovered bean, saying exactly what the card's state line
    // would — placed per frame (the bean bobs, the camera springs), text only on change
    const tipPad = this.hovered && !this.dragSession ? this.pads.get(this.hovered) : null;
    if (tipPad && tipPad.dyingT < 0) {
      const p = tipPad.beanWorldPosInto(this.tipV);
      p.y += 2.3;                            // above the bang's bob, clear of the head
      p.project(this.camera);
      if (p.z < 1) {
        const rr = this.renderer.domElement.getBoundingClientRect();
        this.tipEl.style.transform = "translate(-50%, -100%) translate(" +
          ((p.x * 0.5 + 0.5) * rr.width + rr.left).toFixed(1) + "px, " +
          ((0.5 - p.y * 0.5) * rr.height + rr.top).toFixed(1) + "px)";
        this.tipEl.classList.add("show");
        // an unseen finish outranks the plain "ready" line: the tip says what the ✓ means;
        // an idle DUTY bean says when its next round fires instead of a bare "ready"
        const tnow = Math.floor(Date.now() / 1000);
        const done = tipPad.unseenDone && tipPad.sess.state === "ready";
        const dutyIdle = !done && tipPad.sess.duty
          && (tipPad.sess.state === "ready" || tipPad.sess.state === "awaitingBg");
        const line = done ? finishedLine(tipPad.sess, tnow)
          : dutyIdle ? `on duty${tipPad.sess.duty!.selfPaced ? " (self-paced)" : ""} — next round in ${hiveAge(Math.max(0, tipPad.sess.duty!.nextT - tnow))}`
          : stateLine(tipPad.sess, tnow);
        if (line !== this.tipText) {
          this.tipText = line;
          (this.tipEl.querySelector(".tip-state") as HTMLElement).textContent = line;
          (this.tipEl.querySelector(".tip-dot") as HTMLElement).style.background = tipPad.sess.color?.bg || "#8a8a8a";
          this.tipEl.dataset.state = done ? "done" : isKnownState(tipPad.sess.state) ? tipPad.sess.state : "unknown";
        }
      } else this.tipEl.classList.remove("show");
    } else {
      this.tipEl.classList.remove("show");
      this.tipText = "";
    }
    // the ghost glides to its aim (the drag's target cell, or its park at the frontier)
    // and breathes faintly, waking under a carried tray bean
    if (!this.ghostHover && this.ghostSlot !== this.ghostHome) this.ghostTo(this.ghostHome);
    this.ghost.position.lerp(this.ghostTarget, 1 - Math.exp(-14 * dt));
    const gTarget = this.ghostHover ? 0.5 : 0.06 + 0.03 * (0.5 + 0.5 * Math.sin(this.clock * 1.2));
    this.ghostRingMat.opacity = ease(this.ghostRingMat.opacity, gTarget, dt, 8);
    this.ghostPlus.material.opacity = ease(this.ghostPlus.material.opacity, this.ghostHover ? 0.95 : 0.22, dt, 8);
    this.ghostPlus.position.y = 0.6 + (this.ghostHover ? 0.1 * Math.abs(Math.sin(this.clock * 4)) : 0);

    // the portrait: everything below is a spring off portraitSid — the camera tracks the
    // subject's hex per frame (it may still be gliding home), the fog swallows the rest
    // of the world, and the view eases sideways to center the face right of the dock
    const pPad = this.portraitSid ? this.pads.get(this.portraitSid) : null;
    if (pPad && pPad.dyingT < 0) {
      this.target.set(pPad.group.position.x, 0.78, pPad.group.position.z);
    }
    const fog = this.scene.fog as THREE.FogExp2;
    this.fogCur = ease(this.fogCur, pPad ? 0.085 : 0.013, dt, 4);
    fog.density = this.fogCur;
    // rule of thirds: the dock owns the left third (its CSS width ≈ 33vw, measured by
    // boot), so centering the face in the REMAINING space lands it on the right third
    // line; the vertical offset eases the eyes up toward the top third with it
    this.shiftCur = ease(this.shiftCur, pPad ? this.dockW : 0, dt, 5);
    const rw = this.root.clientWidth || 1, rh = this.root.clientHeight || 1;
    if (this.shiftCur > 0.5) {
      const rise = (this.shiftCur / this.dockW) * (rh / 6);
      this.camera.setViewOffset(rw, rh, -this.shiftCur / 2, rise, rw, rh);
    } else this.camera.clearViewOffset();

    // idle drift: after 6s hands-off the whole board breathes on a slow orbital sway
    // (never during a portrait — a close-up must hold still). The sway starts FROM ZERO
    // and ramps over ~3s: keying the sine to a global clock made it kick in mid-swing —
    // a visible surge every time the hand went idle (the user 2026-08-19).
    const driftT = this.idleT - 6;
    const driftYaw = driftT > 0 && !pPad
      ? Math.sin(driftT * 0.1) * 0.05 * Math.min(1, driftT / 3)
      : 0;
    this.yawCur = ease(this.yawCur, this.yaw + driftYaw, dt, 5);
    this.pitchCur = ease(this.pitchCur, this.pitch, dt, 5);
    this.distCur = ease(this.distCur, this.dist, dt, 5);
    this.targetCur.lerp(this.target, 1 - Math.exp(-5 * dt));
    this.camera.position.set(
      this.targetCur.x + this.distCur * Math.cos(this.pitchCur) * Math.sin(this.yawCur),
      this.targetCur.y + this.distCur * Math.sin(this.pitchCur),
      this.targetCur.z + this.distCur * Math.cos(this.pitchCur) * Math.cos(this.yawCur),
    );
    this.camera.lookAt(this.targetCur);

    // a carried bean is re-pinned under the CURSOR every frame — here, after the camera
    // eases, not per pointer event — so nothing (spring, idle drift, a still pointer) can
    // pull it out from under the pointer. Intersecting the flat CARRY_Y plane keeps the
    // cursor→bean mapping exact anywhere on screen.
    if (this.dragSession) {
      this.idleT = 0;                        // holding someone is not idle — no board sway mid-carry
      const pad = this.pads.get(this.dragSession.sid);
      if (pad && pad.dyingT < 0) {
        this.camera.updateMatrixWorld();
        const o = this.camera.position;
        const v = new THREE.Vector3(this.pointer.x, this.pointer.y, 0.5).unproject(this.camera).sub(o).normalize();
        const t = (CARRY_Y - o.y) / v.y;
        if (t > 0) pad.carryTo(new THREE.Vector3(o.x + v.x * t, CARRY_Y, o.z + v.z * t));
      }
    }

    // ambient emitters, event-free by design: smoke while blocked, zzz while dozing — a
    // steady drizzle tied to the CURRENT state, not a transition (they stop the moment the
    // state moves on, no latch to forget)
    for (const pad of this.pads.values()) {
      if (pad.dyingT >= 0) continue;
      const st = pad.sess.state;
      if (st === "blocked" && Math.random() < dt * 1.6) {
        const at = pad.group.position.clone(); at.y += PAD_H + 0.75;
        at.x += 0.25; at.z += 0.45;           // off the dead laptop, not the bean's head
        this.particles.burst(at, [0x555b63, 0x3c4148, 0x6a7076], 2, 0.22, 0.55, 1.4);
      }
      if (st === "ready" && pad.dozing() && Math.random() < dt * 0.8) {
        const at = pad.group.position.clone(); at.y += PAD_H + 1.25;
        at.x += 0.3;
        this.particles.burst(at, [0x9cd2ff, 0x6fa8d8], 1, 0.14, 0.3, 1.8);
      }
    }
    const dead: string[] = [];
    for (const [psid, pad] of this.pads)
      if (pad.update(dt, this.yawCur, this.distCur, psid === this.hovered || psid === this.selected)) dead.push(psid);
    for (const psid of dead) {
      const pad = this.pads.get(psid)!;
      this.scene.remove(pad.group);
      pad.dispose();
      this.pads.delete(psid);
      this.rayDirty = true;
    }
    this.particles.update(dt);

    this.composer.render();
    // our slice of the frame, render submission included — what the governor governs
    const work = performance.now() - t0;
    this.workAcc += work;
    if (work > this.workWorst) this.workWorst = work;
    requestAnimationFrame(this.frame);
  };
}

// slot persistence: the board must look the same after a reload — spatial memory is the
// point of the hex layout. Plain sid→slot map; entries for sids gone from the payload are
// kept (a revived session returns HOME) until the map grows past 200, then absentees drop.
const SLOTS_KEY = "hive:slots";
function loadSlots(live: Map<string, number>): Map<string, number> {
  try {
    const d = JSON.parse(localStorage.getItem(SLOTS_KEY) || "null");
    const m = new Map<string, number>();
    if (d && typeof d === "object") for (const k of Object.keys(d)) if (Number.isInteger(d[k])) m.set(k, d[k]);
    for (const [k, v] of live) m.set(k, v);
    return m;
  } catch { return new Map(live); }
}
function saveSlots(m: Map<string, number>) {
  try {
    const o: Record<string, number> = {};
    for (const [k, v] of m) o[k] = v;
    localStorage.setItem(SLOTS_KEY, JSON.stringify(o));
  } catch { /* private mode etc — the board still works, it just re-deals on reload */ }
}

// unseen-cue persistence (the finished ✓ and the filed-ask shout share one shape): the
// latch must survive a reload (stepping away is safe), absentees keep their stamps for
// revival, and the folds bound the records.
const SEEN_DONE_KEY = "hive:seenDone";
const SEEN_ASK_KEY = "hive:seenAsk";
function loadSeen(key: string): SeenDone {
  try {
    const d = JSON.parse(localStorage.getItem(key) || "null");
    const out: SeenDone = {};
    if (d && typeof d === "object") for (const k of Object.keys(d)) if (Number.isFinite(d[k])) out[k] = d[k];
    return out;
  } catch { return {}; }
}
function saveSeen(key: string, m: SeenDone) {
  try { localStorage.setItem(key, JSON.stringify(m)); } catch { /* see saveSlots */ }
}

// ── the tray: one draggable bean per MODEL, bottom-left. Config embedded in the board's
// own drag language: drag a bean onto a free hexagon and a session with that model spawns
// there; the badge on each bean cycles its EFFORT; a clean CLICK makes that bean the
// default every new session seeds from. Choices come from the server — never hardcoded. ──
export class Tray {
  private defaults: { model?: string; effort?: string } = {};
  private roster = "";                       // the built list's identity — rebuild on change

  constructor(private world: HiveWorld, private bridge: Bridge) {}

  setChoices(models: ModelChoice[], efforts: string[], defaults: Defaults, shelf: ShelfItem[] = []) {
    this.defaults.model = defaults.model;
    this.defaults.effort = defaults.effort;
    // both rows are DYNAMIC (live model roster; the shelf follows duties.json)
    const key = JSON.stringify([models, shelf]);
    if (models.length && key !== this.roster) {
      this.roster = key;
      document.getElementById("hive-tray")?.remove();
      this.build(models, efforts, shelf);
    }
    this.mark();
  }

  private mark() {
    document.querySelectorAll<HTMLElement>("#hive-tray .ht-bean").forEach((b) => {
      b.classList.toggle("default", b.dataset.model === (this.defaults.model || ""));
    });
  }

  private build(models: ModelChoice[], efforts: string[], shelf: ShelfItem[]) {
    const tray = document.createElement("div");
    tray.id = "hive-tray";
    // ── the SHELF: saved specialists, hired by drag. A live one sits dimmed (already
    // on the board); dragging a chip to the trash dock removes it from the shelf. ──
    if (shelf.length) {
      // the shelf folds away (the user 2026-08-19) — a one-line header keeps it a click
      // deeper, and the fold survives reloads
      const FOLD_KEY = "hive:shelfFold";
      const head = document.createElement("button");
      head.className = "ht-head";
      const row = document.createElement("div");
      row.className = "ht-shelf";
      const setFold = (folded: boolean) => {
        row.hidden = folded;
        head.innerHTML = `<i>${folded ? "▸" : "▾"}</i> shelf <em>${shelf.length}</em>`;
        try { localStorage.setItem(FOLD_KEY, folded ? "1" : "0"); } catch { /* private mode */ }
      };
      head.addEventListener("click", () => setFold(!row.hidden));
      tray.appendChild(head);
      setFold(localStorage.getItem(FOLD_KEY) === "1");
      for (const it of shelf) {
        const chip = document.createElement("div");
        chip.className = "ht-bean ht-duty" + (it.live ? " live" : "");
        chip.title = it.live
          ? `${it.name} is on the board (every ${it.every})`
          : `Drag onto a hexagon to hire ${it.name} (every ${it.every}). Drag to the trash to remove it from the shelf.`;
        chip.innerHTML = '<div class="hb-body"><b class="hb-hat"></b><i></i><i></i></div>' +
          `<span class="hb-name">${it.name.replace(/[<>&"]/g, "")}</span>` +
          `<span class="hb-eff">${it.every}</span>`;
        chip.addEventListener("pointerdown", (e) => {
          if (it.live) return;                       // already working — nothing to drag
          e.preventDefault();
          const sx = e.clientX, sy = e.clientY;
          let carried: HTMLElement | null = null;
          const move = (ev: PointerEvent) => {
            if (!carried && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
              carried = chip.cloneNode(true) as HTMLElement;
              carried.classList.add("carried");
              document.body.appendChild(carried);
              chip.classList.add("lifted");
            }
            if (carried) {
              carried.style.transform = `translate(${ev.clientX}px,${ev.clientY}px) translate(-50%, -60%)`;
              this.world.shelfDragMove(ev.clientX, ev.clientY, `Drop to remove ${it.name} from the shelf`);
            }
          };
          const up = (ev: PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            chip.classList.remove("lifted");
            if (carried) {
              carried.remove();
              const hit = this.world.shelfDragMove(ev.clientX, ev.clientY, "");
              if (hit === "trash") this.bridge.op({ op: "unsave", name: it.name });
              else if (typeof hit === "number") this.world.summonAt(hit, it.name);
              this.world.trayDragEnd();
            }
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        });
        row.appendChild(chip);
      }
      tray.appendChild(row);
      // fold state is applied AFTER chips exist (setFold above ran before the loop)
      row.hidden = localStorage.getItem("hive:shelfFold") === "1";
    }
    const effKey = "hive:trayEfforts";
    let effSel: Record<string, string> = {};
    try { effSel = JSON.parse(localStorage.getItem(effKey) || "{}") || {}; } catch { /* fresh */ }
    const mrow = document.createElement("div");
    mrow.className = "ht-models";
    for (const mc of models) {
      const bean = document.createElement("div");
      bean.className = "ht-bean";
      bean.dataset.model = mc.value;
      bean.title = "Drag onto a hexagon to spawn a " + mc.label +
        " session there. Click to make it the default for new sessions.";
      bean.innerHTML = '<div class="hb-body"><i></i><i></i></div><span class="hb-name">' + mc.label +
        '</span><button class="hb-eff" title="Reasoning effort for sessions spawned from this bean"></button>';
      const effBtn = bean.querySelector(".hb-eff") as HTMLButtonElement;
      effBtn.textContent = effSel[mc.value] || this.defaults.effort || "high";
      effBtn.addEventListener("click", (e) => {
        e.stopPropagation();                   // the badge cycles effort; it never sets the default
        const cur = efforts.indexOf(effBtn.textContent || "");
        effBtn.textContent = efforts[(cur + 1) % Math.max(1, efforts.length)] || "high";
        effSel[mc.value] = effBtn.textContent!;
        try { localStorage.setItem(effKey, JSON.stringify(effSel)); } catch { /* private mode */ }
      });
      bean.addEventListener("pointerdown", (e) => {
        if ((e.target as HTMLElement).closest(".hb-eff")) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        let chip: HTMLElement | null = null;   // the carried copy; created once the press MOVES
        const move = (ev: PointerEvent) => {
          if (!chip && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
            chip = bean.cloneNode(true) as HTMLElement;
            chip.classList.add("carried");
            document.body.appendChild(chip);
            bean.classList.add("lifted");
          }
          if (chip) {
            chip.style.transform = "translate(" + ev.clientX + "px," + ev.clientY + "px) translate(-50%, -60%)";
            this.world.trayHover(ev.clientX, ev.clientY);   // the board's ghost glides to the target cell
          }
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          bean.classList.remove("lifted");
          const effort = effBtn.textContent || "";
          if (chip) {
            chip.remove();
            const slot = this.world.trayHover(ev.clientX, ev.clientY);
            if (slot !== null) this.world.spawnAt(slot, mc.value, effort, mc.label);
            this.world.trayDragEnd();
          } else {
            // clean click: this bean (model + its effort) becomes the seed for new
            // sessions. Optimistic mark now; the server's defaults push corrects.
            this.defaults.model = mc.value;
            this.defaults.effort = effort;
            this.mark();
            this.bridge.op({ op: "setDefaults", model: mc.value, effort });
          }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      mrow.appendChild(bean);
    }
    tray.appendChild(mrow);
    document.body.appendChild(tray);
    this.mark();
  }
}
