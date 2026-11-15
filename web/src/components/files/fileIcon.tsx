import type { FsEntry } from '@cc-remote/shared';
import {
  Folder,
  FileIcon,
  FileJs,
  FileTs,
  FileCode,
  FileCss,
  FileHtml,
  FileMd,
  FilePy,
  FileRs,
  FileSql,
  FileZip,
  FilePdf,
  FileImage,
  FileAudio,
  FileVideo,
  FileCsv,
  FileText,
  FileDoc,
  FileXls,
} from '../../icons.js';
import { extOf } from './paths.js';

/**
 * The glyph and tone for an entry.
 *
 * A file manager is read at a glance, and the glance is carried by shape and
 * colour before any name is parsed: a folder of photos should look like photos,
 * a folder of code like code. One generic sheet for every file is what made the
 * first version read as a database table with paths in it.
 *
 * The tones are the four avatar tokens already in the system, reused rather
 * than invented — the palette does not grow for this.
 */

type Glyph = typeof FileIcon;

interface Kind {
  icon: Glyph;
  tone: 'code' | 'doc' | 'media' | 'data' | 'muted';
}

const BY_EXT: Record<string, Kind> = {
  // code — one tone, so a source tree reads as one material
  ts: { icon: FileTs, tone: 'code' },
  tsx: { icon: FileTs, tone: 'code' },
  js: { icon: FileJs, tone: 'code' },
  jsx: { icon: FileJs, tone: 'code' },
  mjs: { icon: FileJs, tone: 'code' },
  cjs: { icon: FileJs, tone: 'code' },
  py: { icon: FilePy, tone: 'code' },
  rs: { icon: FileRs, tone: 'code' },
  go: { icon: FileCode, tone: 'code' },
  java: { icon: FileCode, tone: 'code' },
  kt: { icon: FileCode, tone: 'code' },
  swift: { icon: FileCode, tone: 'code' },
  c: { icon: FileCode, tone: 'code' },
  h: { icon: FileCode, tone: 'code' },
  cpp: { icon: FileCode, tone: 'code' },
  cs: { icon: FileCode, tone: 'code' },
  php: { icon: FileCode, tone: 'code' },
  rb: { icon: FileCode, tone: 'code' },
  sh: { icon: FileCode, tone: 'code' },
  bash: { icon: FileCode, tone: 'code' },
  zsh: { icon: FileCode, tone: 'code' },
  ps1: { icon: FileCode, tone: 'code' },
  css: { icon: FileCss, tone: 'code' },
  scss: { icon: FileCss, tone: 'code' },
  html: { icon: FileHtml, tone: 'code' },
  htm: { icon: FileHtml, tone: 'code' },
  sql: { icon: FileSql, tone: 'code' },

  // documents
  md: { icon: FileMd, tone: 'doc' },
  mdx: { icon: FileMd, tone: 'doc' },
  markdown: { icon: FileMd, tone: 'doc' },
  txt: { icon: FileText, tone: 'doc' },
  rst: { icon: FileText, tone: 'doc' },
  log: { icon: FileText, tone: 'muted' },
  pdf: { icon: FilePdf, tone: 'media' },
  doc: { icon: FileDoc, tone: 'media' },
  docx: { icon: FileDoc, tone: 'media' },
  rtf: { icon: FileDoc, tone: 'media' },

  // data
  json: { icon: FileCode, tone: 'data' },
  jsonc: { icon: FileCode, tone: 'data' },
  yaml: { icon: FileCode, tone: 'data' },
  yml: { icon: FileCode, tone: 'data' },
  toml: { icon: FileCode, tone: 'data' },
  xml: { icon: FileCode, tone: 'data' },
  csv: { icon: FileCsv, tone: 'data' },
  tsv: { icon: FileCsv, tone: 'data' },
  xls: { icon: FileXls, tone: 'data' },
  xlsx: { icon: FileXls, tone: 'data' },

  // media
  png: { icon: FileImage, tone: 'media' },
  jpg: { icon: FileImage, tone: 'media' },
  jpeg: { icon: FileImage, tone: 'media' },
  gif: { icon: FileImage, tone: 'media' },
  webp: { icon: FileImage, tone: 'media' },
  svg: { icon: FileImage, tone: 'media' },
  avif: { icon: FileImage, tone: 'media' },
  heic: { icon: FileImage, tone: 'media' },
  mp3: { icon: FileAudio, tone: 'media' },
  wav: { icon: FileAudio, tone: 'media' },
  m4a: { icon: FileAudio, tone: 'media' },
  mp4: { icon: FileVideo, tone: 'media' },
  mov: { icon: FileVideo, tone: 'media' },
  webm: { icon: FileVideo, tone: 'media' },

  // archives
  zip: { icon: FileZip, tone: 'muted' },
  gz: { icon: FileZip, tone: 'muted' },
  tar: { icon: FileZip, tone: 'muted' },
  tgz: { icon: FileZip, tone: 'muted' },
  rar: { icon: FileZip, tone: 'muted' },
  '7z': { icon: FileZip, tone: 'muted' },
  dmg: { icon: FileZip, tone: 'muted' },
};

export function kindOf(entry: FsEntry): Kind {
  if (entry.kind === 'dir') return { icon: Folder, tone: 'code' };
  return BY_EXT[extOf(entry.name)] ?? { icon: FileIcon, tone: 'muted' };
}

export function FileGlyph({ entry, size = 14 }: { entry: FsEntry; size?: number }) {
  const { icon: Glyph, tone } = kindOf(entry);
  return (
    <span className={`fglyph fglyph-${tone}`}>
      <Glyph size={size} />
    </span>
  );
}
