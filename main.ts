// token-radar-01: the entrypoint (Node 22, standard library only).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input
// <file|dir>), prices every rankable pre-token protocol with the radar-2
// model in lib/model.ts, writes the ranked board to /output/board.json,
// writes the dashboard's data beside it as data.js, copies this repo's
// dashboard/ and screenshots/ into /output, and finishes with
// /output/dossier.json, the summary the judge reads, built by the vendored
// make.fun library. The dossier goes last: the scorer rebuilds it from this
// very /output and compares the bytes, so nothing may change after it.
//
// The dashboard is a static page — index.html, app.css and app.js — with no
// framework and no network. It reads data.js, which this program writes from
// the same board, and it re-runs the model on every row it shows, so the
// page's arithmetic and the board's numbers are visibly the same.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardProblem, buildDash, dashScript, readSnap } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The scorer's own caps, matching reference/gate.json: the text cap shapes
// the dossier's bytes, the other two only refuse.
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASH_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const die = (message: string, code = 1): never => {
  process.stderr.write('token radar: ' + message + '\n');
  process.exit(code);
};

// Pull --name <value> (or --name=value) out of the arguments.
const flagValue = (name: string, fallback: string): string => {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--' + name && i + 1 < args.length) return args[i + 1]!;
    if (a.startsWith('--' + name + '=')) return a.slice(name.length + 3);
  }
  return fallback;
};

const givenInput = flagValue('input', '/input');
const snapPath = givenInput.endsWith('.json') ? givenInput : join(givenInput, 'snapshot.json');
if (!existsSync(snapPath)) {
  die(
    `no snapshot at ${snapPath}: pass --input <snapshot.json|directory> or mount the sealed /input`,
    2,
  );
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = readSnap(readFileSync(snapPath, 'utf8'));
const { board, dash } = buildDash(snap);
const problem = boardProblem(board, snap);
if (problem !== null) die('the model wrote a board the gate refuses: ' + problem);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(outDir, 'data.js'), dashScript(dash));

// Copy a directory's plain files into `to`, skipping dotfiles, and report
// the names that landed.
const copyDir = (from: string, to: string): string[] => {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const landed: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    landed.push(name);
  }
  return landed;
};

const dashCopied = copyDir(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
if (dashCopied.length === 0) die('dashboard/ holds no files: the page is what the judge reads');

const shotsCopied = copyDir(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shotsCopied.length < 3) {
  die(
    `screenshots/ holds ${shotsCopied.length} image${shotsCopied.length === 1 ? '' : 's'}: ` +
      'hand in 3, the board, a detail view and a filtered view',
  );
}
for (const name of shotsCopied) {
  if (!SHOT_NAME.test(name)) {
    die(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  }
}

// Written last, from this /output exactly as it stands. First prove the
// board survived the trip to disk: re-read it and refuse to seal a dossier
// over a board that lost rows on the way.
const writtenBoard = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')) as {
  rows?: unknown[];
};
if (!Array.isArray(writtenBoard.rows) || writtenBoard.rows.length !== board.length) {
  die(
    `board.json on disk holds ${Array.isArray(writtenBoard.rows) ? writtenBoard.rows.length : 'no'} rows, ` +
      `not the ${board.length} the model scored: refusing to write the dossier`,
  );
}

writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: DOSSIER_TEXT_CAP,
    screenshots: SHOT_LIMITS,
    dashboard: DASH_LIMITS,
  }),
);

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ` +
    `${board.length} rows scored (${dash.early_size} early, ${dash.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ` +
    `${join(outDir, 'dashboard')} (${dashCopied.length} files), ` +
    `${join(outDir, 'screenshots')} (${shotsCopied.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
