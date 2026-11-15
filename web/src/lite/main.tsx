import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IconContext } from '@phosphor-icons/react';
import { installChunkRecovery, warmMarkdownWhenIdle } from '../bootstrap.js';
import { LiteApp } from './LiteApp.js';
// The full client's sheet, whole: the transcript's rules are spread over its
// base block and several later override layers, and cutting them out is how a
// second, subtly different transcript gets made. `lite.css` comes after and
// adds only the shell's own `lt-` classes, on the same tokens.
import '../styles.css';
import './lite.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: 'regular' }}>
      <LiteApp />
    </IconContext.Provider>
  </StrictMode>,
);

warmMarkdownWhenIdle();
installChunkRecovery();

// No service worker is registered here, on purpose. The shell has no offline
// start to protect yet, and a worker is the one thing on an origin that
// outlives a deploy; `public/sw.js` exists only to retire one that should
// never have been registered on this host (see the note in that file).
