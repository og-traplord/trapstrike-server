// Float ↔ quantized-int conversions. The single source of truth for how the wire
// format maps to semantic units. Both server and client import these so a decoded
// snapshot means the exact same metres/radians on both ends.

import {
  MOVE_AXIS_MAX,
  PITCH_LIMIT,
  PITCH_SCALE,
  POS_SCALE,
  TAU,
  VEL_SCALE,
  YAW_SCALE,
} from "./constants";

const I16_MIN = -32768;
const I16_MAX = 32767;
const I8_MIN = -127;
const I8_MAX = 127;

export function clampInt(v: number, lo: number, hi: number): number {
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize radians into [0, 2π). */
export function normalizeAngle(rad: number): number {
  let a = rad % TAU;
  if (a < 0) a += TAU;
  return a;
}

// --- Position (i16) ---
export const quantizePos = (m: number): number => clampInt(m * POS_SCALE, I16_MIN, I16_MAX);
export const dequantizePos = (q: number): number => q / POS_SCALE;

// --- Velocity (i16) ---
export const quantizeVel = (mps: number): number => clampInt(mps * VEL_SCALE, I16_MIN, I16_MAX);
export const dequantizeVel = (q: number): number => q / VEL_SCALE;

// --- Yaw (u16, full turn) ---
export const quantizeYaw = (rad: number): number =>
  Math.round(normalizeAngle(rad) * YAW_SCALE) & 0xffff;
export const dequantizeYaw = (q: number): number => q / YAW_SCALE;

// --- Pitch (i16, ±90°) ---
export const quantizePitch = (rad: number): number => {
  const c = rad < -PITCH_LIMIT ? -PITCH_LIMIT : rad > PITCH_LIMIT ? PITCH_LIMIT : rad;
  return clampInt(c * PITCH_SCALE, I16_MIN, I16_MAX);
};
export const dequantizePitch = (q: number): number => q / PITCH_SCALE;

// --- Move axis (i8, -1..1) ---
export const quantizeMoveAxis = (v: number): number =>
  clampInt(v * MOVE_AXIS_MAX, I8_MIN, I8_MAX);
export const dequantizeMoveAxis = (q: number): number => q / MOVE_AXIS_MAX;
