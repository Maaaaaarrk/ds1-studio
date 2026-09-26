// Prints the README's keyboard-shortcut tables from the app's own keymap (npx tsx tools/shortcuts-md.ts).
import { ACTIONS } from '../src/ui/keybindings';
import { FIXED } from '../src/ui/ShortcutsDialog';

const groups = [...new Set(ACTIONS.map((a) => a.group))];
const k = (s: string) => s.split('+').map((p) => `<kbd>${p}</kbd>`).join(' + ');
for (const g of groups) {
  console.log(`**${g}**\n\n| Action | Default key |\n| --- | --- |`);
  for (const a of ACTIONS.filter((x) => x.group === g)) console.log(`| ${a.label} | ${a.key ? k(a.key) : '—'} |`);
  console.log('');
}
console.log('**Mouse & navigation**\n\n| Action | Control |\n| --- | --- |');
for (const [what, how] of FIXED) console.log(`| ${what} | ${how} |`);
