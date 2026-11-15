import { openRollout as open } from './confine.js';
import { createInterface } from 'node:readline';

/** Scan a fixed snapshot one record at a time, including records larger than
 * the read buffer. Appends during a read belong to the next refresh. */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const handle = await open(filePath);
  try {
    const { size } = await handle.stat();
    if (!size) return;
    const input = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let failure: Error | undefined;
    // readline's async iterator does not forward input stream errors.
    input.on('error', error => { failure = error; lines.close(); });
    try {
      for await (const line of lines) yield line;
      if (failure) throw failure;
    } finally {
      lines.close();
      input.destroy();
    }
  } finally {
    await handle.close();
  }
}

/** Bounded snapshot scan for background summaries. Oversized records are
 * discarded before UTF-8 decoding/JSON parsing; callers report omissions. */
export async function* readBoundedJsonlLines(filePath: string, limits: {
  maxBytes: number;
  maxLineBytes: number;
  onOversizedLine: () => void;
}): AsyncGenerator<string> {
  const handle = await open(filePath);
  try {
    const { size } = await handle.stat();
    if (size > limits.maxBytes) throw new Error('Transcript exceeds background read limit');
    if (!size) return;
    const input = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
    let parts: Buffer[] = [];
    let bytes = 0;
    let skipping = false;
    try {
      for await (const chunk of input) {
        const buffer = chunk as Buffer;
        let start = 0;
        while (start < buffer.length) {
          const newline = buffer.indexOf(0x0a, start);
          const end = newline < 0 ? buffer.length : newline;
          const piece = buffer.subarray(start, end);
          if (!skipping) {
            bytes += piece.length;
            if (bytes > limits.maxLineBytes) {
              parts = [];
              skipping = true;
              limits.onOversizedLine();
            } else parts.push(piece);
          }
          if (newline < 0) break;
          if (!skipping) yield Buffer.concat(parts, bytes).toString('utf8');
          parts = [];
          bytes = 0;
          skipping = false;
          start = newline + 1;
        }
      }
      if (bytes && !skipping) yield Buffer.concat(parts, bytes).toString('utf8');
    } finally {
      input.destroy();
    }
  } finally {
    await handle.close();
  }
}

/** Read at most `maxBytes` from the beginning of a file. */
export async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath);
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Read a bounded JSONL tail. When the read starts in the middle of a record,
 * discard that fragment so callers only receive complete leading lines.
 */
export async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath);
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const body = buffer.subarray(0, bytesRead);
    if (start === 0) return body.toString('utf8');
    const firstNewline = body.indexOf(0x0a);
    return firstNewline < 0 ? '' : body.subarray(firstNewline + 1).toString('utf8');
  } finally {
    await handle.close();
  }
}
