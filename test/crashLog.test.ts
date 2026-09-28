import { describe, expect, it } from 'vitest';
import { explainCrash, parseCrashLog } from '../src/game/crashLog';

// Shortened from real Project Diablo 2 logs.
const START = `---------------------------------------------------------------
SE Realm startup at 2026-09-27 10:29:58.846
---------------------------------------------------------------
10:29:58.846  Diablo II running under Windows XP (Version 5.010)
`;
const LOADING = `10:30:29.528  Error opening file: DATA\\LOCAL\\UI\\ENG\\EXPANSION\\.dc6
10:30:29.528  ------------------------------------------------------
10:30:29.529  PROGRAM:       Diablo II v1.13
10:30:29.529  TIME:          2026-09-27 10:30:29.528
10:30:29.529  ***** UNHANDLED EXCEPTION: ACCESS_VIOLATION (c0000005)
10:30:29.529  Fault address:  027D1614 01:00010614 C:\\Program Files\\Diablo II\\ProjectD2\\D2CMP.dll
10:30:29.546      Base:027C0000h  Size: 108000h  Name:D2CMP.dll        Path:C:\\Program Files\\Diablo II\\ProjectD2\\D2CMP.dll
`;
const AUTOMAP = `10:34:37.671  PROGRAM:       Diablo II v1.13
10:34:37.671  TIME:          2026-09-27 10:34:37.669
10:34:37.671  --------  FILE:     LINE: 965  --------

Halt
Location : , line #965
Expression : Unrecoverable internal error 6fb11827
10:34:45.946  Enumerate modules...
10:40:56.301      Base:6FAB0000h  Size:  E1000h  Name:D2Client.dll     Path:C:\\Program Files\\Diablo II\\ProjectD2\\D2Client.dll
`;

describe('crash logs', () => {
  it('finds each crash with its time, kind, module and the files the game failed to open just before', () => {
    const crashes = parseCrashLog(START + LOADING + START + AUTOMAP);
    expect(crashes).toHaveLength(2);
    expect(crashes[0]).toMatchObject({ time: '2026-09-27 10:30:29', kind: 'exception', what: 'ACCESS_VIOLATION', module: 'D2CMP.dll', offset: 0x11614, failedFiles: ['DATA\\LOCAL\\UI\\ENG\\EXPANSION\\.dc6'] });
    // A halt: its line and address, placed in its module from the module list; the earlier session's failures don't carry over.
    expect(crashes[1]).toMatchObject({ time: '2026-09-27 10:34:37', kind: 'halt', line: 965, address: 0x6fb11827, module: 'D2Client.dll', offset: 0x61827, failedFiles: [] });
  });

  it('explains the crashes a map can cause, and says so when it does not know one', () => {
    const [loading, automap] = parseCrashLog(START + LOADING + START + AUTOMAP);
    expect(explainCrash(loading, () => [])).toMatchObject({ known: true, check: true, title: "A level's loading-screen image (EntryFile) is empty" });
    const missing = explainCrash({ ...loading, failedFiles: ['DATA\\LOCAL\\UI\\ENG\\EXPANSION\\G4.dc6'] }, (e) => (e === 'G4' ? ['205 Guild 4'] : []));
    expect(missing.title).toBe('The loading-screen image "G4.dc6" doesn\'t exist');
    expect(missing.detail).toMatch(/Levels using it: 205 Guild 4/);
    expect(explainCrash(automap).title).toMatch(/too far out/);
    expect(explainCrash({ ...automap, address: 0x6fb119c1, line: undefined }).title).toMatch(/AutoMap is 1/);
    expect(explainCrash({ time: '', kind: 'exception', what: 'ACCESS_VIOLATION', failedFiles: ['DATA\\GLOBAL\\TILES\\Guild\\PD2\\house9\\x.dt1'] }).title).toBe("The game couldn't open a tile library (DT1): x.dt1");
    const unknown = explainCrash({ time: '', kind: 'halt', what: 'Unrecoverable internal error 6ff6339e', module: 'Fog.dll', offset: 0x1339e, line: 646, failedFiles: [] });
    expect(unknown.known).toBe(false);
    expect(unknown.title).toBe('The game stopped on an internal check in Fog.dll +0x1339e, line 646');
  });

  it('does not place a jump to an invalid address in a module', () => {
    const [c] = parseCrashLog('PROGRAM: Diablo II\n***** UNHANDLED EXCEPTION: ACCESS_VIOLATION (c0000005)\nFault address:  00000408 00:00000000 C:\\Diablo II\\Game.exe\n    Base:00400000h  Size:  11000h  Name:Game.exe');
    expect(c.module).toBeUndefined();
    expect(explainCrash(c).title).toBe("The game crashed (ACCESS_VIOLATION) at address 0x408, outside the game's code");
  });
});
