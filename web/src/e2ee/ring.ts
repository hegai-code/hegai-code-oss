import { parsePairingCode } from '@cc-remote/shared';
import { b64urlToBytes, importKey, keyIdOf, type KeySource } from './crypto.js';
import { useSyncExternalStore } from 'react';

/**
 * The browser's key ring for private machines: one non-extractable AES-GCM
 * CryptoKey per key id, kept in IndexedDB (the structured clone of a
 * CryptoKey stores the handle, not the bytes). Where IndexedDB is not
 * available (a private window), keys live for the page only - still correct,
 * just forgotten on reload.
 *
 * The pairing code is the key itself: it is imported once and never kept.
 */

interface Entry {
  kid: string;
  machineId: string;
  key: CryptoKey;
  addedAt: number;
}

const DB_NAME = 'cc-e2ee';
const STORE = 'keys';

const byKid = new Map<string, Entry>();
let loaded: Promise<void> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'kid' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readAll(): Promise<Entry[]> {
  const db = await openDb();
  try {
    return await new Promise<Entry[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as Entry[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function write(entry: Entry): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function remove(kid: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(kid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Load the ring once. Safe to call from anywhere, any number of times. */
export function ringReady(): Promise<void> {
  loaded ??= (async () => {
    try {
      for (const e of await readAll()) byKid.set(e.kid, e);
    } catch {
      /* no IndexedDB: the ring is this page's memory */
    }
    changed();
  })();
  return loaded;
}

export const keys: KeySource = {
  forKid: (kid) => byKid.get(kid),
  latestFor: (machineId) => {
    let best: Entry | undefined;
    for (const e of byKid.values()) {
      if (e.machineId === machineId && (!best || e.addedAt > best.addedAt)) best = e;
    }
    return best;
  },
};

/** Whether this browser holds a key for ANY machine: once it does, a content
 *  frame it cannot place on a machine is not sent in the clear. */
export function hasAnyKey(): boolean {
  return byKid.size > 0;
}

export function hasKeyFor(machineId: string): boolean {
  return keys.latestFor(machineId) !== undefined;
}

export class PairingError extends Error {}

/**
 * Pair this device with a private machine from the code the machine printed.
 * `expectMachineId` (the machine the person is looking at) refuses a code for
 * another machine, so a wrong paste cannot silently pair the wrong one.
 */
export async function addPairingCode(code: string, expectMachineId?: string): Promise<{ machineId: string; kid: string }> {
  await ringReady();
  const parsed = parsePairingCode(code);
  if (!parsed) throw new PairingError('Это не код пары: он начинается с hcp1. и печатается командой --pair на машине.');
  if (expectMachineId && parsed.machineId !== expectMachineId) {
    throw new PairingError('Код от другой машины.');
  }
  const raw = b64urlToBytes(parsed.key);
  if (raw.length !== 32) throw new PairingError('Ключ повреждён: неверная длина.');
  const kid = await keyIdOf(raw);
  const entry: Entry = { kid, machineId: parsed.machineId, key: await importKey(raw), addedAt: Date.now() };
  byKid.set(kid, entry);
  try {
    await write(entry);
  } catch {
    /* kept for this page only */
  }
  changed();
  return { machineId: parsed.machineId, kid };
}

/** Forget every key of a machine (this device can no longer read it). */
export async function forgetMachine(machineId: string): Promise<void> {
  await ringReady();
  for (const e of [...byKid.values()]) {
    if (e.machineId !== machineId) continue;
    byKid.delete(e.kid);
    try {
      await remove(e.kid);
    } catch {
      /* page memory only */
    }
  }
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void ringReady();
  return () => listeners.delete(listener);
}

/** Re-renders when a key is added or forgotten; the value is a version. */
export function useRingVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** Is this machine private, and does this device hold its key? */
export function usePrivacy(machineId: string, isPrivate: boolean | undefined): { private: boolean; hasKey: boolean } {
  useRingVersion();
  return { private: isPrivate === true, hasKey: isPrivate === true && hasKeyFor(machineId) };
}

// ---- The «Ввести код пары» dialog is opened from several screens ------------

export interface PairRequest {
  machineId?: string;
  machineName?: string;
}
let pairListener: ((r: PairRequest) => void) | undefined;

export function requestPairDialog(r: PairRequest): void {
  pairListener?.(r);
}

export function onPairRequest(listener: ((r: PairRequest) => void) | undefined): void {
  pairListener = listener;
}
