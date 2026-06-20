import {
  dequantizePos,
  dequantizeVel,
  dequantizeYaw,
  quantizePos,
  quantizeVel,
  quantizeYaw,
  type Vec3,
} from "@trapstrike/shared";
import { ByteReader, ByteWriter } from "./bytebuf";
import { EntFlag, MsgType } from "./constants";

/** One entity record inside a snapshot. Presence of optional fields is driven by `flags`. */
export interface EntitySnap {
  id: number;
  flags: number;
  pos?: Vec3;
  vel?: Vec3;
  yaw?: number;
  hp?: number;
  state?: number;
}

export interface Snapshot {
  tick: number;
  ackSeq: number; // last InputCmd seq the server processed for THIS client
  entities: EntitySnap[];
}

/**
 * Snapshot (server → client) — broadcast at 20 Hz, delta-compressed: only the
 * fields flagged present are written. Sent unreliably in production (M5); over the
 * M1 WebSocket transport it's reliable+ordered so last-sent == last-received.
 */
export function encodeSnapshot(snap: Snapshot, w: ByteWriter = new ByteWriter(512)): Uint8Array {
  w.u8(MsgType.Snapshot);
  w.u32(snap.tick);
  w.u16(snap.ackSeq);
  w.u8(snap.entities.length);

  for (const e of snap.entities) {
    w.u16(e.id);
    w.u16(e.flags);
    if (e.flags & EntFlag.POS && e.pos) {
      w.i16(quantizePos(e.pos.x));
      w.i16(quantizePos(e.pos.y));
      w.i16(quantizePos(e.pos.z));
    }
    if (e.flags & EntFlag.VEL && e.vel) {
      w.i16(quantizeVel(e.vel.x));
      w.i16(quantizeVel(e.vel.y));
      w.i16(quantizeVel(e.vel.z));
    }
    if (e.flags & EntFlag.YAW && e.yaw !== undefined) w.u16(quantizeYaw(e.yaw));
    if (e.flags & EntFlag.HP && e.hp !== undefined) w.u8(e.hp);
    if (e.flags & EntFlag.STATE && e.state !== undefined) w.u8(e.state);
  }
  return w.bytes();
}

export function decodeSnapshot(buf: Uint8Array): Snapshot {
  const r = new ByteReader(buf);
  const type = r.u8();
  if (type !== MsgType.Snapshot) {
    throw new Error(`expected Snapshot (0x02), got 0x${type.toString(16)}`);
  }
  const tick = r.u32();
  const ackSeq = r.u16();
  const count = r.u8();
  const entities: EntitySnap[] = [];

  for (let i = 0; i < count; i++) {
    const id = r.u16();
    const flags = r.u16();
    const e: EntitySnap = { id, flags };
    if (flags & EntFlag.POS) {
      e.pos = { x: dequantizePos(r.i16()), y: dequantizePos(r.i16()), z: dequantizePos(r.i16()) };
    }
    if (flags & EntFlag.VEL) {
      e.vel = { x: dequantizeVel(r.i16()), y: dequantizeVel(r.i16()), z: dequantizeVel(r.i16()) };
    }
    if (flags & EntFlag.YAW) e.yaw = dequantizeYaw(r.u16());
    if (flags & EntFlag.HP) e.hp = r.u8();
    if (flags & EntFlag.STATE) e.state = r.u8();
    entities.push(e);
  }
  return { tick, ackSeq, entities };
}
