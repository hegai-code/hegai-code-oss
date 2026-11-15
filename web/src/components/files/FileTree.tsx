import { useCallback, useEffect, useState } from 'react';
import type { FsEntry, FsListResult } from '@cc-remote/shared';
import { joinRel } from './paths.js';

/**
 * The orientation pane: directories only, expanded lazily.
 *
 * Files are deliberately absent. A tree that lists every file duplicates the
 * list beside it and pushes the folder you are looking for off the screen; the
 * tree answers "where am I in the project", the list answers "what is here".
 */

interface NodeProps {
  rel: string;
  name: string;
  depth: number;
  activeRel: string;
  version: number;
  list: (rel: string) => Promise<FsListResult>;
  onOpen: (rel: string) => void;
}

function TreeNode({ rel, name, depth, activeRel, version, list, onOpen }: NodeProps) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<FsEntry[] | null>(null);

  // Reveal the branch the current directory is in, so arriving on a deep URL
  // does not show a collapsed root with no clue where you are.
  const onPath = activeRel === rel || activeRel.startsWith(`${rel}/`);
  useEffect(() => {
    if (onPath && !open) setOpen(true);
  }, [onPath, open]);

  // `version` re-reads an expanded branch after a mutation: create a folder and
  // it appears here too, instead of the tree quietly disagreeing with the list.
  useEffect(() => {
    if (!open) return;
    setKids(null);
  }, [version]);

  useEffect(() => {
    if (!open || kids !== null) return;
    let cancelled = false;
    void list(rel)
      .then((r) => {
        if (!cancelled) setKids(r.entries.filter((e) => e.kind === 'dir'));
      })
      .catch(() => {
        // A failure is NOT an empty directory. Collapsing leaves `kids` null, so
        // opening the branch again retries — turning it into `[]` made a
        // transient error look like a permanently empty folder.
        if (!cancelled) setOpen(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kids, list, rel]);

  return (
    <div>
      <div
        className={`ftree-row${activeRel === rel ? ' active' : ''}`}
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={() => {
          setOpen(true);
          onOpen(rel);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
            onOpen(rel);
          }
        }}
      >
        <span
          className="tw"
          onClick={(e) => {
            // The twisty is a separate target: expanding a branch to look
            // inside it is not the same gesture as going there.
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▾' : '▸'}
        </span>
        <span className="ftree-name">{name}</span>
      </div>
      {open &&
        kids?.map((k) => (
          <TreeNode
            key={k.name}
            rel={joinRel(rel, k.name)}
            name={k.name}
            depth={depth + 1}
            activeRel={activeRel}
            version={version}
            list={list}
            onOpen={onOpen}
          />
        ))}
    </div>
  );
}

export function FileTree({
  rootLabel,
  activeRel,
  list,
  onOpen,
  ready,
  version,
}: {
  rootLabel: string;
  activeRel: string;
  /** Bumped by any mutation, so the tree re-reads instead of going stale. */
  version: number;
  list: (rel: string) => Promise<FsListResult>;
  onOpen: (rel: string) => void;
  /** Socket is up. This component loads on mount, so without the guard a cold
   *  load of a deep URL fires before `hello` is answered and the rejection
   *  surfaces as a hub-wide error toast. */
  ready: boolean;
}) {
  const [kids, setKids] = useState<FsEntry[] | null>(null);
  const stable = useCallback((rel: string) => list(rel), [list]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setKids(null);
    void stable('')
      .then((r) => {
        if (!cancelled) setKids(r.entries.filter((e) => e.kind === 'dir'));
      })
      .catch(() => {
        // Same reasoning as a branch: leave it unknown so the next attempt can
        // retry, rather than asserting the root is empty.
        if (!cancelled) setKids(null);
      });
    return () => {
      cancelled = true;
    };
  }, [stable, ready, version]);

  return (
    <nav className="ftree" aria-label="Дерево папок">
      <div
        className={`ftree-row${activeRel === '' ? ' active' : ''}`}
        style={{ paddingLeft: 8 }}
        onClick={() => onOpen('')}
        role="button"
        tabIndex={0}
      >
        <span className="tw">▾</span>
        <span className="ftree-name">{rootLabel}</span>
      </div>
      {kids?.map((k) => (
        <TreeNode
          key={k.name}
          rel={k.name}
          name={k.name}
          depth={1}
          activeRel={activeRel}
          version={version}
          list={stable}
          onOpen={onOpen}
        />
      ))}
    </nav>
  );
}
