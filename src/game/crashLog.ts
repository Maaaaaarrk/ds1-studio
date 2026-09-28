/**
 * Reading Diablo II's crash logs (D2YYMMDD.txt in the game's folder) and explaining the crashes a map can cause, in
 * plain words. The game appends to the day's log on every start and every crash; a crash block has a "PROGRAM:" header,
 * then either "***** UNHANDLED EXCEPTION" with the fault address and module, or a "Halt" (an assertion) with its line
 * and address, then a list of the loaded modules. "Error opening file" lines just before it name what was missing.
 */

export interface CrashModule {
  name: string;
  base: number;
  size: number;
}

export interface Crash {
  /** "2026-09-27 10:30:29" (from the block's TIME line). */
  time: string;
  kind: 'exception' | 'halt';
  /** Exception name ("ACCESS_VIOLATION") or the halt's expression ("Unrecoverable internal error 6fb11827"). */
  what: string;
  /** Module the crash happened in, and the offset in it, when known. */
  module?: string;
  offset?: number;
  /** The halt's source line. */
  line?: number;
  /** Address of the crash (a halt's comes from its expression). */
  address?: number;
  /** Files the game failed to open in the moments before (this session, most recent last). */
  failedFiles: string[];
}

const MODULE_RE = /Base:([0-9A-F]+)h\s+Size:\s*([0-9A-F]+)h\s+Name:(\S+)/i;

/** Every crash in a log, oldest first. */
export function parseCrashLog(text: string): Crash[] {
  const out: Crash[] = [];
  let failed: string[] = [];
  let cur: Crash | null = null;
  let modules: CrashModule[] = [];
  const finish = () => {
    if (!cur) return;
    const c = cur;
    if (c.address !== undefined && !c.module) {
      const m = modules.find((x) => c.address! >= x.base && c.address! < x.base + x.size);
      if (m) {
        c.module = m.name;
        c.offset = c.address - m.base;
      }
    }
    if (c.what || c.module) out.push(c);
    cur = null;
    modules = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\d\d:\d\d:\d\d\.\d+\s+/, '');
    if (/^SE Realm startup at|Diablo II running under/.test(line)) {
      finish();
      failed = [];
      continue;
    }
    const open = /^Error opening file:\s*(.+)$/.exec(line);
    if (open) {
      failed.push(open[1].trim());
      if (failed.length > 20) failed.shift();
      continue;
    }
    if (/^PROGRAM:/.test(line)) {
      finish();
      cur = { time: '', kind: 'exception', what: '', failedFiles: [...failed] };
      failed = [];
      continue;
    }
    if (!cur) continue;
    const c: Crash = cur;
    const time = /^TIME:\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(line);
    if (time) c.time = time[1];
    const exc = /^\*+ UNHANDLED EXCEPTION:\s*(\S+)/.exec(line);
    if (exc) {
      c.kind = 'exception';
      c.what = exc[1];
    }
    const fault = /^Fault address:\s+([0-9A-F]+)\s+([0-9A-F]+):([0-9A-F]+)\s+(.+)$/i.exec(line);
    if (fault) {
      c.address = parseInt(fault[1], 16);
      const file = fault[4].trim();
      // Section 00 means the address is in no module's code (the game jumped somewhere invalid): leave it unplaced.
      if (!/unknown/i.test(file) && fault[2] !== '00') {
        c.module = file.split(/[\\/]/).pop()!;
        // The offset is within section 01 (.text), which starts at 0x1000 in these DLLs.
        c.offset = parseInt(fault[3], 16) + (fault[2] === '01' ? 0x1000 : 0);
      }
    }
    if (/^Halt\b/.test(line)) c.kind = 'halt';
    const loc = /^Location\s*:.*line #(\d+)/.exec(line);
    if (loc) {
      c.kind = 'halt';
      c.line = Number(loc[1]);
    }
    const expr = /^Expression\s*:\s*(.+)$/.exec(line);
    if (expr) {
      c.what = expr[1].trim();
      const a = /([0-9a-f]{6,8})\s*$/i.exec(c.what);
      if (a) c.address = parseInt(a[1], 16);
    }
    const mod = MODULE_RE.exec(line);
    if (mod) modules.push({ base: parseInt(mod[1], 16), size: parseInt(mod[2], 16), name: mod[3] });
  }
  finish();
  return out;
}

export interface CrashExplanation {
  /** One line: what happened, in plain words. */
  title: string;
  /** What to do about it. */
  detail: string;
  /** Whether DS1 Studio recognises this crash (else it only shows the facts). */
  known: boolean;
  /** Running the compatibility check on the map finds and fixes it. */
  check?: boolean;
}

const hex = (n?: number) => (n === undefined ? '' : `0x${n.toString(16)}`);

/** What a crash means for a map maker. `levelsWithEntry` names the levels whose EntryFile is a given image name. */
export function explainCrash(c: Crash, levelsWithEntry?: (entry: string) => string[]): CrashExplanation {
  const where = !c.module && c.address !== undefined ? `at address ${hex(c.address)}, outside the game's code` : `in ${c.module ?? 'an unknown module'}${c.offset !== undefined ? ` +${hex(c.offset)}` : ''}${c.line ? `, line ${c.line}` : ''}`;
  const lastFailed = c.failedFiles[c.failedFiles.length - 1];
  // A loading-screen image the game couldn't open (Levels.txt EntryFile): it reads it anyway and crashes in D2CMP.
  const entry = lastFailed ? /\\EXPANSION\\([^\\]*)\.dc6$/i.exec(lastFailed) : null;
  if (entry) {
    const name = entry[1];
    const levels = name ? (levelsWithEntry?.(name) ?? []) : [];
    return {
      known: true,
      check: true,
      title: name ? `The loading-screen image "${name}.dc6" doesn't exist` : "A level's loading-screen image (EntryFile) is empty",
      detail: `Levels.txt's EntryFile names the picture shown while a level loads (data/local/ui/eng/expansion/<EntryFile>.dc6). The game couldn't open ${name ? `"${name}.dc6"` : 'an image with no name'} and crashed on the loading screen.${levels.length ? ` Levels using it: ${levels.join(', ')}.` : ''} Set EntryFile to an image the game has (Harrogath's is A5L1); the compatibility check offers the fix.`,
    };
  }
  // D2Client's automap marker range check: the level is placed too far out in the act's world.
  const inClient = (lo: number, hi: number) => c.address !== undefined && c.address >= lo && c.address <= hi;
  if (c.kind === 'halt' && (inClient(0x6fb117a0, 0x6fb11840) || (/d2client/i.test(c.module ?? '') && c.line !== undefined && c.line >= 965 && c.line <= 967))) {
    return {
      known: true,
      check: true,
      title: 'A level is placed too far out in its act (automap positions overflow)',
      detail: "The automap keeps positions in 16 bits: a level whose Levels.txt OffsetX − OffsetY or OffsetX + OffsetY is too large makes the game stop as soon as a player, NPC or object is put on the automap (usually a few steps in). The compatibility check finds the level and moves it to a free spot inside the range.",
    };
  }
  // D2Client revealing the whole automap of a level whose LvlPrest AutoMap is 1 but that isn't a town.
  if (c.kind === 'halt' && inClient(0x6fb11900, 0x6fb11a40)) {
    return {
      known: true,
      check: true,
      title: "A level reveals its whole automap on entry (LvlPrest AutoMap is 1) but isn't a town",
      detail: "Only the game's five towns may have AutoMap 1 in LvlPrest.txt; for any other level the game stops while entering it. Set AutoMap to 0 (the compatibility check offers it).",
    };
  }
  // D2Lang stops at start-up when a string table's checksum doesn't match (a .tbl edited without updating it).
  if (/d2lang/i.test(c.module ?? '') || (c.kind === 'halt' && c.line === 208 && c.address !== undefined && c.address < 0x01000000)) {
    return {
      known: true,
      title: 'A string table (.tbl) is damaged or its checksum is wrong',
      detail: "The game checks each .tbl in data/local/lng when it starts; one written by a tool that didn't update its checksum stops it. Save the table again with DS1 Studio (it writes the checksum) or restore its .bak.",
    };
  }
  // Any other file the game couldn't open just before crashing.
  if (lastFailed) {
    const f = lastFailed.replace(/\\/g, '/');
    const what = /\.dt1$/i.test(f)
      ? { t: 'tile library (DT1)', d: "A level type in LvlTypes.txt lists it and the map's Dt1Mask selects it. Put the DT1 there, or take it out of the level type (Map panel, tile libraries)." }
      : /\.ds1$/i.test(f)
        ? { t: 'map (DS1)', d: 'LvlPrest.txt points at it (File1-File6). Check the path and that the file is in your mod.' }
        : /\.(dcc|cof)$/i.test(f) || /\/(objects|monsters|chars)\//i.test(f)
          ? { t: 'sprite', d: "An object, NPC or monster there uses graphics that aren't in the game or your mod." }
          : /\.tbl$/i.test(f)
            ? { t: 'string table', d: 'Check the file exists in data/local/lng/<language>.' }
            : { t: 'file', d: "Check the path exists in your mod or the game's archives." };
    return {
      known: true,
      check: /\.(dt1|ds1)$/i.test(f),
      title: `The game couldn't open a ${what.t}: ${f.split('/').pop()}`,
      detail: `${f}. ${what.d} (The crash itself was ${where}.)`,
    };
  }
  return {
    known: false,
    check: true,
    title: `${c.kind === 'halt' ? 'The game stopped on an internal check' : `The game crashed (${c.what || 'unknown error'})`} ${where}`,
    detail: `DS1 Studio doesn't recognise this one.${c.kind === 'halt' && c.what ? ` "${c.what}".` : ''} If it happens when entering a map you made, run the compatibility check on that map; if not, it may be the game or another mod.`,
  };
}
