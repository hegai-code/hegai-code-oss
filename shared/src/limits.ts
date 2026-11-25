/**
 * Attachment limits — ONE place for numbers that used to live in four.
 *
 * The web composer, the agent's zod schemas and the hub's `sanitize_*`
 * (server-rs/src/hub/attachments.rs) all bound the same things: how large one inlined image
 * may be, how many attachments ride in one message, and how much base64 one
 * WebSocket frame may carry. Each copy was hand-typed, and the hub's copy was
 * the only one that mattered — anything the others let through, it truncated
 * without a word. The Rust side cannot import this file, so
 * `server-rs/src/hub/tests.rs` carries a test (`attachment_limits_match_shared`) that
 * reads it from disk and compares the numbers; change them HERE and let that
 * test tell you where else.
 *
 * Why each number is what it is:
 *
 * - `IMAGE_MAX_EDGE`: the API refuses a many-image request outright if any
 *   image is over 2000px on a side, and downscales to 1568 for its own
 *   accounting anyway — pixels above that cost bytes and buy no detail.
 * - `IMAGE_B64_MAX` / `FILE_B64_MAX`: per-item ceilings on the base64 string
 *   (~6 MB and ~9 MB of bytes). An image past it goes as a FILE (written to the
 *   machine's disk and read from there), not dropped.
 * - `ATTACH_B64_TOTAL_MAX`: the whole turn rides ONE frame, and a frame over the
 *   hub's socket ceiling (`WS_MAX_MESSAGE_BYTES`, 32 MiB) is a protocol
 *   violation that closes the connection — the message vanishes and the app
 *   reconnects saying nothing. 20 MiB leaves room for the JSON around it.
 */

/** Longest side an inlined image keeps, in pixels. */
export const IMAGE_MAX_EDGE = 1568;

/** Most images in one message. */
export const MAX_IMAGES_PER_MESSAGE = 8;

/** Most non-image files in one message. */
export const MAX_FILES_PER_MESSAGE = 4;

/** Base64 length ceiling for one inlined image (~6 MB of bytes). */
export const IMAGE_B64_MAX = 8 * 1024 * 1024;

/** Base64 length ceiling for one attached file (~9 MB of bytes). */
export const FILE_B64_MAX = 12 * 1024 * 1024;

/** Base64 budget for ALL attachments of one message together. */
export const ATTACH_B64_TOTAL_MAX = 20 * 1024 * 1024;

/**
 * Folder (at a project's root) where chat attachments over the inline limit are
 * uploaded to. The hub lets a control-share member write ONLY here
 * (`CHAT_UPLOAD_DIR` in server-rs/src/hub/rpc.rs — keep the two equal).
 */
export const CHAT_UPLOAD_DIR = '.hegai-uploads';

/** Bytes of a single file the web composer will stage as a file attachment. */
export const FILE_BYTES_MAX = 8 * 1024 * 1024;

/** Bytes of an image the web composer will INLINE; larger ones go as files. */
export const INLINE_IMAGE_BYTES_MAX = 6 * 1024 * 1024;

/**
 * How long the hub keeps a session's writer guard after an agent reports a
 * terminal `run_status` with `closing: true` and no `writer_released` has
 * followed (protocol.ts). The runtime process behind a Codex run outlives the
 * close by up to its kill grace — `KILL_GRACE_MS` (5 s) before SIGKILL in
 * agent/src/codex-run.ts — plus the second the agent allows for the kill to
 * land, plus margin for the `writer_released` frame to cross the wire. The
 * deadline is what covers an agent that exits before the process does (the
 * update/shutdown path) or whose socket is down when the process finally goes.
 * The Rust side cannot import this file: `server-rs/src/hub/tests.rs` reads it
 * from disk and compares (`run_closing_limit_matches_shared`).
 */
export const RUN_CLOSING_MAX_MS = 8 * 1000;
