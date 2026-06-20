import { ByteReader, ByteWriter } from "./bytebuf";
import { MsgType } from "./constants";

/**
 * Event (server → client) — discrete, must-not-drop game events on the reliable
 * channel. M4 emits HIT / KILL / SPAWN using a fixed combat payload. Other event
 * types (round start/end, sound) can extend this later.
 */
export interface GameEvent {
  eventType: number;
  tick: number;
  attackerId: number;
  victimId: number;
  weapon: number;
  damage: number;
  hpRemaining: number;
}

export function encodeEvent(ev: GameEvent, w: ByteWriter = new ByteWriter(16)): Uint8Array {
  w.u8(MsgType.Event);
  w.u8(ev.eventType);
  w.u32(ev.tick);
  w.u16(ev.attackerId);
  w.u16(ev.victimId);
  w.u8(ev.weapon);
  w.u8(ev.damage);
  w.u8(ev.hpRemaining);
  return w.bytes();
}

export function decodeEvent(buf: Uint8Array): GameEvent {
  const r = new ByteReader(buf);
  const type = r.u8();
  if (type !== MsgType.Event) {
    throw new Error(`expected Event (0x03), got 0x${type.toString(16)}`);
  }
  const eventType = r.u8();
  const tick = r.u32();
  const attackerId = r.u16();
  const victimId = r.u16();
  const weapon = r.u8();
  const damage = r.u8();
  const hpRemaining = r.u8();
  return { eventType, tick, attackerId, victimId, weapon, damage, hpRemaining };
}
