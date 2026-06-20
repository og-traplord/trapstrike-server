import {
  dequantizeMoveAxis,
  dequantizePitch,
  dequantizeYaw,
  quantizeMoveAxis,
  quantizePitch,
  quantizeYaw,
  type PlayerInput,
} from "@trapstrike/shared";
import { ByteReader, ByteWriter } from "./bytebuf";
import { Button, MsgType } from "./constants";

/**
 * InputCmd (client → server) — sent every client frame, ~10 bytes.
 * Layout per PROTOCOL.md. `fireTick` is present only when the FIRE bit is set.
 */
export function encodeInputCmd(cmd: PlayerInput, w: ByteWriter = new ByteWriter(16)): Uint8Array {
  w.u8(MsgType.InputCmd);
  w.u16(cmd.seq);
  w.u8(clampDt(cmd.dtMs));
  w.i8(quantizeMoveAxis(cmd.moveX));
  w.i8(quantizeMoveAxis(cmd.moveZ));
  w.u16(quantizeYaw(cmd.yaw));
  w.i16(quantizePitch(cmd.pitch));
  w.u8(cmd.buttons);
  if (cmd.buttons & Button.FIRE) w.u32(cmd.fireTick ?? 0);
  return w.bytes();
}

export function decodeInputCmd(buf: Uint8Array): PlayerInput {
  const r = new ByteReader(buf);
  const type = r.u8();
  if (type !== MsgType.InputCmd) {
    throw new Error(`expected InputCmd (0x01), got 0x${type.toString(16)}`);
  }
  const seq = r.u16();
  const dtMs = r.u8();
  const moveX = dequantizeMoveAxis(r.i8());
  const moveZ = dequantizeMoveAxis(r.i8());
  const yaw = dequantizeYaw(r.u16());
  const pitch = dequantizePitch(r.i16());
  const buttons = r.u8();
  const cmd: PlayerInput = { seq, dtMs, moveX, moveZ, yaw, pitch, buttons };
  if (buttons & Button.FIRE) cmd.fireTick = r.u32();
  return cmd;
}

function clampDt(ms: number): number {
  const r = Math.round(ms);
  return r < 1 ? 1 : r > 255 ? 255 : r;
}
