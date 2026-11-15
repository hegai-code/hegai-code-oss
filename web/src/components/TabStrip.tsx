import { useState, type DragEvent } from 'react';
import { AgentMark } from './AgentMark.js';
import { Plus, X } from '../icons.js';
import type { PaneRoute } from '../router.js';
import {
  TAB_MIME,
  activateTab,
  closeTab,
  dropBeside,
  dropIntoGroup,
  getDragging,
  openTabBeside,
  setDragging,
  tabKey,
  useDragging,
  type DragSource,
  type TabGroup,
} from '../tabs.js';
import type { TabInfo } from './tabInfo.js';

/** Start dragging something the split understands: a tab, or a session row
 *  from the side panel. The MIME is ours so a drop elsewhere ignores it; the
 *  text is for Firefox, which starts no drag at all without some payload. */
export function startTabDrag(e: DragEvent, src: DragSource, text: string) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(TAB_MIME, JSON.stringify(src));
  if (!e.dataTransfer.types.includes('text/plain')) e.dataTransfer.setData('text/plain', text);
  // Next task, not now: the drop zones appear over the panes when this lands,
  // and changing the DOM inside dragstart can make Chrome cancel the drag.
  window.setTimeout(() => setDragging(src), 0);
}
export function endTabDrag() {
  setDragging(null);
}

/**
 * The tabs of one group of the split, VS Code style: the active one is the
 * pane below; click another to show it, ✕ or a middle click to close, drag to
 * reorder, onto another group's strip to move it there, or onto a pane's edge
 * to open it as a column of its own (GroupDropZone).
 *
 * The VS Code theme only: the Hegai themes hide it (CSS), and tabs.ts keeps
 * one tab per pane there, so there is nothing behind it to show.
 */
export function TabStrip({
  group,
  groupIndex,
  focused,
  info,
  newTab,
}: {
  group: TabGroup;
  groupIndex: number;
  focused: boolean;
  info: (p: PaneRoute) => TabInfo;
  /** What «+» opens beside the active tab (tabInfo.ts `makeNewTabRoute`). */
  newTab?: (beside: PaneRoute | undefined) => PaneRoute;
}) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragging = useDragging();

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!getDragging()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    // Before or after the tab under the pointer; past the last tab → the end.
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-index]');
    if (!el) {
      setDropAt(group.tabs.length);
      return;
    }
    const i = Number(el.dataset.tabIndex);
    const r = el.getBoundingClientRect();
    setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const src = getDragging();
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    const at = dropAt ?? group.tabs.length;
    setDropAt(null);
    setDragging(null);
    dropIntoGroup(src, groupIndex, at);
  };

  return (
    <div
      className={`tabstrip${group.tabs.length === 1 ? ' single' : ''}${focused ? ' focused' : ''}${dragging ? ' dragging' : ''}`}
      role="tablist"
      aria-label="Закладки"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={onDrop}
    >
      {group.tabs.map((t, i) => {
        const x = info(t);
        const on = i === group.active;
        return (
          <div
            // Identity, not the title: a fresh session's title arrives late, and
            // a remount mid-drag would lose the dragend.
            key={tabKey(t)}
            data-tab-index={i}
            className={`tab-item${on ? ' on' : ''}${dropAt === i ? ' drop-before' : ''}${dropAt === i + 1 && i === group.tabs.length - 1 ? ' drop-after' : ''}`}
            title={x.hint ? `${x.title}\n${x.hint}` : x.title}
            draggable
            onDragStart={(e) => startTabDrag(e, { kind: 'tab', group: groupIndex, index: i }, x.title)}
            onDragEnd={() => {
              setDropAt(null);
              endTabDrag();
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(groupIndex, i);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className="tab-main"
              onClick={() => activateTab(groupIndex, i)}
            >
              {x.working ? (
                <AgentMark source={x.source} provider={x.provider} size={12} />
              ) : x.attention ? (
                <span className="tab-mark" aria-label="Нужно решение" />
              ) : null}
              <span className="tab-title">{x.title}</span>
            </button>
            <button
              type="button"
              className="tab-x"
              onClick={() => closeTab(groupIndex, i)}
              aria-label={`Закрыть «${x.title}»`}
              title="Закрыть закладку"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {newTab && (
        <button
          type="button"
          className="tab-new"
          onClick={() => openTabBeside(groupIndex, newTab(group.tabs[group.active]))}
          title="Новый чат в этом проекте"
          aria-label="Новый чат в этом проекте"
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}

type Zone = 'left' | 'center' | 'right';

/**
 * The drop targets over a group's body, shown only while a tab or a session
 * row is being dragged (never for a file from the desktop — the composer takes
 * those). The outer thirds open the dragged thing as a new column on that
 * side; the middle moves it into this group.
 */
export function GroupDropZone({ groupIndex }: { groupIndex: number }) {
  const dragging = useDragging();
  const [zone, setZone] = useState<Zone | null>(null);
  if (!dragging) return null;
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    setZone(x < 0.3 ? 'left' : x > 0.7 ? 'right' : 'center');
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const src = getDragging();
    const z = zone;
    setZone(null);
    setDragging(null);
    if (!src || !z) return;
    if (z === 'center') {
      // A tab dropped on its own group's body: nothing to do.
      if (src.kind === 'tab' && src.group === groupIndex) return;
      dropIntoGroup(src, groupIndex);
    } else {
      dropBeside(src, groupIndex, z);
    }
  };
  return (
    <div
      className="group-drop"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={onDrop}
    >
      {zone && <div className={`group-drop-hint ${zone}`} />}
    </div>
  );
}
