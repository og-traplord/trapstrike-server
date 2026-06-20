export const PROTOCOL_VERSION = 1;

/** First byte of every packet (PROTOCOL.md §type tag). */
export const MsgType = {
  InputCmd: 0x01,
  Snapshot: 0x02,
  Event: 0x03, // reliable channel — implemented in M4
  Hello: 0x10,
  Welcome: 0x11,
} as const;

/** InputCmd.buttons bitfield. (Movement bits mirror @trapstrike/shared BTN_*.) */
export const Button = {
  FIRE: 1 << 0,
  JUMP: 1 << 1,
  CROUCH: 1 << 2,
  RELOAD: 1 << 3,
  USE: 1 << 4,
  ADS: 1 << 5,
  WALK: 1 << 6, // Shift = slow/quiet walk
} as const;

/** Snapshot entity-record flags: which fields are present + state bits. */
export const EntFlag = {
  POS: 1 << 0,
  VEL: 1 << 1,
  YAW: 1 << 2,
  HP: 1 << 3,
  STATE: 1 << 4,
  IS_SELF: 1 << 5,
  SPAWNED: 1 << 6,
  DESPAWNED: 1 << 7,
} as const;

/** Entity.state enum. */
export const EntityState = {
  ALIVE: 0,
  DEAD: 1,
  RESPAWNING: 2,
} as const;

/** Event.eventType enum (reliable channel). */
export const EventType = {
  HIT: 1,
  KILL: 2,
  SPAWN: 3,
  ROUND_START: 4,
  ROUND_END: 5,
  SOUND: 6,
} as const;
