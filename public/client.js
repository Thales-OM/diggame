'use strict';

// ---------- Diggame client ----------
// Three rules this file exists to enforce:
//
//  1. The server owns the position. `you` is only ever copied from a message -
//     never derived from a keypress and a success flag. That arithmetic is what
//     desynchronised the old client (BUGS: "a block does not disappear until
//     the client reloads").
//  2. Every action carries `rev`. If the server answers `needSync`, the whole
//     state is taken again. If the answers stop arriving (a dropped packet, a
//     reconnect) a timer asks for one, so a dead socket cannot leave a stale
//     view on screen.
//  3. The only local clock arithmetic is the *display* of dig progress and
//     item timers, which is a rendering nicety and is corrected by the next
//     tick. Nothing that affects gameplay is computed here.

const socket = io();
const TILE = 32;

// The five playable classes. The order is the wire protocol: the server only
// ever knows the index, and each name is the one shown to the player.
const MODELS = [
  { id: 'wizard',    name: 'Wizard' },
  { id: 'knight',    name: 'Knight' },
  { id: 'barbarian', name: 'Barbarian' },
  { id: 'noble',     name: 'Noble' },
  { id: 'bandit',    name: 'Bandit' },
];

const ITEM = {
  armor: {
    sym: '🛡', label: 'armour',
    desc: 'Banked as points of protection. They soak a spike strike or a boss blow before it reaches your health, and whatever is left comes back when a fight ends.',
  },
  shovel: {
    sym: '⛏', label: 'golden shovel',
    desc: 'For a few seconds every dig is instant. The timer counts down in the pack.',
  },
  dynamite: {
    sym: '💣', label: 'dynamite',
    desc: 'Clears the cells around you from the field - plain stone included, bedrock and bosses excepted - or hurls at the boss for heavy damage during a fight.',
  },
  trap: {
    sym: '🪤', label: 'bear trap',
    desc: 'Left in a cell to catch the next thing that walks in, or armed in a fight to snap at the boss.',
  },
  potion: {
    sym: '🧪', label: 'potion', ally: true,
    desc: 'Mends your health: press Use here on the field, or drink it in a fight, where it can also be aimed at a wounded ally. Nothing happens if the target is unhurt.',
  },
};

/**
 * A display mirror of the server's WEAPONS table (server/game.js). The server
 * owns the numbers; this copy exists only so the inventory tooltips can describe
 * a weapon without shipping the whole table. Keep the two in step.
 */
const WEAPONS = {
  bare: {
    id: 'bare', name: 'Bare-handed', glyph: '👊',
    hit: 0.75, damage: 0, crit: 0.05, critMult: 2,
    desc: 'No weapon. Your own two hands are always ready.',
  },
  sword: {
    id: 'sword', name: 'Sword', glyph: '🗡',
    hit: 0.8, damage: 6, crit: 0.15, critMult: 2,
    desc: 'Basic and reliable: the most average hit rate, damage and crit chance.',
  },
  rapier: {
    id: 'rapier', name: 'Rapier', glyph: '🤺',
    hit: 0.6, damage: 5, crit: 0.45, critMult: 2,
    desc: 'Harder to land a hit, but crits far more often, for double damage.',
  },
  staff: {
    id: 'staff', name: 'Magic Staff', glyph: '🪄',
    hit: 0.8, damage: 6, crit: 0.1, critMult: 2,
    skill: { id: 'incantation', name: 'Incantation', mult: 2.5, chargeCrit: 0.05 },
    desc: 'Strikes like a sword, but can incantate for a much stronger blow.',
  },
};

/**
 * Hand-drawn pixel art for the battle screen. Each sprite is rows of characters
 * where '.' is transparent and every other character is a key into `palette`.
 * The rows are deliberately ragged; `drawSprite` reads each row on its own, so
 * an outline can be a pixel shorter than the body without a sea of padding.
 * The hero is recoloured per class (MODELS), so 'H' (hat) and 'B' (body) are
 * overwritten when it is drawn.
 */
// Fallback battle poses for a boss whose species the client does not know,
// chosen by `kind` (see bossArt). Every current boss draws its own species art
// from MONSTERS; these remain so a fight from an older save still has a face.
const BOSS_POSES = {
  warden: {
    palette: { H: '#4a148c', A: '#7b1fa2', S: '#d1b3ff', E: '#ffeb3b', O: '#1a1a1a' },
    pixels: [
      '.....OOOOOO.....',
      '....HHHHHHHH....',
      '...HHHHHHHHHH...',
      '...HHSSSSSSHH...',
      '...HSSEESSEESH..',
      '....SSSSSSSS....',
      '....SSSSSSSS....',
      '...OOAAAAAAOO...',
      '..OAAAAAAAAAAO..',
      '.OAAAAAAAAAAAAO.',
      '.OAAAAAAAAAAAAO.',
      '..OAAAAAAAAAAO..',
      '...AAAAAAAAAA...',
      '...AAA....AAA...',
      '..OOOO....OOOO..',
    ],
  },
  brute: {
    palette: { G: '#5a8f3a', O: '#1a1a1a', E: '#ffcc00', W: '#eeeeee' },
    pixels: [
      '..OO........OO..',
      '.OGGO......OGGO.',
      '.OGGGO....OGGGO.',
      '..OOGGGGGGGGOO..',
      '...GGGGGGGGGG...',
      '...GGEEGGEEGG...',
      '...GGGGGGGGGG...',
      '..GGGGWWWWGGGG..',
      '..GGGWWWWWWGGG..',
      '..GGGGGGGGGGGG..',
      '.GGGGGGGGGGGGGG.',
      '.GGGGGGGGGGGGGG.',
      '.GGGGGGGGGGGGGG.',
      '..GGG......GGG..',
      '..GGG......GGG..',
      '..OOO......OOO..',
    ],
  },
};

// ---------- the five classes, at field size and in the ring ----------
// One 16x16 sprite per class for the pit (blitted at 2x into a tile) and one
// larger pose for the battle stage. `MODELS` order is the wire order, so the
// keys here must line up with it. Kept beside BOSS_POSES so every pixel table
// the client owns lives in one place.
const HERO_FIELD = {
  wizard: {
    palette: { O: '#141420', A: '#3a4fc0', B: '#28348f', S: '#f0c090', E: '#141420', G: '#c9a227' },
    pixels: [
      '.......OO.......',
      '......OAAO......',
      '.....OAAAAO.....',
      '....OAAAAAAO....',
      '...OAAAAAAAAO...',
      '..OAAAAAAAAAAO..',
      '.....SSSSSS.....',
      '....SSSSSSSS....',
      '....SESSSSES....',
      '....SSSSSSSS....',
      '...OBBBBBBBBO...',
      '..OBBBBBBBBBBO..',
      '.GOBBBBBBBBBBOG.',
      '.GOBBBBBBBBBBOG.',
      '...OBBBBBBBBO...',
      '....OO....OO....',
    ],
  },
  knight: {
    palette: { O: '#141420', A: '#c2c6d2', H: '#878d9c', R: '#c0392b', S: '#f0c090', E: '#141420', G: '#e6e8f0' },
    pixels: [
      '.......RR.......',
      '......ORRO......',
      '.....OAAAAO.....',
      '....OAAAAAAO....',
      '....OEEAAEEO....',
      '....OAAAAAAO....',
      '.....OAAAAO.....',
      '....OAAAAAAO....',
      '...OAAAAAAAAO...',
      '..OAAAAAAAAAOG..',
      '..OAAAAAAAAAOG..',
      '..OAAAAAAAAAOG..',
      '...OAAAAAAAAG...',
      '....OAAAAAAG....',
      '....OHH..HHO....',
      '....OO....OO....',
    ],
  },
  barbarian: {
    palette: { O: '#141420', F: '#8a5a2b', S: '#e0b088', E: '#141420', H: '#3a2a1a', A: '#b8c0c8', W: '#7a5a2a' },
    pixels: [
      '.....HHHHHH.....',
      '....HHHHHHHH....',
      '....HHSSSSHH....',
      '....SSSSSSSS....',
      '....SESSSSES....',
      '....SSSSSSSS....',
      '.....SSSSSS.....',
      '...SSSSSSSSSS...',
      '..SSSSSSSSSSSS..',
      '.OSSFFSSSSFFSSO.',
      '.OSSFFFFFFFFSSO.',
      '..OFFFFFFFFFFO..',
      '...OFFFFFFFFO...',
      '....OFFFFFFO....',
      '.....OO..OO.....',
      '....OOO..OOO....',
    ],
  },
  noble: {
    palette: { O: '#141420', C: '#4a2f7a', G: '#d8b04d', S: '#f0c090', E: '#141420', H: '#3a2a1a', R: '#c0392b' },
    pixels: [
      '.......RR.......',
      '......OHHO......',
      '.....OHHHHO.....',
      '....OHHHHHHO....',
      '....OSSSSSSO....',
      '....SESSSSES....',
      '....SSSSSSSS....',
      '.....SSSSSS.....',
      '...OGCCCCCCGO...',
      '..OGCCCCCCCCGO..',
      '..OCCCCCCCCCCO..',
      '.OCCCCCCCCCCCCO.',
      '.OCCCCCCCCCCCCO.',
      '..OCCGGGGGGGCO..',
      '...OCCCCCCCCO...',
      '....OO....OO....',
    ],
  },
  bandit: {
    palette: { O: '#141420', C: '#33333d', S: '#e0b088', E: '#141420', R: '#8b1a1a', D: '#20202a', G: '#b8c0c8' },
    pixels: [
      '.....CCCCCC.....',
      '....CCCCCCCC....',
      '....CCCCCCCC....',
      '....CSSSSSSC....',
      '....RRRRRRRR....',
      '....RSSSSSSR....',
      '....SESSSSES....',
      '....SSSSSSSS....',
      '...OCCCCCCCCO...',
      '..OCCCCCCCCCCD..',
      '..OCCCCCCCCCCG..',
      '..OCCCCCCCCCCG..',
      '...OCCCCCCCCG...',
      '....OCCCCCCG....',
      '....ODD..DDO....',
      '....OO....OO....',
    ],
  },
};

const HERO_BATTLE = {
  wizard: {
    palette: { O: '#0d0d12', i: '#1b2a68', I: '#2f47b0', L: '#4a63d8', M: '#8296f0', g: '#4f4320', G: '#8a7333', y: '#c9a227', S: '#d9c3a6', s: '#a98f74', h: '#2a2a3a', W: '#c9c9d2', w: '#8f8f9a', b: '#241a10', B: '#3d2c17', j: '#4f93b5', J: '#a7d8ee' },
    pixels: [
      '...........................O....................',
      '..........................OiO...................',
      '.........................OLIiO..................',
      '.........................OLIIiO.................',
      '........................OLIIIIiO................',
      '......................OOLIIIIIIiOO..............',
      '.........OOOOOOOOOOOOOLIIIIIIIIIIiOOOOO.........',
      '........OyyyyyyyyyyyyyyyyyyyyyyyyyyJyyyO........',
      '........OIILLLLLLLLLLLLLLLLLLLLLLJJJJJIO........',
      '........OiiiiiiiiiiiiiiiiiiiiiiiiGJjJGiO........',
      '.........OOOOOOOOOOOhhhhhhhhh...JJjjjJJO........',
      '...................OSSSSSSSSS....JJjJJO.........',
      '...................OSSjSSSjSS....JJJJJO.........',
      '...................OSShSSShSS.....bJOO..........',
      '...................OSSSSSSSSS.....bBO...........',
      '..................OOWWWWWWWWw.....bBO...........',
      '.................OiiWWWWWWWWwii...bBO...........',
      '.................OIIIWWWWWWwIII...bBO...........',
      '.................OiiiWWWWWWwiii...bBO...........',
      '..................OLLWWWWWWwii....bBO...........',
      '..................OLLWWWWWWwii....bBO...........',
      '..................OLLGWWWWwGii....bBO...........',
      '.................OLLIGWWWWwGIii...bBO...........',
      '.................OLLIGWWWWwGIii...bBO...........',
      '.................OLLIGIWWwIGIii...bBO...........',
      '.................OLLIGIWWwIGIii...bBO...........',
      '.................OLLIGIWWwIGIii...bBO...........',
      '.................OLLIGIWWwIGIii...bBO...........',
      '.................OLLIGIIiIIGIii...bBO...........',
      '.................OLLIGIIiIIGIii...bBO...........',
      '................OLLIIGIIiIIGIIii..bBO...........',
      '................OLLIIGIIiIIGIIii..bBO...........',
      '................OLLIIGIIiIIGIIii..bBO...........',
      '................OLLIIGIIiIIGIIii..bBO...........',
      '................OLLIIGIIiIIGIIiissssO...........',
      '................OLLIIGIIiIIGIIiiSSSSO...........',
      '................OLLIIGIIiIIGIIiiSSSSO...........',
      '................OLLIIGIIiIIGIIii..bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '...............OLLIIIGIIiIIGIIIii.bBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIGIIiIIGIIIIiibBO...........',
      '..............OLLIIIIIIIiIIIIIIIiibBO...........',
      '..............OLLIIIIIIIIIIIIIIIiiOO............',
      '..............OLLIIIIIIIIIIIIIIIiiO.............',
      '..............OiiOiiOiiOiiOiiOiiOiO.............',
      '...............OiOOiOOiOOiOOiOOiOO..............',
      '................O..O..O..O..O..O................',
    ],
  },
  knight: {
    palette: { O: '#0d0d12', k: '#262b33', m: '#454e59', n: '#69737f', l: '#98a2ae', h: '#c6cfda', c: '#3a0d14', C: '#6b1622', R: '#9c2837', r: '#c04a5a', g: '#4f4320', G: '#8a7333', y: '#b89a3f', v: '#08080e', e: '#4f93b5', f: '#a7d8ee', b: '#1b140d', B: '#33260f' },
    pixels: [
      '.........................O......................',
      '.....................OOOOcO.....................',
      '....................OCCCcO......................',
      '...................ORCCcO.......................',
      '..................Or.CCCO.......................',
      '...................OlllllO......................',
      '..................OlnnnnnmO.....................',
      '..................OlnnnnnmO.....................',
      '..................OlnnnnnmO.....................',
      '..................OlnnnnnmO.....................',
      '..................OleevevmO.....................',
      '..................OlfvvfvmO.....................',
      '..................OlnnvnnmO.....................',
      '..................OlnnvnnmO.....................',
      '.................OOlnkvknmOO....................',
      '..............OOOnnnnnnnnnnnOOO.................',
      '.............OnhlnmmmmmmmmmnlhnO................',
      '............OnnnnnmmmmmmmmmnnnnnO...............',
      '.............OnnnnnnnnnnnnnnnnnO................',
      '..............OOOn.lnnRCCCcnnmO.................',
      '..............OlnnmlnnRCCCclnnmO................',
      '..............OlnnmlnnRCCCcnnnmO................',
      '..............Olnnm.lnRCCCcnnnmO................',
      '..............Olnnm.lnRCCCcnnnmO................',
      '....OOOOOOOOOOOlnnm.lnRCCCcnnnmO................',
      '...Olnnnnnnnnnnnmnm.lnRCCCcnnnmO................',
      '...Olllllllllllllnm.lnRCCCcnnnmO................',
      '...Olnnnnnnnnnnnmnm.lnRCCCcnnnmOO...............',
      '...OlnnnnRCnnnnnmmCClnRCCCcnnnmccO..............',
      '...OlnnnnRCnnnnnmmCCClRCCCcmnmmmcO..............',
      '...OlnRRRRRRRRRnmmCCClRCCCcmnmmmcO..............',
      '...OlnCCCCCCCCCnmmCCClRCCCcmnmmmcOO.............',
      '...OlnnnhRChhnnnmmCCClRCCCcmnmmmcOyO............',
      '....OlnnnRChnnnmmmCCClRCCCcmnmmmcGGO............',
      '....OlnnnRCnnnnmllCCClRCCCcmnmmmcGGO............',
      '....OlnnnRCnnnnmmmCClnRCCCcnnmmmc.BO............',
      '....OlnnnRCnnnnmmmCCyyyyyyyyymmmc.BO............',
      '....OlnnnRCnnnnmmmCCGGGygyGGGClllllO............',
      '.....OlnnRCnnnmORRCClnRCCCcnmCmmmmmOOOO.........',
      '.....OlnnRCnnnmOORRClnRCCCcnmCmmmmmyyyyO........',
      '.....OlnnRCnnnmOORlnnmRCCCcnmCmmmmmGGGGO........',
      '.....OlnnRCnnnmOORlnnmRCCCcnmCcc..mlhOO.........',
      '......OlnRCnnmO.ORlnnmRCCCcnmCcc..mlhO..........',
      '......OlnRCnnmO.ORlnnmRCCCcnmCcc..mlhO..........',
      '......OlnRCnnmO.ORlnnmRCCCcnmCcc..mlhO..........',
      '.......OlRCnmO..ORlnnmRCCCcnmCcc..mlhO..........',
      '.......OlnnnmO..ORlnnmCCClnnmCcc..mlhO..........',
      '........OlnmO...ORlnnm.CClnnmC.c..mlhO..........',
      '........OlnmO...ORlnnmCC.lnnmCcc..mlhO..........',
      '.........OnO....ORlhnm.CClhnmC.c..mlhO..........',
      '.........OnO....OlllllCClllllCcc..mlhO..........',
      '..........O....Ollllllllllllll.c.mlhO...........',
      '................OlllllCClllllCcc.mlhO...........',
      '................ORlnnm.CClnnmC.c.mlhO...........',
      '................ORlnnmCC.lnnmCcc.mlhO...........',
      '................ORlnnm.CClnnmC.c.mlhO...........',
      '................ORlnnmCC.lnnmCcc.mlhO...........',
      '................ORlnnm.CClnnmC.c.mlhO...........',
      '...............OORlnnmCCOlnnmCcc.mlhO...........',
      '..............OlllllllllOllllllllmlhO...........',
      '..............OmmmmmmmmmOmmmmmmmmmlhO...........',
      '..............OmmmmmmmmmOmmmmmmmmmmmO...........',
      '...............OOOOOOOOO.OOOOOOOOOOO............',
      '................................................',
    ],
  },
  barbarian: {
    palette: { O: '#0d0d12', S: '#c99a6a', s: '#9a6f45', h: '#e0b98c', D: '#2a1d12', d: '#17110a', b: '#5a3a1e', B: '#3d2712', E: '#7a5326', e: '#8f6a36', R: '#8a2a2a', r: '#b04040', k: '#2b313a', m: '#4c5661', n: '#69737f', l: '#98a2ae', z: '#c6cfda', W: '#b8b0a0', w: '#8a8272', g: '#4f4320', G: '#8a7333' },
    pixels: [
      '................................................',
      '................O.OOOOOOOOO.OOO.O...............',
      '...............OdOdDdDdDdDdOdDdOdO..............',
      '................O.ODDDD.DDDD.DO.O...............',
      '.................OD.DDDD.DDDD.DO................',
      '.................ODD.DDDD.DDDDO.................',
      '................ODDDD.DDDD.DDDDO................',
      '................OODDDD.DDDD.DDDDO...............',
      '...............ODD.DDhhhhhhhhDDDDO..............',
      '..............ODDDD.DSSSSSSSD.DDDDO.............',
      '..............ODDDDDSSSSSSSSDD.DDDO.............',
      '..............OD.DDDDSSSSSSSDDD..DO.............',
      '.............ODD..DDDSdSSSdSDDDD.DDO............',
      '..........O.O.OD...DDSSSSSSSSDD..DOOOO..........',
      '.........OEOEOEDE.D.DSSSSSSSD.D..DOnnnO.........',
      '........OWBEBEBDBw.DSdddddddDD...DnznmO.........',
      '........OB.B.B.DSBSDDSSSSSSSDDSSSDznnmO.........',
      '........OWBEBEBEBwBSSSSSSSSSSSSSnznnnmO.........',
      '.........OE.E.EhESESSSSSsSSSSSSnznnnnmO.........',
      '........OWBEBEBEBwBESSSSsSSSSSnznnnnnmO.........',
      '........OB.B.hSSsBSBsssssssssSSnznnnnmO.........',
      '........OWBEBhSSswBSSSSSsSSSSSSSnznnnmO.........',
      '.........OOOEhSSshESSSSSsSSSSSSshnznnmO.........',
      '........OWOEBhSSswBESSSSsSSSSSSshSnznmO.........',
      '.........O.OOhSSsBSSSSSSsSSSSSSshSSnnnO.........',
      '........OWOOBhSSswBSSSSSsSSSSSSshSSsBbO.........',
      '.........O.OEhSSs.ESSRRRRRRRSSs.hSSsBbO.........',
      '............OhSSsEBESSSrsrSSSSs.hSSsBbO.........',
      '............OhSSs.hSSSSSsSSSSSs.hSSsBbO.........',
      '............OhSSs.hSSSSSsSSSSSs.hSSsBbO.........',
      '............OhSSs.hSSSSSsSSSSSs.hSSsBbO.........',
      '............OhSSs.hSSSSSsSSSSSs.hSSsBbO.........',
      '............OhSSs.hSSSSSsSSSSSshhhhhBbO.........',
      '............OhSSshSSSSSSsSSSSSSSSSSSBbO.........',
      '.............OOOOhSSSSSSsSSSSSSSSSSSBbO.........',
      '................OhSSSSSSsSSSSSSSSSSSBbO.........',
      '................OhSSSSSSsSSSSSSSSSSSBbO.........',
      '................OhSSSSSSsSSSSSSsOOOOBbO.........',
      '................OhSSSSSSsSSSSSSsO..OBbO.........',
      '...............OOhSSSSSSsSSSSSSsO..OBbO.........',
      '..............ObEEBBbBBBBbBBBBbbbO.OBbO.........',
      '..............OEEEBbBBBBbBBBBbbbbO.OBbO.........',
      '..............OEEEbBBBBbBBBBbBbbbO.OBbO.........',
      '..............OEEbBBBBbBBBBbBBbbbO.OBbO.........',
      '..............OEbEBBBbBBBBbBBBbbbO.OBbO.........',
      '..............ObEEBBbBBBBbBBBBbbbO.OBbO.........',
      '..............OEEEBbBBBBbBBBBbbbbO.OBbO.........',
      '..............OEEEbBBBBbBBBBbBbbbO.OBbO.........',
      '...............OOhSSSsOOOhSSSsOOO..OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '................OhSSSsO.OhSSSsO....OBbO.........',
      '...............ObbbbbbbObbbbbbbO...OBbO.........',
      '...............OBBBBBBBOBBBBBBBO...OBbO.........',
      '...............OBBBBBBBOBBBBBBBO....OO..........',
      '...............OBBBBBBBOBBBBBBBO................',
      '...............OBBBBBBBOBBBBBBBO................',
      '................OOOOOOO.OOOOOOO.................',
      '................................................',
      '................................................',
    ],
  },
  noble: {
    palette: { O: '#0d0d12', p: '#3a1a5a', P: '#5a2f8a', Q: '#8a5ac0', S: '#e6c8a8', s: '#b09070', C: '#6b1622', R: '#9c2837', r: '#c04a5a', c: '#3a0d14', g: '#4f4320', G: '#8a7333', y: '#c9a227', D: '#241a2a', k: '#2b313a', m: '#4c5661', l: '#98a2ae', h: '#c6cfda' },
    pixels: [
      '................................................',
      '....................O.O.O.O.O...................',
      '...................OGOGOyOGOGO..................',
      '...................OyOyOyOyOyO..................',
      '...................OyyyyyyyyyO..................',
      '...................ODDDDDDDDDO..................',
      '...................ODDDDDDDDDO..................',
      '...................ODDDDDDDDDO..................',
      '...................OD.......DO..................',
      '...................ODsssssssDO..................',
      '...................ODSSSSSSSDO..................',
      '...................ODSSSSSSSDO..................',
      '...................ODSDSSSDSDO..................',
      '..................ORDSSSSSSSDcO.................',
      '................OORRDSSSSSSSDccOO...............',
      '...............ORRCCCSSSSSSSCCCccO..............',
      '..............ORRCCCCsssssssCCCCccO.............',
      '.............ORRCCCCCPPPPPPPCCCCCccO............',
      '............ORRCCCCCCPPPPPPPCCCCCCccO...........',
      '..........OORRCCCCCCCPPPPPPPCCCCCCCccOO.........',
      '.........ORRCCCCCCCCCPPPPPPPCCCCCCCCCccO........',
      '..........OOOORRCQPPPPPPPPPPQPPPCccOOOO.........',
      '.............ORRCQPPPPPpQPPPQPPPCccO............',
      '............ORRCCQPPPPPpQPPPQPPPCCccO...........',
      '............ORRCCQPPPyPpQPPyQPPPCCccO...........',
      '............ORRCCQPPPPPpQPPPQPPPCCccO...........',
      '............ORRCCQPPPPPpQPPPQPPPCCccO...........',
      '............ORRCCQPPPPPpQPPPQPPPCCccO...........',
      '............ORRCCQPPPyPpQPPyQPPPCCccO...........',
      '............ORRCCQPPPPPpQPPPQPPPCCccO...........',
      '............ORRCCQPPPPPpQPPPPsssssccO...........',
      '............ORRCsssssPPpQPPPPSSSSSccO...........',
      '............ORRCSSSSSyPpQPPyPSSSSSccO...........',
      '...........ORRCCSSSSSPPpQPPPPSSSSSCccO..........',
      '...........ORRCCSSSSSPPpQPPPPSSSGSCccO..........',
      '...........ORRCCSSSSSPPpQPPPPPpCyCCccO..........',
      '...........ORRCCCCQPPyPpQPPyPPpCyCCccO..........',
      '...........ORRCCCCQPPPPpQPPPPPpCyCCccO..........',
      '...........ORRCCCCQPPPPpQPPPPPphmCCccO..........',
      '...........ORRCCCCQPPPPpQPPPPPphmCCccO..........',
      '...........ORRCCCCQyyyyyyyyyyyphmCCccO..........',
      '...........ORRCCCCQGGGGGGGGGGGhmCCCccO..........',
      '...........ORRCCCCQPPPPpQPPPPPhmCCCccO..........',
      '..........ORRCCCCCQPPPPpQPPPPPhmCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDDDhmCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDDhmCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDDhmCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDDhmCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDDhmCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDDhmCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDhmCCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDhmCCCCCCccO.........',
      '..........ORRCCCCCCmDDDDCmDDhmCCCCCCccO.........',
      '.........ORRCCCCCCCmDDDDCmDDhmCCCCCCCccO........',
      '.........ORRCCCCCCCmDDDDCmDhmDCCCCCCCccO........',
      '.........ORRCCCCCCmmmmmmmmmhmmmCCCCCCccO........',
      '.........ORRCCCCCCkkkkkkkkkhmkkCCCCCCccO........',
      '.........ORRCCCCCCkkkkkkkkkhmkkCCCCCCccO........',
      '.........ORRCCCCCCkkkkkkkkhmkkkCCCCCCccO........',
      '..........OOccOccOccOccOcchmcOccOccOcOO.........',
      '............OO.OO.OO.OO.OOhmO.OO.OO.O...........',
      '.........................OhO....................',
      '..........................O.....................',
      '................................................',
    ],
  },
  bandit: {
    palette: { O: '#0d0d12', d: '#17171f', D: '#26262f', F: '#3a3a46', S: '#c9a377', s: '#9a7850', R: '#8a1f1f', r: '#b03636', E: '#4a3320', e: '#63512f', k: '#2b313a', m: '#4c5661', l: '#98a2ae', W: '#c6cfda', G: '#8a7333', y: '#b89a3f' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '....................OOOOOOOOO...................',
      '...................ODDdddddddO..................',
      '..................ODDdddddddddO.................',
      '..................ODDdddddddddO.................',
      '.................ODDdddddddddddO................',
      '.................ODDdddddddddddO................',
      '................ODDdddddddddddddO...............',
      '...............ODDdddddddddddddddO..............',
      '...............ODDdddddddddddddddO..............',
      '..............ODDdddddddddddddddddO.............',
      '..............ODDdddddddddddddddddO.............',
      '.............ODDddddddrdddrddddddddO............',
      '............ODDdddddddddddddddddddddO...........',
      '............ODDdddRRRRRRRRRRRRRdddddO...........',
      '...........ODDddddddRRRRRRRRRddddddddO..........',
      '...........ODDddddddrrrrrrrrrddddddddO..........',
      '............OOOOOORRRRRRRRRRRRROOOOOO...........',
      '...............OeEEEEEEEEEEEEEEddO..............',
      '...............OeEEEDEEEEEEEEEEddO..............',
      '...............OeEEEDEEEEEEEEEEddO..............',
      '...............OeEEEdDEEEEEEEEEddO..............',
      '...............OeEEEdDEEEEEEEEEddO..............',
      '...............OeEEEEdDEEEEEEEEddO..............',
      '...............OeEEEEdDEEEEEEEEddO..............',
      '...............OeEEEEEdDEEEEEEEddO..............',
      '...............OeEEEEEdDEEEEEEEddO..............',
      '..............OFeEEEEEEdDEEEEEEdddO.............',
      '..............OFeEEEEEEdDEEEEEEdddO.............',
      '..............OFeEEEEEEEdDEEEEEdddO.............',
      '..............OFeEEEEEEEEdDEEFFFFFO.............',
      '..............OFFFFFEEEEEdDEEDDDDDO.............',
      '..............ODDDDDEEEEEEdDEDDDDDO.............',
      '..............ODDDDDEEEEEEdDEDDDDDO.............',
      '..............ODDDDDEEEEEEEdDDDGDDO.............',
      '..............ODDDDDEEEEEEEdDEdDydO.............',
      '..............OFFDeEEEEEEEEDDDDDydO.............',
      '..............OFFDeEDDDEEEEDDDDDydO.............',
      '..............OFFDeEDDDEEEEDDDDmldO.............',
      '..............OFFDddDDDyyydDDDDmldO.............',
      '..............OFFDDDDDyyyyDDDDDmldO.............',
      '..............OFFDeEEEyyyyEEEEmlddO.............',
      '..............OFFFDDDdDDDDFDDDmlddO.............',
      '..............OFFFDDDdDDDDFDDDmlddO.............',
      '..............OFFFDDDdDDDDFDDDmlddO.............',
      '.............OFFDFDDDdDDDDFDDmlDDddO............',
      '.............OFFDFDDDdDDDDFDDmlDDddO............',
      '.............OFFDFDDDdDDDDFDDDdDDddO............',
      '.............OFFDFDDDdDDDDFDDDdDDddO............',
      '.............OFFDFDDDdDDDDFDDDdDDddO............',
      '.............OFFDFDDDdDDDDFDDDdDDddO............',
      '.............OFFDFDDDdDDDDFDDDdDDddO............',
      '.............OFFDFDDDdDDDDFDDDdDDddO............',
      '............OFFFFFFFFdDDDDFFFFFFFFFO............',
      '............OddddddddDDDDDDddddddddO............',
      '............OddddddddOddOddddddddddO............',
      '............OddddddddOOO.OOddddddddO............',
      '.............OOOOOOOO......OOOOOOOO.............',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
    ],
  },
};

const MONSTERS = {
  maggot: {
    palette: { O: '#0d0d12', W: '#d8d2b4', w: '#b0a882', u: '#867c5a', d: '#4e4630', D: '#2a2418', E: '#8a3a2a', e: '#c05a3a', S: '#efe7c8', m: '#6a6244' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '.......................OOO......................',
      '....................OOOwwwOOO...................',
      '...................OwwwwSwwwwO..................',
      '..................OwwSSSSSSSwwO.................',
      '.................OwSSeSSSSSeSSwO................',
      '................OwSSSSSSDSSSSSSwO...............',
      '................OwSSSDSDSDSDSSSwO...............',
      '................OwSSDDDDDDDDDSSwO...............',
      '...............OwSSSDDDDDDDDDSSSwO..............',
      '.............OOOOwSDDDDDDDDDDDSwOOOO............',
      '............OwwWWwSSDDDDDDDDDSSwWWuuO...........',
      '...........OwwWWWwSSDDDDDDDDDSSwWWWuuO..........',
      '..........OwwWWWWWwSSSDSDSDSSSwWWWWWuuO.........',
      '.........OwwWWWWWWWwwSSSDSSSwwWWWWWWWuuO........',
      '.........OuwuwuwuwuwwwwwSwwwwwuwuwuwuwuO........',
      '........OwwWWWWWWWWWWWWwwwWWWWWWWWWWWWuuO.......',
      '.......OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO......',
      '......OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO.....',
      '......OwuwuwuwmmmwuwuwuwuwuwuwuwmmmwuwuwuwO.....',
      '.....OwwWWWWWWmmmWWWWWWWWWWWWWWWmmmWWWWWWuuO....',
      '.....OwwWWWWWWmmmWWWWWWWWWWWWWWWmmmWWWWWWuuO....',
      '.....OwwWWWWWWmmmWWWWWWWWWWWWWWWmmmWWWWWWuuO....',
      '....OwuwuwuwuwmmmwuwuwuwuwuwuwuwmmmwuwuwuwuwO...',
      '....OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO...',
      '....OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO...',
      '....OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO...',
      '....OwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwO...',
      '....OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO...',
      '....OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO...',
      '.....OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO....',
      '.....OuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuO....',
      '......OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO.....',
      '......OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO.....',
      '.......OwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWuuO......',
      '.......OuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuwuO......',
      '........OwwmmmWWWWWWWWWWWWWWWWWWWWWWWmmmO.......',
      '.........OwmmmWWWWWWWWWWWWWWWWWWWWWWWmmmO.......',
      '..........OmmmWWWWWWWWWWWWWWWWWWWWWWummmO.......',
      '..........OmmmuwuwuwuwuwuwuwuwuwuwuwummmO.......',
      '........OOOmmmwWWWWWWWWWWWWWWWWWWWuu.mmmOOO.....',
      '.......OmmDDDDDmmmWWWWWWWWWWWWWWWmmmDDDDDmmO....',
      '.......OmmDDDDDmmmWWWWWWWWWWWWWWummmDDDDDmmO....',
      '.......OmmmOOOOmmmuwuwuwuwuwuwuwummmOOOOmmmO....',
      '.......OmmmO..OmmmwWWWWWWWWWWWuuOmmmO..OmmmO....',
      '.......OmmmO..OmmmwwWWWWWWWWWuuOOmmmO..OmmmO....',
      '......ODDDDDOODDDDDwwWWWWWWWuuOODDDDDOODDDDDO...',
      '......ODDDDDOODDDDDOwwWWWWWuuO.ODDDDDOODDDDDO...',
      '.......OOOOO..OOOOO.OOOOOOOOO...OOOOO..OOOOO....',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
    ],
  },
  fairy: {
    palette: { O: '#0d0d12', W: '#e8e6f2', w: '#c2bce0', P: '#ff9fd9', p: '#c060a0', S: '#ffe0c0', s: '#d0a880', E: '#2a1a3a', e: '#ff5aa0', G: '#a0ffd0', g: '#5ac090', D: '#3a2a4a' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '.................O............O.................',
      '................OWO..........OWO................',
      '................OWO..........OWO................',
      '...............OWwO..........OwWO...............',
      '..............OWWwO..........OwWWO..............',
      '.............OWWwwO..........OwwWWO.............',
      '..........OOOWWwwwO..........OwwwWWOOO..........',
      '.........OWWWWWwwwO..........OwwwWWWWWO.........',
      '.........OWWWwwwwwO..........OwwwwwWWWO.........',
      '........OWWwwwwwwwO..........OwwwwwwwWWO........',
      '.......OWWwwwwwwwwO.....O....OwwwwwwwwWWO.......',
      '.....OOWWwwwwwwwwwO...OOSOO..OwwwwwwwwwWWOO.....',
      '...OOWWWwwwwwwwwwwO..OSSSSSO.OwwwwwwwwwwWWWOO...',
      '..OWWWWWwwwwwwwwwwO.OSSSSSSSOOwwwwwGwwwwWWWWWO..',
      '..OWWWwwwwwwwwwwwwO.OSeSSSeSOOwwwwGGGwwwwwWWWO..',
      '..OwwwwwwwwwwwwwwwOOSSSSSSSSSOwwwGGeGGwwwwwwwO..',
      '..OwwwwwwwwwwwwwWWO.OSSSSSSSOOWWwwGGGwwwwwwwwO..',
      '..OwwwwwwwwwWWWWOO..OSEEEEESO.OOWWGGwwwwwwwwwO..',
      '..OwwwwwwWWWOOOO....OOSSSSSOO.O.OOOOWWWwwwwwwO..',
      '..OwwWWWWOOO.......ODDDDSDDDDOgO....OOOWWWWwwO..',
      '..OWWOOOO..........ODDDDDDDDDOgO.......OOOOWWO..',
      '...OO......OO......ODDDDDDDDDOgO...OO......OO...',
      '........OOOWWO.....OPpppppppPOOgO.OWWOOO........',
      '.....OOOWWWWWO.....OPpppppppPOOgO.OWWWWWOOO.....',
      '...OOWWWWWWwwO....OPPpppppppPPOgO.OwwWWWWWWOO...',
      '..OWWWWWwwwwwO....OPpppppppppPOgO.OwwwwwWWWWWO..',
      '..OWWwwwwwwwwO....OPPpppppppPPOOgOOwwwwwwwwWWO..',
      '..OwWWwwwwwwwO.....OPpppppppPO.OgOOwwwwwwwWWwO..',
      '..OwwwWWwwwwwO.....OPpppppppPO.OgOOwwwwwWWwwwO..',
      '..OwwwwWWWwwwO.....OPpppppppPO.OgOOwwwWWWwwwwO..',
      '..OwwwwwwWWWwO......OPpppppPO...OgOwWWWwwwwwwO..',
      '..OwwwwwwWOWWO......OPpppppPO...OgOWWOWwwwwwwO..',
      '..OwwwwwwO.OO.......OppPpPppO...OgOOO.OwwwwwwO..',
      '..OwwWWWWO..........OppOPOppO...OgO...OWWWWwwO..',
      '..OwWOOOO...........OppOOOppO....OgO...OOOOWwO..',
      '..OwO...............OppO.OppO....OgO.......OwO..',
      '..OWO...............OppO.OppO.....O........OWO..',
      '...O................OppO.OppO...............O...',
      '....................OppO.OppO...................',
      '...................OEEEEOEEEEO..................',
      '...................OEEEEOEEEEO..................',
      '....................OOOO.OOOO...................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
    ],
  },
  undead: {
    palette: { O: '#0d0d12', k: '#20242b', m: '#3a4048', n: '#565d67', l: '#7d858f', c: '#3a0d14', C: '#6b1622', S: '#cfc9b0', s: '#9a9478', R: '#b02020', r: '#e05050', g: '#4f4320', G: '#8a7333', y: '#b89a3f', W: '#d0d0c0', w: '#9a9a88', D: '#161a20' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '........................O.......................',
      '....................OOOOSOOOO...................',
      '...................OmSSSSSSSmO..................',
      '..................OmmmmmmmmmmmO.................',
      '..................OmmmmmmmmmmmO.................',
      '..................OmmmmmmmmmmmO.................',
      '..................OmmmrmmmrmmmO.................',
      '...................OSSRSSSRSSO..................',
      '...................OSSSSsSSSSO..................',
      '...................OSSSSSSSSSO..................',
      '...................OOSsssssSOO..................',
      '..................OnnnnnSnnnnnO.................',
      '..................OmmmmmmmmmmmO.................',
      '...............OOOOmmmmmmmmmmmOOOO..............',
      '..............OmmDDDlnnnnnnnmDDDkkO.............',
      '..............OmmDDlnnnnnnnnnmDDkkO.............',
      '..............OlnnnlnnnnnnnnlnnnkkO.............',
      '..............OlnnnlnnnnnnnnlnnnkkO.............',
      '..............OlnnnlnSSSsSSSlnnnkkO.............',
      '....OOOOOOOOOOOlnnnlnnnnsnnnlnnnkkO.............',
      '...OlmmmmmmmmmmmknnlnnnnsnnnlnnnkkO.............',
      '...OnnnnnnnnnnnnnnnlnSSSsSSSlnnnkkO.............',
      '...OlmmmmmmmmmmmknnlnnnnsnnnlnnnkkO.............',
      '...OlmmmmmmmmmmmknnlnnnnsnnnlnnnkkO.............',
      '...OlmmmmmCmmmmmknnlnSSSsSSSlnnnkO..............',
      '...OlmmmmmCmmmmmknnlnnnnsnnnlnnnkO..............',
      '...OlmmmmlClmmmmknnDlnnnsnnnmmmmmO..............',
      '....OlCCCCCCCCCknnnDlSSSsSSSmmmmmO..............',
      '....OlmmmlClmmmkmmDDlnnnsnnnmmmmGGO.............',
      '....OlmmmmCmmmmkmmDDlnnnsnnnmmmmGGO.............',
      '....OlmmmmCmmmmkmmDDlnnnnnnnmmmmmyO.............',
      '....OlmmmmCmmmmkmmDDlnnnnnnnmmmmmyO.............',
      '....OlmmmmCmmmmkmmDDlnnnnnnnmDDkkyO.............',
      '.....OlmmmCmmmkOmmDDlnnnnnnnmDDkkyO.............',
      '.....OlmmmCmmmkOmmDDlnnnnnnnmDDkkyOOOO..........',
      '.....OlmmmCmmmkOmmDDlnnnnnnnmGGGGGGGGGO.........',
      '......OlmmCmmkOOmmDDlnnnnnnnmDDkkmlnOO..........',
      '......OlmmCmmkOOmmDDlnnnnnnnmDDkkmlnO...........',
      '......OlmmCmmkOOmmlnnmDDDlnnmDDkkmlnO...........',
      '.......OlmCmkO.OmmlnnmDDDlnnmDDkkmlnO...........',
      '.......OlmmmkO.OmmlnnmDDDlnnmDDkkmlnO...........',
      '........OlmkO..OmmlnnmDDDlnnmDDkkmlnO...........',
      '........OlmkO..Om.lnnmD.Dlnnm.Dk.mlnO...........',
      '.........OmO....Omlnnm.DDlnnmDk..mlnO...........',
      '.........OmO....OmlnnmDD.lnnmD.k.mlnO...........',
      '..........O......OlnnmD.Dlnnm.kk.mlnO...........',
      '................Omlnnm.DDlnnmDk..mlnO...........',
      '................OmllnmDD.llnmD.kmlnO............',
      '................OlllllD.lllll.kkmlnO............',
      '...............Ollllllllllllllk.mlnO............',
      '................OlllllDDlllllD.kmlnO............',
      '.................Oml.DD.DDlDD.kkmlnO............',
      '................Omm.DD.DD.DD.Dk.mlnO............',
      '................OnnnnnnnnnnnnnnnmlnO............',
      '................OmmmmmmmmmmmmmmmmlnO............',
      '................OmmmmmmmmmmmmmmmmlnO............',
      '.................OOOOOOOOOOOOOOOmlnO............',
      '................................OOO.............',
      '................................................',
      '................................................',
    ],
  },
  wyvern: {
    palette: { O: '#0d0d12', a: '#2f5a24', A: '#4a7a2a', t: '#6a9a3a', T: '#93bb52', W: '#c9bd8e', w: '#9a8f60', b: '#241a10', y: '#c9a227', E: '#ffcc33', r: '#c0392b', R: '#8a2018', m: '#3a2a18', k: '#20303a', K: '#0f1a20' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '..................O...........O.................',
      '....O............OWO.........OWO...........O....',
      '...OmOO...........OWO.......OWO..........OOmO...',
      '...OAmmO...........OWO.....OWO..........OmmAO...',
      '...OammmO..........OWOOOOOOOWO.........OmmmaO...',
      '...OammAmOO.........OWtttttWttO......OOmAmmaO...',
      '...OammmAmmO.......OttWtttWttttO....OmmAmmmaO...',
      '...OaammmAAmOO.....OtttttttttttO..OOmAAmmmaaO...',
      '...OaammmaaAmmO....OtttttttttttO.OmmAaammmaaO...',
      '...OaammamaaAAmO..OttEttttttttttOmAAaamammaaO...',
      '...OaamamamaaaAmOOOttEttttttttttmAaaamamamaaO...',
      '...OaamamaamaaaAmmOtttttttttttttAaaamaamamaaO...',
      '...OaamamaamaaaaAAm.tttttttttttAaaaamaamamaaO...',
      '...OaamaamaamaaaaaAmtttttttttttaaaamaamaamaaO...',
      '...OaamaamaaamaaaaaAtttttttttttaaamaaamaamaaO...',
      '...OaaamaamaamaaaaaaAAAAAAAAAAAaaamaamaamaaaO...',
      '...OaaamaamaaamaaaaaWWWWWWWWWWWaamaaamaamaaaO...',
      '...OaaamaamaaamaaaaaaWWWAtAAaaaaamaaamaamaaaO...',
      '...OaAAmAaamaaamaaaaaaAaatAAaaaamaaamaaAmAAaO...',
      '...OAOOmOAamaaaamaaaaaaatAAaaaamaaaamaAOmOOAO...',
      '....O.OmOOamaaaammaaaaaatAAaaammaaaamaOOmO.O....',
      '......OmOOAamAAAaamtAAAAtAAAAaaaAAAmaAOOmO......',
      '.......OmOOAmOOOAamtAAAtAAAAAaaAOOOmAOOmO.......',
      '.......OmO.OOmO.OaatAAAtAAAAAaaO.OmOO.OmO.......',
      '.......OmO..OmO.OAatAAAAAAAAAaAO.OmO..OmO.......',
      '.......OmO..OmO..OatAAAAAAAAAaO..OmO..OmO.......',
      '.......OmO...OmO.OAtAAAAAAAAAaO.OmO...OmO.......',
      '........O....OmO..OtAtttttttAaO.OmO....O........',
      '..............O..OtAAAAAAAAAAAaO.O..............',
      '.................OtAAAAAAAAAAAaO................',
      '.................OtAAtttttttAAaO................',
      '.................OtAAAAAAAAAAAaO................',
      '.................OtAAAAAAAAAAAaO................',
      '.................OtAAtttttttAAaO................',
      '.................OtAAAAAAAAAAAaO................',
      '..................OtAAAAAAAAAaO.................',
      '..................OtAtttttttAaO.................',
      '..................OtAAAAAAAAAaO.................',
      '..................OtAAAAAAAAAaO.................',
      '..................OtAtttttttAaO.................',
      '..................OtAAAAAAAAAaO.................',
      '..................OAAAAAAAAAAaO.................',
      '..................OAAAAAAAAAAaaO................',
      '..................OAAAAAAAAAA.AaO...............',
      '..................OAAA....AAAaaO................',
      '..................OAAA...AAAAOO.................',
      '..................OAAAaAa.AAAO..................',
      '.................OAAAA....AAAO..................',
      '.................OAAAA....AAAO..................',
      '..................OAAAa...AAAO..................',
      '..................OAAAAaAaAAAO..................',
      '.................OWWWOOOOWWWO...................',
      '.................OWWWO..OWWWO...................',
      '..................OOO....OOO....................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
    ],
  },
  cultist: {
    palette: { O: '#0d0d12', p: '#2a1230', P: '#43204f', Q: '#5f3070', S: '#d0b090', s: '#a07e58', W: '#ded0a8', w: '#a89878', E: '#c0392b', e: '#ff5a4a', g: '#4f4320', G: '#8a7333', y: '#b89a3f', B: '#1a0e20', t: '#7a4a8a', D: '#120818' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '...................OOOOOOOOOOO..................',
      '..................OPPpppppppppO.................',
      '..................OPPpppppppppO.................',
      '.................OPPpppppppppppO................',
      '.................OPPpppppppppppO................',
      '................OPPpppppWpppppppO...............',
      '................OPPpppWWWWWpppppO...............',
      '................OPPppWWWWWWWppppO...............',
      '...............OPPpppwwwwwwwpppppO..............',
      '...............OPPpppWeWWWeWpppppO..............',
      '..............OPPpppWWWWWWWWWpppppO.............',
      '..............OPPppppWWWwWWWppppppO.............',
      '..............OPPppppWWWwWWWppppppO.............',
      '.............OPPpppppWWWwWWWpppppppO............',
      '.............OPPppppppWWwWWppppppppO............',
      '............OPPpppppppPPWPPpppppppppO...........',
      '.............OOOOOOQPPPPPPPPPpOOOOOO............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO..............',
      '..............OQPPPPPPPPPPPPPppppO....O.........',
      '..............OQPPPPPPPPPPPPPppppO...OtO........',
      '...........O..OQPPPPPPPPPPPPPppppO....OtO.......',
      '..........OtO.OQPPPPPPPPPPPPPppppO....OtO.......',
      '..........OtO.OQPPPPPPPPPPPPPssssO....OtO.......',
      '..........OtO.OQPPPPPPPPPPPPPSSSSO....OtO.......',
      '..........OtO.OQPssssPPPPPPPPSSSSO....OtO.......',
      '..........OtO.OtQSSSSPPPPPPPPSSSSO....OtO.......',
      '.......O.OtO.Ot.QSSSSPPPPPPPPSSSGO...OtO........',
      '......OyOOtO.Ot.QSSSSPPPPPPPPPPPpyO..OtO........',
      '......OyOtO.Ot.QPSSSSPPPPPPPPPPPPyO.OtO.........',
      '.....OyEOtO.Ot.QPPPPPPPPPPPPPPPPPyO.OtO.........',
      '......OOtO.Ot..QPPPPPPPPPPPPPPPPWwOOtO..........',
      '.....OWWtO.Ot..QPyyyyyyyyyyyyyyyWwOOtO..........',
      '.....OWWtO.Ot.QPPGGGGGGGGGGGGGGWwPpOtO..........',
      '.....OWWO.Ot..QPPPPPPPPPPPPPPPyWwPptO...........',
      '.....OWWO.Ot..QPPPPPPPPPPPPPPGPWwPptO...........',
      '.....OWWO.Ot..QPPPPPPPPPPPPPPPPWwPptO...........',
      '.....OWWO.Ot..QPPPPPPPPPPPPPPPWwPPptO...........',
      '.....OWWO.Ot.QPPPPPPPPPPPPPPPPWwPPPtO...........',
      '.....OWWtO.OtQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '.....OWWtO.OtQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '.....OWWO..OtQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '......OO....OtPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OtPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQtPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............OQPPPPPPPPPPPPPPPPPPPPPpO...........',
      '............Op.pp.pp.pp.pp.pp.pp.ppO............',
      '.............OpOOpOOpOOpOOpOOpOOpOO.............',
      '..............O..O..O..O..O..O..O...............',
    ],
  },
  angel: {
    palette: { O: '#0d0d12', W: '#cfc9b8', w: '#a09b89', c: '#67645a', S: '#d9c3a6', s: '#a98f74', H: '#cfd3d8', h: '#9aa0a8', P: '#9298a0', p: '#6b727a', q: '#4a5058', L: '#b9bec6', Y: '#a88f3a', y: '#7d6a2a', z: '#e0c96f', e: '#7fb7d0', f: '#bfe6f5', g: '#6a6a6a' },
    pixels: [
      '................................................',
      '........................OO......................',
      '.................OOOOOOOYYOOOOOO................',
      '...............OOYzzzzzzzzzzzzYYOO..............',
      '..............OYz..............zYYO.............',
      '.............OYY................YYYO............',
      '..............OYY.......H......YYYO.............',
      '...............OOYYYYHHHHHHHYYYYOO..............',
      '...OO............OOOHHHHHHHHOOOO...........OO...',
      '..OWWOO............OHHHHHHHHHO...........OOWWO..',
      '..OWWWWOO..........OHHHHHHHHO..........OOWWWWO..',
      '..OWWWWWWOO........OHHHHHHHHO........OOWWWWWWO..',
      '..OwwWWWWWWOOO.....OhHHHHHHhO.....OOOWWWWWWwwO..',
      '..OwwwwWWWWWWWOO...OhhhhhhhhSO..OOWWWWWWWwwwwO..',
      '..OcwwwwwWWWWWWWOO..OSeSSeSSO.OOWWWWWWWwwwwwcO..',
      '..OccwwwwwwWWWWWWWOOOssssssSOOWWWWWWWwwwwwwccO..',
      '...OccwwwwwwwwWWWWWWWSSSSSSSWWWWWWwwwwwwwwccO...',
      '....OccwwwwwwwwwWWWWW.SSSSSWWWWWwwwwwwwwwccO....',
      '....OcccwwwwwwwwwwWWW.ssSs.WWWwwwwwwwwwwcccO....',
      '....OcOccwwwwwwwwwwwLLssssPppwwwwwwwwwwccOcO....',
      '....OcOOccwwwwwwwwwwLLPPPPPppwwwwwwwwwccOOcO....',
      '....OcO.OccwwwwwwwwLPPPPPPPppwwwwwwwwccO.OcO....',
      '.....O..OcccwwwwwwwLPPPPPPPppwwwwwwwcccO..O.....',
      '........OcOccwwwwwwLPPPPPPPppwwwwwwccOcO........',
      '........OcOOccwwwwwLPPPpqPPppwwwwwccOOcO........',
      '........OcO.OccwwwwLPPPpqPPppwwwwccO.OcO........',
      '.........O..OcccwwwLPPPpqPPppwwwcccO..O.........',
      '............OcOccwwLPPPpqPPppwwccOcO............',
      '............OcOOccwLPPPpqPPppwccOOcO............',
      '............OcO.OccLPPPpqPPppccO.OcO............',
      '.............O..OccLPPPpqPPppccO..O.............',
      '................OcOLPPPpqPPpp.cO................',
      '................OcOLPPPpqPPpp.cO................',
      '................OcOLLssssssPppcO................',
      '.................OOLLSpSSqSPppO.................',
      '..................OLLSpSSqSPppO.................',
      '..................OLLPppqqPPppO.................',
      '..................OLLPppqqPPppO.................',
      '..................OLLPppqqPPppO.................',
      '..................OLLPppqqPPppO.................',
      '..................OLLPppqqPPppO.................',
      '..................OLLPPpqPPPppO.................',
      '..................OLLPPpqPPPppO.................',
      '..................OLLPPpqPPPppO.................',
      '..................OLLPPpqPPPppO.................',
      '..................OLLPPpqPPPppO.................',
      '..................OLLPPpqPPPppO.................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '.................OLLPPPpqPPPPppO................',
      '..................OqqOqqOqq.qqO.................',
      '..................OpO.OpOOOpOO..................',
      '...................O...O...O....................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
    ],
  },
  ancient: {
    palette: { O: '#0d0d12', C: '#8a8268', c: '#6a5f48', d: '#4a4234', B: '#2a2620', E: '#ffb347', e: '#ffe08a', W: '#b8b09a', M: '#3a5a2a', G: '#8a7333', y: '#c9a227' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '..................OOOOOOOOOOOOO.................',
      '.................OWcCCCCCCdCCcdO................',
      '.................OWcCCCCCCdCCcdO................',
      '.................OWcCCCCCdCCCcdO................',
      '.................OWcCCCCCdCCCcdO................',
      '................OycCCCCCCdCCCCcGO...............',
      '................OGcCCCCCdCCCCCcGO...............',
      '................OGcCCCCCdCCCCCcGO...............',
      '................OGcCCCCCdCCCCCcGO...............',
      '................OGcCCCCdCCCCCCcGO...............',
      '................OGcCCCCdCCCCCCcGO...............',
      '...............OWGccccdccccccccGdO..............',
      '...............OWGdddddddddddddGdO..............',
      '...............OWGCCCCdCCCCCCCCGdO..............',
      '...............OWGCCCdCCCCCCCCCGdO..............',
      '...............OWGdddddddddddddGdO..............',
      '...............OWGCCCCCCBCCCCCCGdO..............',
      '..............OWcGCCCBBBEBBBCCCGcdO.............',
      '..............OWcGCCCBBeEEBBCCCGcdO.............',
      '..............OWcGCCBBEEeEEBBCCGcdO.............',
      '..............OWcGCCCBBEEEBBCCCGcdO.............',
      '..............OWcGCCCBBBEBBBCCCGcdO.............',
      '..............OWcGCCCCCCBCCCCCCGcdO.............',
      '.............OWcCGCCCCCCCCCCCCCGCcdO............',
      '.............OWcCGCCCCCCCCCCCCCGCcdO............',
      '.............OWcCGCCdCdCdCdCdCCGCcdO............',
      '.............OWcCGCCdCdCdCdCdCCGCcdO............',
      '.............OWcCGCCdCdCdCdCdCCGCcdO............',
      '.............OWcCGCCdCdCdCdCdCCGCcdO............',
      '.............OWcCGCCdCdCdCdCdCCGCcdO............',
      '............OWcCCGCCdCdCdCdCdCCGCCcdO...........',
      '............OWcCCGCCdCdCdCdCdCCGCCcdO...........',
      '............OWcCCGCCdCdCdCdCdCCGCCcdO...........',
      '............OWcCCGCCdCdCdCdCdCCGCCcdO...........',
      '............OWcCCGCCCCCCCCCCCCCGCCcdO...........',
      '............OWcCCGCcccccccccccCGCCcdO...........',
      '............OWcCCGCCCCCCCCCCCCCGCCcdO...........',
      '............OWcCCGCCCCdCCCCCCCCGCCcdO...........',
      '............OWcCCGCCCCdCCCCCCCCGCCcdO...........',
      '............OWcCCGCCCCCdCCCCCCCGCCcdO...........',
      '............OWcCCGCCCCCdCCCCCCCGCCcdO...........',
      '............OWcCCGCCCCCdCCCCCCCGCCcdO...........',
      '............OWcCCGCCCCCCdCCCCCCGCCcdO...........',
      '............OWcCCGCCCCCCdCCCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCdCCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCdCCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCdCCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCCdCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCCdCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCCdCCCCGCCcdO...........',
      '............OWcCCGCCCCCCCCCdCCCGCCcdO...........',
      '............OWcCCGCCCCCCCCCdCCCGCCcdO...........',
      '............OWcCCMCMCMCMCMCMdMCMCCcdO...........',
      '............OWcCMMCMMCMMCMMCMMCMMCcdO...........',
      '............OWcCMMCMMCMMCMMCMMCMMCcdO...........',
      '............OcccccccccccccccccccccccO...........',
      '............OdddddddddddddddddddddddO...........',
      '.............OOOOOOOOOOOOOOOOOOOOOOO............',
      '................................................',
    ],
  },
  butler: {
    palette: { O: '#0d0d12', T: '#232d3a', t: '#161d26', W: '#e6e1cf', w: '#b8b2a0', S: '#d8c3a4', s: '#a88f72', H: '#c8c8c8', h: '#8a8a8a', R: '#8a1f1f', r: '#b03636', G: '#8a7333', y: '#b89a3f', D: '#10151c', p: '#3a3a44' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '.....................OOOOOOO....................',
      '....................OHHHHHHHO...................',
      '...................OHHHHHHHHHO..................',
      '...................OH.......HO..................',
      '..................OHHsssssssHHO.................',
      '..................OHHSSSSSSSHHO.................',
      '..................OHHSDSSSDSHHO.................',
      '..................OHHSSSSSSSHHO.................',
      '..................OHHSSSSSSSHHO.................',
      '..................OHOSSSSSSSOHO.................',
      '..................OHOSsssssSOHO.................',
      '.................OOOOSSSSSSSOOOO................',
      '................OtTTTTTTTTTTTTTtO...............',
      '...............OOOtTTRRTrTRRTTtO................',
      '..............OtTTTTTRRWWWRRTTTtO...............',
      '..............OtTTTTTWWWWWWWTTTtO...............',
      '..............OtTTTTTWWWWWWWTTTtO...............',
      '..............OtTTTTTWWWWWWWTTTtO...O...........',
      '..............OtTTTTTWWWwWWWTTTtO..OyO..........',
      '..............OtTTTTTWWWwWWWTTTtOOOOHOOO........',
      '..............OtTTTTTWWWwWWWTTTtOHHHHHHHO.......',
      '..............OtTTTtTWWWwWWWTTTtHHHHHHHHHO......',
      '..............OtTTTtTWWWwWWWTTTtHHHHwHHHHO......',
      '..............OtTTTtTWWWwWWWTTTwwwwwwwwwwwO.....',
      '..............OtTTTtTpppGpppTTTtHHHHwHHHHO......',
      '..............OtTTTtTpppGpppTTTtHHHHHHHHHO......',
      '..............OtTTTtTpppGpppTTTt.HHHHHHHOOO.....',
      '..............OtTTTtTpppGpppTThhhhhhHhhhhhhO....',
      '.............OwwwwwTTpppGpppwwHHHHHHHHHHHHHO....',
      '.............OWWWWWTTpppGpppWWWWWWOOOOOOOOO.....',
      '.............OWWWWWTTpppGpppWWWWWWO.............',
      '.............OWWWWWTTpppGpppWWWWWWO.............',
      '..............OOOOtTTpppGpppTTtOOO..............',
      '.................OtTTpppGpppTTtO................',
      '.................OtTTpppGpppTTtO................',
      '.................OtTTpppGpppTTtO................',
      '................OtTTTWWWGWWWTTTtO...............',
      '................OtTTTWWWwWWWTTTtO...............',
      '................OtTTTTTTwTTTTTTtO...............',
      '................OtTTTTTTTTTTTTTtO...............',
      '................OttDDDTtttDDDTTtO...............',
      '................OttDDDTtttDDDTTtO...............',
      '................OttDDDTtttDDDTTtO...............',
      '................OttDDDTtttDDDTTtO...............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtTtDDDTtttDDDTTTtO..............',
      '...............OtppppppppppppppptO..............',
      '..............OtTtttttttttttttttTtO.............',
      '...............OOtttttttttttttttOO..............',
      '................OOOOOOOtttOOOOOO................',
      '...............OtOttOttOttOttOttO...............',
      '................O.OO.OO.OO.OO.OO................',
      '................................................',
    ],
  },
  abomination: {
    palette: { O: '#0d0d12', S: '#8a8a5a', s: '#6a6a3a', d: '#4a4a26', g: '#5a8a3a', G: '#3a5a26', R: '#8a2018', E: '#d0d040', e: '#f0f060', W: '#c8c8b0', B: '#2a2a2a', m: '#7a7a5a', p: '#5a3a4a' },
    pixels: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '........................O.......................',
      '.....................OOOSOOO....................',
      '....................OSSSSSSSO...................',
      '...................OSSSSSSSSSO..................',
      '..................OsssssssssssO.................',
      '..................OSSSSSSSSSeSO.................',
      '..................OSSeSSSeSSSSO.....O...........',
      '.................OSSSSSSSSSSSSSO...OWO..........',
      '............O.....OSSSSSSSSSSSO...OWO...........',
      '...........OWO....OSSSSSSSSSSSO...OWO...........',
      '............OWO...OSBBBBBBBBBSO..OWO............',
      '............OWO....OSWSWSWSWSO..OWO.............',
      '.............OWOOOOOOSSSSSSSOOOOOWO.............',
      '..............OWssSSSSSSSSSSSSSdWSO.............',
      '.............OSWSSSSSSSSSSSSSSSSSSSOOO..........',
      '.............OSSWSSSRRRRRRRRRSSSSSSSSdO.........',
      '..........OOOsssSSSSSRRRRRRRSSSSSSSSSdO.........',
      '.........OsSSSSSSSBSBSBSBSBSBSBSSSSSSdO.........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdO.........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdO.........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdO.........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdO.........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdO.........',
      '.........OsSSSSSSSBSBSBSBSBSBSBSSSSSSdO.........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdSO........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdSO........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdSO........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdSO........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdSO........',
      '.........OsSSSSSSSBSBSBSBSBSBSBSSSSSSdSO........',
      '.........OsSSSSSSSSSSSSSSSSSSSSSSSSSSdSO........',
      '.........OsSSSSSSSSSSSSSSSmSSSSSSSSSSdSO........',
      '........OOsSSSSSSSSSSSSmmmmmmmSSSSSSSdOO........',
      '.......OmmmmmmmSSSSSSmmmmmmmmmmmSmmmmmmmO.......',
      '.......OmmmmmmmSSSSSmmmmmmmmmmmmmmmmmmmmO.......',
      '.......OmmmmmmmSSSBSBmBmBmBmBmBmmmmmmmmmO.......',
      '.......OmmmmmmmSSSSSmmmmmmmmmmmmmmmmmmmmO.......',
      '.......OmmmmmmmsSSSmmmmmmmmmmmmmmmmmmmmmO.......',
      '.......OmmmmmmmSSSSSmmmmmmmmmmmmmmmmmmmmO.......',
      '.......OOOOOOOSSSSSSmmmmmmmmmmmmmSSOOOOO........',
      '......OWOWOWOOsssSSSmmmmmmmmmmmmmWSWOWO.........',
      '.......O.O.O..OSSSBSBmBmBmBmBmBmSSOO.O..........',
      '..............OSSSSSSSSmmmmmmmSSSSO.............',
      '...............OsssSSSSSSSmSSSdSSO..............',
      '...............OSSSSSSSSSSSSSSSSSO..............',
      '................OSSSSSSSSSSSSSSSO...............',
      '.................OsssSSSSSSSdSSO................',
      '.................OBSBSBSBSBSBSBO................',
      '................OOSSSSSSSSSSSSSOO...............',
      '...............OsSSSSSSSSSSsSSSSSO..............',
      '...............OsSSSSSSSSSSsSSSSSO..............',
      '...............OsSSSSSSSSSSsSSSSSO..............',
      '...............OsSSSSSOOOOOsSSSSSO..............',
      '...............OsSSSSSO...OsSSSSSO..............',
      '...............OsSSSSSO...OsSSSSSO..............',
      '..............OBBBBBBBBO.OBBBBBBBBO.............',
      '..............OBBBBBBBBO.OBBBBBBBBO.............',
      '..............OBBBBBBBBO.OBBBBBBBBO.............',
      '...............OOOOOOOO...OOOOOOOO..............',
    ],
  },
};

/** Paint one sprite into a 2d context at `x, y`, scaled up by `scale`. */
function drawSprite(c, sprite, x, y, scale, palette) {
  const pal = palette || sprite.palette;
  for (let ry = 0; ry < sprite.pixels.length; ry++) {
    const row = sprite.pixels[ry];
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === '.' || ch === ' ') continue;
      const colour = pal[ch];
      if (!colour) continue;
      c.fillStyle = colour;
      c.fillRect(x + rx * scale, y + ry * scale, scale, scale);
    }
  }
}

/**
 * A canvas holding one sprite, sized to the art. `className` lets the field and
 * the battle stage style the same pixels differently. The optional `palette`
 * overrides colours a sprite ships with.
 */
function spriteCanvas(sprite, scale, palette, className = 'bsSprite') {
  const cv = document.createElement('canvas');
  let w = 0;
  for (const row of sprite.pixels) w = Math.max(w, row.length);
  cv.width = w * scale;
  cv.height = sprite.pixels.length * scale;
  cv.className = className;
  drawSprite(cv.getContext('2d'), sprite, 0, 0, scale, palette);
  return cv;
}

// Battle art is drawn at a whole-number scale chosen to fill a fixed footprint,
// so a sprite can be redrawn at a finer source resolution without changing how
// big a fighter looks on the stage. Rounding (rather than flooring) favours the
// finer art, which would otherwise shrink against the coarse art it replaces.
const BOSS_FOOT = 140;
const HERO_FOOT = 100;
const CARD_FOOT = 96;

/** The whole-number scale that makes `art` fill `target` px, never below 1. */
function spriteScale(art, target) {
  let w = 0;
  for (const row of art.pixels) w = Math.max(w, row.length);
  return Math.max(1, Math.round(target / Math.max(1, w)));
}

/**
 * The field sprite for a class, pre-rendered once at 2x (16px art into a 32px
 * tile) and cached, so walking a tunnel does not re-paint hundreds of pixels
 * every frame. Returns a canvas the caller can blit with drawImage.
 */
const fieldSprites = new Map();
function fieldSprite(model) {
  const m = MODELS[model] || MODELS[0];
  if (!fieldSprites.has(m.id)) {
    fieldSprites.set(m.id, spriteCanvas(HERO_FIELD[m.id], 2, null, 'fieldSprite'));
  }
  return fieldSprites.get(m.id);
}

/** A boss's battle art: its species, falling back to the pose for its kind. */
function bossArt(species, kind) {
  return MONSTERS[species] || BOSS_POSES[kind === 'gate' ? 'warden' : 'brute'];
}

/** A class's battle art, by model index. */
function heroArt(model) {
  const m = MODELS[model] || MODELS[0];
  return HERO_BATTLE[m.id];
}


const state = {
  me: null,          // authoritative snapshot of *us*
  rev: 0,            // the rev that snapshot belongs to
  blocks: {},        // "x,y" -> { type, item }, only what we have discovered
  players: [],       // public snapshots of everyone, for drawing names
  myTraps: [],       // our own bear traps; secret to everyone else
  width: 50,
  surfaceY: 0,
  code: null,
  name: null,
  model: 0,
  stats: null,
  connected: false,
  halted: false,
  spectator: false,
  // which view the server is filtering for, and the admin options we asked for
  specMode: null,
  specAdminAll: true,
  specMargin: 30,
  spec: { blocks: {}, players: [], stats: [], digs: [], traps: [], width: 50, surfaceY: 0, maxY: 0 },
  // What the spectator camera is doing, in block coordinates. `mode` is
  // 'manual' (free panning), 'deepest' (pinned to the deepest player) or
  // 'player' (stuck to `target`, a player id, which only means anything in
  // 'player' mode). Purely local: it never widens what the server sends.
  specCam: { x: 0, y: 0, mode: 'deepest', target: null, placed: false },
  keys: new Set(),   // movement keys currently held down, for the camera
  serverSkew: 0,     // Date.now() - server clock, for countdown rendering
  effects: [],       // short-lived visual effects
  flashes: {},       // "x,y" -> until, used to flash a block when it changes
  dig: null,         // { x, y, startedAt, duration } for the progress bar
  drawMe: { x: 0, y: 0 }, // interpolated render position, never gameplay state
  rulesShown: false, // has the Rules dialog been on screen this session
  tutPage: 0,        // which page of the tutorial is showing
  // the private view of the fight we are locked in, or null. Owned entirely by
  // the server: this is copied from `you.battle`, never built here.
  battle: null,
  // While a healing item is being aimed: { type, item, target }, with `target`
  // the id of the member under the cursor. Null when nothing is being picked.
  battleTarget: null,
  // loot lying on the ground, from `you.loot` plus the lootDropped/lootTaken
  // events, so a fight's leftovers appear without a full resync
  loot: [],
  // a gate boss waiting for players to join, shown until it starts or expires
  battleInvite: null,
  invTab: 'items',   // which inventory tab is showing: 'items' or 'weapon'
  // The class table the server hands us (id, name, desc, skills) and the entry
  // choice around it. While pendingClass is true we have not been spawned yet,
  // so the chooser owns the screen and the field is frozen behind its veil.
  classes: [],
  pendingClass: false,
  classPick: null,   // index highlighted in the chooser, not yet confirmed
};

const el = {
  login: document.getElementById('login'),
  game: document.getElementById('game'),
  spec: document.getElementById('spectator'),
  name: document.getElementById('nameInput'),
  code: document.getElementById('codeInput'),
  loginBtn: document.getElementById('loginBtn'),
  specLoginBtn: document.getElementById('specLoginBtn'),
  loginErr: document.getElementById('loginErr'),
  health: document.getElementById('health'),
  healthBar: document.getElementById('healthBar'),
  healthFill: document.getElementById('healthFill'),
  healthText: document.getElementById('healthText'),
  inventory: document.getElementById('inventory'),
  status: document.getElementById('status'),
  stats: document.getElementById('stats'),
  pName: document.getElementById('pName'),
  pCode: document.getElementById('pCode'),
  pMaxDepth: document.getElementById('pMaxDepth'),
  pDeaths: document.getElementById('pDeaths'),
  pItems: document.getElementById('pItems'),
  pRuns: document.getElementById('pRuns'),
  pClass: document.getElementById('pClass'),
  profile: document.getElementById('profile'),
  emotePanel: document.getElementById('emotePanel'),
  emoteList: document.getElementById('emoteList'),
  inventoryBtn: document.getElementById('inventoryBtn'),
  inventoryPanel: document.getElementById('inventoryPanel'),
  invTabs: document.getElementById('invTabs'),
  invBody: document.getElementById('invBody'),
  closeInventory: document.getElementById('closeInventory'),
  battleScreen: document.getElementById('battleScreen'),
  bsBoss: document.getElementById('bsBoss'),
  bsParty: document.getElementById('bsParty'),
  bsTurnOrder: document.getElementById('bsTurnOrder'),
  battleLog: document.getElementById('battleLog'),
  battleActions: document.getElementById('battleActions'),
  battleItemMenu: document.getElementById('battleItemMenu'),
  battleSkillMenu: document.getElementById('battleSkillMenu'),
  battleTurn: document.getElementById('battleTurn'),
  battleResult: document.getElementById('battleResult'),
  battleResultBoss: document.getElementById('battleResultBoss'),
  battleResultBody: document.getElementById('battleResultBody'),
  battleResultConfirm: document.getElementById('battleResultConfirm'),
  tooltip: document.getElementById('tooltip'),
  inviteBar: document.getElementById('inviteBar'),
  inviteText: document.getElementById('inviteText'),
  inviteJoin: document.getElementById('inviteJoin'),
  inviteIgnore: document.getElementById('inviteIgnore'),
  rules: document.getElementById('rules'),
  rulesBody: document.getElementById('rulesBody'),
  tutPage: document.getElementById('tutPage'),
  tutBack: document.getElementById('tutBack'),
  tutNext: document.getElementById('tutNext'),
  tutSkip: document.getElementById('tutSkip'),
  toasts: document.getElementById('toasts'),
  cv: document.getElementById('cv'),
  halt: document.getElementById('halt'),
  haltMsg: document.getElementById('haltMsg'),
  offline: document.getElementById('offline'),
  offlineMsg: document.getElementById('offlineMsg'),
  classChoose: document.getElementById('classChoose'),
  classList: document.getElementById('classList'),
  classDesc: document.getElementById('classDesc'),
  classConfirm: document.getElementById('classConfirm'),
  specPanel: document.getElementById('specPanel'),
  specMode: document.getElementById('specMode'),
  specAdminOpts: document.getElementById('specAdminOpts'),
  specSecret: document.getElementById('specSecret'),
  specAggregate: document.getElementById('specAggregate'),
  specMargin: document.getElementById('specMargin'),
  specErr: document.getElementById('specErr'),
  specBoardRows: document.getElementById('specBoardRows'),
  specBoardEmpty: document.getElementById('specBoardEmpty'),
  specFollow: document.getElementById('specFollow'),
  topControls: document.getElementById('topControls'),
};

const ctx = el.cv.getContext('2d');
const specCv = document.getElementById('cvSpec');
const specCtx = specCv.getContext('2d');

// ================= login =================

(function prefill() {
  const m = document.cookie.match(/digcode=([A-Z0-9]+)/);
  if (m) el.code.value = m[1];
})();

function login() {
  const name = el.name.value.trim();
  const code = el.code.value.trim().toUpperCase();
  if (!name && !code) {
    el.loginErr.textContent = 'Enter a name, or the code from a previous game.';
    return;
  }
  el.loginBtn.disabled = true;
  el.loginErr.textContent = '';
  socket.emit('login', { name, code }, (res) => {
    el.loginBtn.disabled = false;
    if (!res || res.error) {
      el.loginErr.textContent = (res && res.error) || 'Could not log in.';
      return;
    }
    if (Array.isArray(res.classes) && res.classes.length) state.classes = res.classes;
    state.code = res.code;
    state.name = res.name;
    state.stats = res.stats || null;
    document.cookie = `digcode=${res.code}; max-age=${60 * 60 * 24 * 180}; path=/; SameSite=Lax`;
    el.login.classList.add('hidden');
    el.game.classList.remove('hidden');
    el.pName.textContent = res.name;
    el.pCode.textContent = res.code;
    resize();
    // A class is the price of entry: an account that has not chosen one for
    // this run has no character on the field yet. Only chooseClass spawns it,
    // so the chooser (after the rules, for a brand new account) comes first.
    if (res.needsClass) {
      state.pendingClass = true;
      state.me = null;
      if (!res.rulesSeen) showRules();
      else showClassChoose();
      return;
    }
    state.model = res.model != null ? res.model : state.model;
    state.pendingClass = false;
    buildClassDisplay();
    applyState(res.state);
    // The server owns the "is this a new player" question, so the dialog is
    // shown for exactly the accounts that have never been shown it.
    if (!res.rulesSeen) showRules();
  });
}

el.loginBtn.addEventListener('click', login);
for (const input of [el.name, el.code]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
}

// ================= entry class choice =================

/** The class table to lay out, falling back to the sprite mirror if the server
 *  has not handed us one (tests, or a very old reply). */
function classTable() {
  if (state.classes && state.classes.length) return state.classes;
  return MODELS.map((m) => ({ id: m.id, name: m.name, desc: '', skills: [] }));
}

/** The class name for an index, preferring the server's table. */
function className(i) {
  const c = classTable()[i];
  return c ? c.name : (MODELS[i] ? MODELS[i].name : `Class ${i}`);
}

/** Show the chosen class in the profile. */
function buildClassDisplay() {
  if (!el.pClass) return;
  el.pClass.textContent = state.model == null ? '—' : className(state.model);
}

/**
 * The entry chooser. It is a mandatory modal and is deliberately not in the
 * POPUP registry: Esc must not be able to leave a player classless.
 */
function showClassChoose() {
  state.pendingClass = true;
  state.classPick = null;
  renderClassList();
  renderClassDesc(null);
  el.classConfirm.disabled = true;
  el.classChoose.classList.remove('hidden');
  if (el.topControls) el.topControls.classList.add('locked');
}

function hideClassChoose() {
  el.classChoose.classList.add('hidden');
  if (el.topControls) el.topControls.classList.remove('locked');
}

/** One card per class: a large sprite with the name beneath it. */
function renderClassList() {
  const table = classTable();
  const cards = [];
  table.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'cCard';
    if (i === state.classPick) card.classList.add('sel');
    card.dataset.index = String(i);
    const art = HERO_BATTLE[c.id] || heroArt(i);
    if (art) card.appendChild(spriteCanvas(art, spriteScale(art, CARD_FOOT), null, 'cSprite'));
    const name = document.createElement('div');
    name.className = 'cName';
    name.textContent = c.name;
    card.appendChild(name);
    // hovering previews the description; a click commits the highlight
    card.addEventListener('mouseenter', () => renderClassDesc(i));
    card.addEventListener('focus', () => renderClassDesc(i));
    card.addEventListener('click', () => selectClass(i));
    cards.push(card);
  });
  el.classList.replaceChildren(...cards);
}

function selectClass(i) {
  state.classPick = i;
  renderClassList();
  renderClassDesc(i);
  el.classConfirm.disabled = false;
}

/** The prose panel: what the class is, and what its skills do. */
function renderClassDesc(i) {
  if (i == null) {
    const hint = document.createElement('p');
    hint.className = 'small';
    hint.textContent = 'Hover a class to read what it does, then pick one and confirm.';
    el.classDesc.replaceChildren(hint);
    return;
  }
  const c = classTable()[i];
  if (!c) return;
  const nodes = [];
  const h = document.createElement('h3');
  h.textContent = c.name;
  nodes.push(h);
  if (c.desc) {
    const p = document.createElement('p');
    p.textContent = c.desc;
    nodes.push(p);
  }
  for (const s of c.skills || []) {
    const row = document.createElement('div');
    row.className = 'skill ' + (s.kind === 'passive' ? 'passive' : 'active');
    const b = document.createElement('b');
    b.textContent = s.name;
    row.appendChild(b);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind === 'passive' ? 'Passive' : 'Active';
    row.appendChild(kind);
    if (s.desc) {
      const d = document.createElement('div');
      d.textContent = s.desc;
      row.appendChild(d);
    }
    nodes.push(row);
  }
  el.classDesc.replaceChildren(...nodes);
}

function confirmClass() {
  if (state.classPick == null) return;
  el.classConfirm.disabled = true;
  const index = state.classPick;
  socket.emit('chooseClass', { modelIndex: index }, (res) => {
    if (!res || res.error) {
      el.classConfirm.disabled = false;
      toast((res && res.error) || 'Could not choose a class.', 'bad');
      return;
    }
    if (Array.isArray(res.classes) && res.classes.length) state.classes = res.classes;
    state.code = res.code || state.code;
    state.name = res.name || state.name;
    state.stats = res.stats || state.stats;
    state.model = res.model != null ? res.model : index;
    state.pendingClass = false;
    state.classPick = null;
    if (el.pName) el.pName.textContent = state.name;
    buildClassDisplay();
    hideClassChoose();
    applyState(res.state);
    updateHud();
  });
}

el.classConfirm.addEventListener('click', confirmClass);

// ================= state =================

/** Take a full authoritative state. The only way to (re)build the world view. */
function applyState(s) {
  if (!s) return;
  if (s.world) {
    state.width = s.world.width;
    state.surfaceY = s.world.surfaceY;
  }
  state.rev = typeof s.rev === 'number' ? s.rev : state.rev;
  state.blocks = {};
  for (const b of s.blocks) state.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
  state.players = s.players || [];
  takeYou(s.you);
  el.cv.classList.remove('hidden');
  updateHud();
}

/** Adopt the server's idea of where we are, and re-anchor the interpolation. */
function takeYou(you) {
  if (!you) return;
  const first = !state.me;
  state.me = you;
  // the snapshot knows which revision it was taken at, so a private event
  // (digComplete, state) is enough to keep our rev current. Without this the
  // next action goes out stale and is answered with a full resync.
  if (typeof you.rev === 'number') state.rev = you.rev;
  state.dig = you.digging ? { ...you.digging } : null;
  // our own traps: the only ones we are allowed to see (BUGS v0.3.0)
  state.myTraps = you.traps || [];
  // the fight we are locked in and the loot on the ground, both server-owned
  state.battle = you.battle || null;
  if (Array.isArray(you.loot)) state.loot = you.loot;
  state.serverSkew = Date.now() - (you.serverNow || Date.now());
  if (first || Math.abs(you.x - state.drawMe.x) > 2 || Math.abs(you.y - state.drawMe.y) > 2) {
    state.drawMe.x = you.x;
    state.drawMe.y = you.y;
    state.snap = true;
  }
  renderBattle();
}

/** Server time as best we can tell it, for rendering countdowns only. */
function now() { return Date.now() - state.serverSkew; }

function sync() {
  socket.emit('action', { type: 'sync', rev: state.rev }, (res) => {
    if (res && res.state) applyState(res.state);
  });
}

let pending = 0;
function sendAction(type, dir, extra) {
  if (!state.me || state.halted) return;
  // keep the server's answers in order: a burst of keypresses must not be
  // answered out of order, which is how the old client ended up with a mix of
  // two different states
  if (pending > 8) return;
  pending++;
  socket.emit('action', { type, dir, rev: state.rev, ...(extra || {}) }, (res) => {
    pending--;
    if (!res) return;
    if (res.needSync) { applyState(res.state); return; }
    if (typeof res.rev === 'number') state.rev = res.rev;
    if (res.you) takeYou(res.you);
    const delta = res.delta || {};
    if (delta.revealed) reveal(delta.revealed);
    if (delta.destroyed) for (const c of delta.destroyed) markChanged(c.x, c.y);
    if (delta.trapPlaced) markChanged(delta.trapPlaced.x, delta.trapPlaced.y);
    if (!res.ok) complain(res.error);
    updateHud();
  });
}

const ERRORS = {
  stone: 'Stone — that will not budge.',
  occupied: 'Someone is standing there.',
  stuck: 'You are stuck in a bear trap!',
  wall: 'A wall.',
  above_surface: 'You cannot go higher than the surface.',
  not_diggable: 'Nothing to dig there.',
  no_dynamite: 'No dynamite left.',
  no_trap: 'No bear traps left.',
  no_item: 'No potion left.',
  hp_full: 'You are already at full health.',
  dead: 'You are dead. Waiting to respawn…',
  dying: 'The spikes have you.',
  invalid_emote: 'That emote is not recognised.',
  emote_cooldown: 'You are doing that a little too fast.',
  in_battle: 'You are in a fight — finish it first.',
  not_in_battle: 'You are not in a fight.',
  not_your_turn: 'It is not your turn.',
  invalid_battle_action: 'You cannot do that here.',
  no_skill: 'That weapon has no skill.',
  invalid_weapon: 'You do not own that weapon.',
  no_join: 'That fight is no longer open.',
  battle_full: 'That fight is already full.',
  bedrock: 'Bedrock. Nothing gets through it.',
};

function sendEmote(id) {
  if (!state.me || state.halted) return;
  if (pending > 8) return;
  pending++;
  socket.emit('action', { type: 'emote', id, rev: state.rev }, (res) => {
    pending--;
    if (!res) return;
    if (res.needSync) { applyState(res.state); return; }
    if (typeof res.rev === 'number') state.rev = res.rev;
    if (res.you) takeYou(res.you);
    const delta = res.delta || {};
    if (delta.emote) {
      if (state.me) state.me.emote = delta.emote;
    }
    updateHud();
  });
}

function complain(error) {
  const text = ERRORS[error] || (error ? `Cannot: ${error}` : '');
  if (text) toast(text, 'bad');
}

function reveal(cells) {
  for (const b of cells) {
    if (!b) continue;
    state.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
  }
}

function markChanged(x, y) {
  const k = x + ',' + y;
  if (state.blocks[k]) state.blocks[k] = { type: 'air', item: null };
  state.flashes[k] = now() + 350;
}

// ================= tooltip =================

/**
 * One tooltip for the whole page, moved by the mouse. Following the cursor in
 * script rather than a CSS `:hover` bubble means the description can be a real
 * block of text that never gets clipped by the panel it belongs to.
 */
function showTip(text, ev) {
  if (!el.tooltip) return;
  el.tooltip.textContent = text;
  el.tooltip.classList.remove('hidden');
  moveTip(ev);
}

function moveTip(ev) {
  if (!el.tooltip || el.tooltip.classList.contains('hidden')) return;
  const x = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
  const y = ev && typeof ev.clientY === 'number' ? ev.clientY : 0;
  el.tooltip.style.left = (x + 16) + 'px';
  el.tooltip.style.top = (y + 16) + 'px';
}

function hideTip() {
  if (el.tooltip) el.tooltip.classList.add('hidden');
}

/** Give an element a hover description that follows the pointer. */
function tipOn(node, text) {
  if (!text) return node;
  node.addEventListener('mouseenter', (ev) => showTip(text, ev));
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', hideTip);
  return node;
}

// ================= inventory & weapons =================

/** Equip a weapon we own. The server refuses this mid-fight (in_battle). */
function equipWeapon(id) {
  if (!state.me || state.halted) return;
  sendAction('equipWeapon', undefined, { id });
}

/** Enter a gate fight that is still taking players. */
function joinBattle(id) {
  if (!state.me || state.halted) return;
  sendAction('joinBattle', undefined, { id });
  hideInvite();
}

/**
 * The verbs the battle overlay sends. `item` is only used by useBattleItem,
 * `target` names the ally a healing item is aimed at, and `id` names the skill
 * a skill action is for.
 */
function sendBattle(type, item, target, id) {
  if (!state.me || state.halted || !state.battle) return;
  const extra = {};
  if (item) extra.item = item;
  if (target != null) extra.target = target;
  if (id) extra.id = id;
  sendAction(type, undefined, Object.keys(extra).length ? extra : undefined);
}

function showInventory() {
  if (!state.me || state.halted) return;
  el.inventoryPanel.classList.remove('hidden');
  renderInventory();
}

function hideInventory() {
  el.inventoryPanel.classList.add('hidden');
}

function toggleInventory() {
  togglePanel('inventory');
}

function tabButton(tab, label) {
  const b = document.createElement('button');
  b.className = 'invTab' + (state.invTab === tab ? ' sel' : '');
  b.textContent = label;
  b.addEventListener('click', () => { state.invTab = tab; renderInventory(); });
  return b;
}

function itemRow(id) {
  const meta = ITEM[id] || { sym: '?', label: id };
  const row = document.createElement('div');
  row.className = 'invRow';
  const count = id === 'shovel'
    ? Math.max(0, Math.ceil((state.me.shovelUntil - now()) / 1000)) + 's'
    : String(state.me[id] || 0);
  const label = document.createElement('span');
  label.textContent = `${meta.sym}  ${meta.label}  ×${count}`;
  row.appendChild(label);
  // A potion is the one consumable with a field use, so it gets a Use button
  // here; every other item is spent from the action bar or the battle menu.
  if (id === 'potion') {
    const btn = document.createElement('button');
    btn.className = 'invUse';
    const usable = (state.me.potion || 0) > 0 && state.me.hp < state.me.maxHp;
    btn.textContent = 'Use';
    btn.disabled = !usable;
    if (usable) btn.addEventListener('click', usePotion);
    row.appendChild(btn);
  }
  tipOn(row, `${meta.label}${meta.desc ? ` — ${meta.desc}` : ''}`);
  return row;
}

/** Drink a potion from the field: the server refuses it if the bar is full. */
function usePotion() {
  sendAction('usePotion');
}

/** The hover blurb for a weapon: its numbers, its flavour, and any skill. */
function weaponTip(w) {
  const parts = [`${w.name} — dmg ${w.damage} · hit ${Math.round((w.hit || 0) * 100)}% · crit ${Math.round((w.crit || 0) * 100)}%`];
  if (w.desc) parts.push(w.desc);
  if (w.skill) parts.push(`${w.skill.name}: a much heavier blow, at the cost of a turn.`);
  return parts.join('\n');
}

/** Draw the inventory popup: the Items tab, or the weapons we may equip. */
function renderInventory() {
  if (!state.me) return;
  const tabs = document.createElement('div');
  tabs.id = 'invTabRow';
  tabs.appendChild(tabButton('items', 'Items'));
  tabs.appendChild(tabButton('weapon', 'Weapon'));
  el.invTabs.replaceChildren(tabs);

  const body = document.createElement('div');
  if (state.invTab === 'weapon') {
    const owned = state.me.weapons || [];
    if (!owned.length) {
      const p = document.createElement('p');
      p.className = 'small';
      p.textContent = 'No weapons yet. Defeat a boss to earn one.';
      body.appendChild(p);
    }
    for (const id of owned) {
      const w = WEAPONS[id] || { name: id, glyph: '?', desc: '' };
      const row = document.createElement('div');
      row.className = 'invWeapon';
      const equipped = state.me.weapon === id;
      const btn = document.createElement('button');
      btn.className = 'equip' + (equipped ? ' sel' : '');
      btn.textContent = equipped ? 'Equipped' : 'Equip';
      if (!equipped) btn.addEventListener('click', () => equipWeapon(id));
      const label = document.createElement('span');
      label.className = 'wname';
      label.textContent = `${w.glyph} ${w.name}`;
      row.append(btn, label);
      // the numbers and the flavour text live on hover, not inline, so the list
      // stays one line per weapon
      tipOn(row, weaponTip(w));
      body.appendChild(row);
    }

  } else {
    for (const id of ['armor', 'dynamite', 'trap', 'potion', 'shovel']) {
      if (id === 'shovel' && !(state.me.shovelUntil > now())) continue;
      body.appendChild(itemRow(id));
    }
  }
  el.invBody.replaceChildren(body);
}

// ================= battle screen =================

/**
 * One fighter's bar: a fixed-width track, red health painted from the left, a
 * grey armour plate laid over it (full while the armour is untouched, receding
 * as the boss chips it), and the exact numbers on top. Every bar is the same
 * width whatever the totals, so a fight can be read at a glance.
 */
function fighterBar(hp, maxHp, armour, maxArmour) {
  const bar = document.createElement('div');
  bar.className = 'bsBar';

  const health = document.createElement('div');
  health.className = 'bsHp';
  health.style.width = (maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) * 100 : 0) + '%';

  const shield = document.createElement('div');
  shield.className = 'bsArmour';
  shield.style.width = (maxArmour > 0 ? Math.max(0, Math.min(1, armour / maxArmour)) * 100 : 0) + '%';

  const text = document.createElement('span');
  text.className = 'bsBarText';
  const points = Math.max(0, hp);
  text.textContent = maxArmour > 0
    ? `${points}/${maxHp} · ⛨ ${Math.max(0, armour)}`
    : `${points}/${maxHp}`;

  bar.append(health, shield, text);
  return bar;
}

// How long a wound keeps its white flash. A single hit can reach the client as
// two renders (the state event that carries the drop, then the action's own
// ack with the very same hp), and both rebuild the sprite. Holding the flash
// open for a moment means the second render keeps flashing instead of wiping a
// fresh animation off the screen before it is ever painted.
const FLASH_MS = 400;
// Last hp and armour, plus the tail of the active flash, for each combatant,
// keyed by 'boss' or a party member id. Armour is banked at the start of a fight
// and only ever falls as it soaks a blow, so a drop in either is a hit - which
// is how a fully-armoured fighter still flashes for damage that never reaches
// its health.
const battleHpSeen = new Map();
let lastBattleId = null;

/**
 * Record a combatant's hp and armour and report whether its sprite should flash
 * white. A drop in either opens a short flash window; a redundant render inside
 * that window keeps flashing. `at` is injectable so the window can be tested
 * without sleep.
 */
function battleHit(id, hp, armour = 0, at = Date.now()) {
  const prev = battleHpSeen.get(id);
  if (!prev) {
    battleHpSeen.set(id, { hp, armour, until: 0 });
    return false;
  }
  const hurt = hp < prev.hp || armour < prev.armour;
  const flashing = hurt || at < prev.until;
  const until = hurt ? at + FLASH_MS : (flashing ? prev.until : 0);
  battleHpSeen.set(id, { hp, armour, until });
  return flashing;
}

/** One combatant on the stage: pixel sprite, name, and bar. */
function fighterEl(opts) {
  const wrap = document.createElement('div');
  wrap.className = 'bsFighter';
  if (opts.turn) wrap.classList.add('turn');
  if (opts.acting) wrap.classList.add('acting');
  if (opts.target) wrap.classList.add('target');
  if (opts.alive === false) wrap.classList.add('down');
  if (opts.hit) wrap.classList.add('hit');

  const art = opts.boss ? bossArt(opts.species, opts.kind) : heroArt(opts.model);
  const canvas = spriteCanvas(art, spriteScale(art, opts.boss ? BOSS_FOOT : HERO_FOOT));
  wrap.appendChild(canvas);

  const name = document.createElement('div');
  name.className = 'bsName';
  name.textContent = opts.alive === false ? `${opts.name} (down)` : opts.name;
  wrap.appendChild(name);

  wrap.appendChild(fighterBar(opts.hp, opts.maxHp, opts.armour || 0, opts.maxArmour || 0));
  return wrap;
}

function renderBoss(b) {
  const wrap = fighterEl({
    boss: true,
    kind: b.boss.kind,
    species: b.boss.species,
    name: b.boss.name,
    hp: b.boss.hp, maxHp: b.boss.maxHp,
    alive: b.boss.hp > 0,
    turn: !!b.bossTurn, acting: !!b.bossTurn,
    hit: battleHit('boss', b.boss.hp),
  });
  if (el.bsBoss) el.bsBoss.replaceChildren(wrap);
}

/** The party row; the row for the actor that is up next is highlighted. */
function renderParty(b) {
  const list = document.createElement('div');
  list.className = 'bsPartyRow';
  const aimed = state.battleTarget;
  for (const m of b.party || []) {
    const up = b.phase === 'active' && b.turn === m.id;
    list.appendChild(fighterEl({
      model: m.model, name: m.name,
      hp: m.hp, maxHp: m.maxHp, armour: m.armour, maxArmour: m.maxArmour,
      alive: m.hp > 0, turn: up, acting: up,
      target: !!(aimed && aimed.target === m.id),
      hit: battleHit(m.id, m.hp, m.armour),
    }));
  }
  if (el.bsParty) el.bsParty.replaceChildren(list);
}

/** The order still to come this round, the actor first and the boss last. */
function renderTurnOrder(b) {
  const list = document.createElement('div');
  list.className = 'bsTurnList';

  const title = document.createElement('div');
  title.className = 'bsTurnTitle';
  title.textContent = 'Turn order';
  list.appendChild(title);

  if (b.phase === 'join') {
    const wait = document.createElement('div');
    wait.className = 'bsTurnRow';
    wait.textContent = 'Waiting for allies…';
    list.appendChild(wait);
    if (el.bsTurnOrder) el.bsTurnOrder.replaceChildren(list);
    return;
  }

  // The whole round's order: a fixed ring led by the current actor, so spending
  // a turn rotates them to the back instead of shortening the list.
  const party = b.party || [];
  const ids = party.map((m) => m.id);
  const cur = b.bossTurn ? -1 : ids.indexOf(b.turn);
  const ring = cur > 0 ? ids.slice(cur).concat(ids.slice(0, cur)) : ids.slice();
  const rows = [];
  if (b.bossTurn) rows.push({ boss: true, name: b.boss.name });
  for (const id of ring) {
    const m = party.find((p) => p.id === id);
    rows.push({ boss: false, name: m ? m.name : '?' });
  }
  if (!b.bossTurn) rows.push({ boss: true, name: b.boss.name });

  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'bsTurnRow' + (i === 0 ? ' now' : '') + (r.boss ? ' boss' : '');
    row.textContent = `${i + 1}. ${r.name}`;
    list.appendChild(row);
  });
  if (el.bsTurnOrder) el.bsTurnOrder.replaceChildren(list);
}

/** Whether an item is aimed at a party member rather than the wielder. */
function targetableItem(item) {
  return !!(ITEM[item] && ITEM[item].ally);
}

function itemButton(item, count, label) {
  const b = document.createElement('button');
  b.className = 'battleItem';
  b.textContent = label;
  b.disabled = !(count > 0);
  b.addEventListener('click', () => {
    if (targetableItem(item)) beginTarget('useBattleItem', item);
    else { sendBattle('useBattleItem', item); hideItemMenu(); }
  });
  return b;
}

// ================= battle targeting =================
// A healing item is aimed before it is thrown: the cursor names one member, the
// arrow keys walk it round the party, and only then is the item sent. The same
// shape will carry an ally-directed skill once one exists.

/** Start aiming `item` (or a future skill); the cursor opens on the wielder. */
function beginTarget(type, item) {
  const b = state.battle;
  if (!b || !Array.isArray(b.party) || !b.party.length) return;
  const self = b.party.find((m) => m.id === (b.me && b.me.id));
  state.battleTarget = { type, item, target: (self || b.party[0]).id };
  hideItemMenu();
  hideSkillMenu();
  renderBattle();
}

function cycleTarget(step) {
  const b = state.battle;
  if (!state.battleTarget || !b || !Array.isArray(b.party) || !b.party.length) return;
  const at = b.party.findIndex((m) => m.id === state.battleTarget.target);
  const n = b.party.length;
  state.battleTarget.target = b.party[((at + step) % n + n) % n].id;
  renderBattle();
}

function cancelTarget() {
  if (!state.battleTarget) return;
  state.battleTarget = null;
  renderBattle();
}

/** Use the aimed item on the highlighted member; a whole one is refused. */
function confirmTarget() {
  const bt = state.battleTarget;
  const b = state.battle;
  if (!bt || !b) return;
  const m = b.party.find((x) => x.id === bt.target);
  if (m && m.hp >= m.maxHp) { toast('HP is full', 'bad'); return; }
  state.battleTarget = null;
  sendBattle(bt.type, bt.item, bt.target);
  renderBattle();
}

function hideItemMenu() {
  el.battleItemMenu.classList.add('hidden');
}

function toggleItemMenu() {
  const hidden = el.battleItemMenu.classList.contains('hidden');
  if (hidden) { buildItemMenu(); hideSkillMenu(); }
  el.battleItemMenu.classList.toggle('hidden', !hidden);
}

function buildItemMenu() {
  const me = state.battle && state.battle.me;
  if (!me) return;
  const wrap = document.createElement('div');
  wrap.appendChild(itemButton('dynamite', me.dynamite, `💣 Dynamite ×${me.dynamite}`));
  wrap.appendChild(itemButton('trap', me.trap, `🪤 Trap ×${me.trap}`));
  wrap.appendChild(itemButton('potion', me.potion, `🧪 Potion ×${me.potion}`));
  el.battleItemMenu.replaceChildren(wrap);
}

function hideSkillMenu() {
  el.battleSkillMenu.classList.add('hidden');
}

/**
 * The skills the fight can offer. The server names every one of them - the
 * class actives, the class passives (for their prose) and any weapon skill -
 * so the client only has to lay them out. A passive is listed but never usable.
 */
function battleSkills() {
  const me = state.battle && state.battle.me;
  if (!me) return [];
  return me.skills || [];
}

function toggleSkillMenu() {
  const hidden = el.battleSkillMenu.classList.contains('hidden');
  if (hidden) { buildSkillMenu(); hideItemMenu(); }
  el.battleSkillMenu.classList.toggle('hidden', !hidden);
}

function buildSkillMenu() {
  const me = state.battle && state.battle.me;
  if (!me) return;
  const wrap = document.createElement('div');
  const skills = battleSkills();
  if (!skills.length) {
    const none = document.createElement('span');
    none.className = 'battleItem';
    none.textContent = 'No skills';
    wrap.appendChild(none);
  } else {
    for (const s of skills) {
      const passive = s.kind === 'passive';
      const usable = !passive && s.usable !== false;
      const b = document.createElement('button');
      // A passive (or a spent active) is drawn dimmer and never fires: it is
      // there so its description can be read, not to be pressed.
      b.className = 'battleItem';
      if (passive) b.classList.add('passive');
      else if (!usable) b.classList.add('spent');
      b.textContent = s.name || s.id;
      const tip = (s.desc || '') + (s.note ? '\n' + s.note : '');
      if (tip) tipOn(b, tip);
      if (usable) {
        b.addEventListener('click', () => { sendBattle('skill', null, null, s.id); hideSkillMenu(); });
      }
      wrap.appendChild(b);
    }
  }
  el.battleSkillMenu.replaceChildren(wrap);
}

/** The victory window: what this player won, and the button that lets them go. */
function renderBattleResult(b) {
  if (!el.battleResult) return;
  el.battleResultBoss.textContent = `${b.boss ? b.boss.name : 'The boss'} is defeated!`;
  const gained = (b.me && b.me.gained) || { weapon: null, items: {} };
  const lines = [];
  if (gained.weapon) {
    const w = WEAPONS[gained.weapon];
    lines.push({ cls: 'bsLootRow', text: `${(w && w.glyph) || '⚔'} ${(w && w.name) || gained.weapon}` });
  }
  for (const [id, n] of Object.entries(gained.items || {})) {
    const it = ITEM[id];
    lines.push({ cls: 'bsLootRow', text: `${(it && it.sym) || '•'} ${(it && it.label) || id} ×${n}` });
  }
  if (!lines.length) lines.push({ cls: 'bsLootNone', text: 'No loot this time.' });
  const rows = lines.map((l) => {
    const row = document.createElement('div');
    row.className = l.cls;
    row.textContent = l.text;
    return row;
  });
  el.battleResultBody.replaceChildren(...rows);
  el.battleResult.classList.remove('hidden');
}

function actionButton(label, act, disabled) {
  const b = document.createElement('button');
  b.className = 'battleAct';
  b.textContent = label;
  b.disabled = !!disabled;
  b.addEventListener('click', act);
  return b;
}

/** Show or hide the full-screen fight and rebuild it from the server's view. */
function renderBattle() {
  const b = state.battle;
  if (!el.battleScreen) return;
  if (!b) {
    battleHpSeen.clear();
    lastBattleId = null;
    state.battleTarget = null;
    el.battleScreen.classList.add('hidden');
    hideItemMenu();
    hideSkillMenu();
    el.battleResult.classList.add('hidden');
    hideTip();
    return;
  }
  if (b.id !== lastBattleId) {
    battleHpSeen.clear();
    lastBattleId = b.id;
  }
  el.battleScreen.classList.remove('hidden');

  // An aim only makes sense while it is still your turn and the member is here.
  if (state.battleTarget && (b.phase !== 'active' || !b.isMyTurn
      || !(b.party || []).some((m) => m.id === state.battleTarget.target))) {
    state.battleTarget = null;
  }

  renderBoss(b);
  renderParty(b);
  renderTurnOrder(b);

  const log = document.createElement('div');
  for (const line of b.log || []) {
    const p = document.createElement('div');
    p.className = 'blogLine ' + (line.kind || '');
    p.textContent = line.text;
    log.appendChild(p);
  }
  el.battleLog.replaceChildren(log);
  el.battleLog.scrollTop = el.battleLog.scrollHeight;

  if (b.phase === 'join') {
    el.battleResult.classList.add('hidden');
    const secs = Math.max(0, Math.ceil((b.joinDeadline - now()) / 1000));
    el.battleTurn.textContent = `Waiting for allies… ${secs}s`;
    const acts = document.createElement('div');
    // only the player who opened the encounter can cut the wait short
    if (b.me && b.initiator === b.me.id) {
      acts.appendChild(actionButton('Start', () => sendBattle('startBattle'), false));
    }
    el.battleActions.replaceChildren(acts);
    hideItemMenu();
    hideSkillMenu();
    return;
  }

  // The fight is won, but the party stays until everyone has seen their loot.
  if (b.phase === 'result') {
    el.battleTurn.textContent = 'Victory!';
    el.battleActions.replaceChildren();
    hideItemMenu();
    hideSkillMenu();
    renderBattleResult(b);
    return;
  }

  el.battleResult.classList.add('hidden');
  const mine = b.isMyTurn;
  const actor = b.bossTurn
    ? b.boss.name
    : ((b.party.find((m) => m.id === b.turn) || {}).name || '?');

  // Aiming a healing item: the turn line becomes the aiming prompt and the
  // verb buttons step aside, since the choice is made on the party row.
  const aimed = state.battleTarget;
  const acts = document.createElement('div');
  if (aimed) {
    const m = b.party.find((x) => x.id === aimed.target);
    const label = (ITEM[aimed.item] && ITEM[aimed.item].label) || aimed.item || 'skill';
    el.battleTurn.textContent = `Use ${label} on ${m ? m.name : '?'} · ←/→ · Enter · Esc`;
  } else {
    el.battleTurn.textContent = mine ? 'Your turn!' : `${actor}'s turn`;
    acts.appendChild(actionButton('Attack', () => sendBattle('attack'), !mine));
    acts.appendChild(actionButton('Defend', () => sendBattle('defend'), !mine));
    acts.appendChild(actionButton('Item', () => toggleItemMenu(), !mine || !b.me));
    acts.appendChild(actionButton('Skill', () => toggleSkillMenu(), !mine || !b.me));
  }
  el.battleActions.replaceChildren(acts);
  if (!mine || state.battleTarget) { hideItemMenu(); hideSkillMenu(); }
}

/**
 * Keep the join countdown ticking between server snapshots. The fight view is
 * only re-sent on events, so a timer written once inside renderBattle would sit
 * still until the next event - which used to be the 5s fallback sync.
 */
function updateBattleClock() {
  const b = state.battle;
  if (!b || b.phase !== 'join' || !el.battleTurn) return;
  const secs = Math.max(0, Math.ceil((b.joinDeadline - now()) / 1000));
  el.battleTurn.textContent = `Waiting for allies… ${secs}s`;
}

// ================= gate invites =================

function showInvite(inv) {
  // never invite someone who is already locked in a fight (the initiator is)
  if (state.battle) return;
  state.battleInvite = inv;
  el.inviteText.textContent = `${inv.boss} blocks the way — join the fight? (${inv.partyMax} max)`;
  el.inviteBar.classList.remove('hidden');
}

function hideInvite() {
  state.battleInvite = null;
  el.inviteBar.classList.add('hidden');
}

el.inviteJoin.addEventListener('click', () => {
  if (state.battleInvite) joinBattle(state.battleInvite.battleId);
});
el.inviteIgnore.addEventListener('click', hideInvite);
el.battleResultConfirm.addEventListener('click', () => sendBattle('confirmResult'));
el.closeInventory.addEventListener('click', hideInventory);
el.inventoryBtn.addEventListener('click', toggleInventory);

// ================= events =================

/**
 * The offline veil. It is not a toast and not a popup: it stays up, over
 * everything, for as long as the connection is down, and nothing the player
 * presses can dismiss it. Clearing it is the connect handler's job alone.
 */
function setOffline(on, msg) {
  if (!el.offline) return;
  if (msg) el.offlineMsg.textContent = msg;
  el.offline.classList.toggle('hidden', !on);
}

socket.on('connect', () => {
  state.connected = true;
  setOffline(false);
  setStatus();
  // a reconnect means we may have missed anything at all
  if (state.me) sync();
});

socket.on('disconnect', (reason) => {
  state.connected = false;
  setStatus();
  const lost = reason === 'io server disconnect' || reason === 'transport close'
    || reason === 'transport error' || reason === 'ping timeout';
  setOffline(true, lost
    ? 'Lost connection to the server. You are not in the pit until it comes back.'
    : 'Disconnected from the server.');
});

socket.on('connect_error', () => {
  state.connected = false;
  setStatus();
  setOffline(true, 'Cannot reach the server. Retrying…');
});

socket.on('halted', ({ message } = {}) => {
  state.halted = true;
  el.haltMsg.textContent = message || 'The game has been halted by a server error.';
  el.halt.classList.remove('hidden');
  el.cv.classList.add('hidden');
});

socket.on('state', (msg) => {
  if (!msg) return;
  if (msg.you) takeYou(msg.you);
  // the server holds the authoritative class now, so keep the profile label in
  // step if it ever disagrees with what we drew
  if (msg.you && typeof msg.you.model === 'number' && msg.you.model !== state.model) {
    state.model = msg.you.model;
    buildClassDisplay();
  }
  updateHud();
  if (msg.reason === 'trapped') toast('A bear trap! You are stuck for a minute.', 'bad');
  if (msg.reason === 'died') toast('You died!', 'bad');
  if (msg.reason === 'trapRemoved') toast('One of your bear traps is gone.', 'bad');
});

socket.on('digComplete', (m) => {
  if (m.dug) markChanged(m.dug.x, m.dug.y);
  if (m.revealed) reveal(m.revealed);
  if (m.you) takeYou(m.you);
  if (m.item) toast(`Found ${ITEM[m.item] ? ITEM[m.item].sym + ' ' + ITEM[m.item].label : m.item}!`, 'good');
  if (m.bonus) toast('Behind the pack, and lucky.', 'good');
  updateHud();
});

socket.on('digAborted', (m) => {
  if (m.you) takeYou(m.you);
  toast(m.reason === 'blown_up' ? 'Somebody dynamited your dig.' : 'The block you were digging is gone.', 'bad');
  updateHud();
});

socket.on('respawned', (m) => {
  if (m.you) takeYou(m.you);
  state.drawMe.x = m.x != null ? m.x : state.me.x;
  state.drawMe.y = m.y != null ? m.y : state.me.y;
  toast('Respawned at the surface.', 'good');
  updateHud();
});

socket.on('blockDug', ({ x, y }) => markChanged(x, y));

socket.on('sharedDiscovery', ({ blocks }) => {
  // only sent when SHARE_DISCOVERIES is on
  reveal(blocks);
});

socket.on('boom', ({ x, y } = {}) => {
  addEffect('boom', x, y);
  if (state.me && Math.abs(state.me.x - x) <= 1 && Math.abs(state.me.y - y) <= 1) toast('BOOM!', 'good');
});

socket.on('trapTriggered', ({ x, y } = {}) => addEffect('trap', x, y));

socket.on('toast', ({ text, kind } = {}) => toast(text, kind));

socket.on('battleInvite', (inv) => { if (inv) showInvite(inv); });
socket.on('battleInviteClosed', ({ battleId } = {}) => {
  if (state.battleInvite && state.battleInvite.battleId === battleId) hideInvite();
});

socket.on('battleResult', (r) => {
  if (!r) return;
  if (r.result === 'win') {
    const bits = [];
    const gained = r.gained || {};
    if (gained.weapon) bits.push((WEAPONS[gained.weapon] || {}).name || gained.weapon);
    for (const [id, n] of Object.entries(gained.items || {})) {
      bits.push(`${ITEM[id] ? ITEM[id].sym : id}×${n}`);
    }
    toast(`Victory over ${r.boss}!${bits.length ? ' You gained: ' + bits.join(', ') : ''}`, 'good');
  } else if (r.result === 'lose') {
    toast(`Defeated by ${r.boss}. The gate holds.`, 'bad');
  } else if (r.result === 'cancelled') {
    toast('The fight is over.', '');
  }
});

socket.on('lootDropped', (g) => {
  if (!g) return;
  state.loot = state.loot.filter((l) => !(l.x === g.x && l.y === g.y));
  state.loot.push({ x: g.x, y: g.y, type: g.type, id: g.id });
});

socket.on('lootTaken', ({ x, y } = {}) => {
  state.loot = state.loot.filter((l) => !(l.x === x && l.y === y));
});

socket.on('worldReset', (m) => {
  toast('A new game has started!', 'good');
  state.spec.blocks = {};
  state.spec.deepestY = 0;
  state.myTraps = [];
  state.battle = null;
  state.battleInvite = null;
  state.battleTarget = null;
  if (m && Array.isArray(m.classes) && m.classes.length) state.classes = m.classes;
  // A class is per run, so the new run takes the old choice back. The server
  // has already detached us: there is no character to draw until we pick again.
  if (m && m.needsClass) {
    state.me = null;
    state.pendingClass = true;
    closePopups();
    hideInvite();
    renderBattle();
    showClassChoose();
    return;
  }
  if (m && m.state) applyState(m.state);
  else sync();
});

socket.on('kicked', ({ reason } = {}) => {
  toast(reason || 'You were disconnected.', 'bad');
  setTimeout(() => location.reload(), 1500);
});

socket.on('tick', (frame) => {
  if (state.spectator) return;
  if (frame.players) state.players = frame.players;
  for (const b of frame.blocks) markChanged(b.x, b.y);
  if (state.me && state.me.digging && !state.dig) state.dig = { ...state.me.digging };
  for (const e of frame.effects || []) addEffect(e.kind, e.x, e.y);
  // a targeted state event may have been missed; the next action will ask for
  // a full state anyway, and this keeps the HUD honest in the meantime
  if (state.me && !state.me.digging) state.dig = null;
});

socket.on('spectatorMode', (f) => {
  state.spectator = true;
  // a fresh spectator starts on the deepest player; a previous camera position
  // is stale because the world underneath it has just been reset
  state.specCam = { x: 0, y: 0, mode: 'deepest', target: null, placed: false };
  state.keys.clear();
  state.spec.blocks = {};
  state.spec.deepestY = 0;
  applySpec(f);
  // The mine goes away, controls and all. #login does not live inside it and
  // is absolutely positioned over the whole page, so it has to be dismissed
  // separately: leaving it up is what made watching from the login screen look
  // like the button had done nothing at all.
  el.game.classList.add('hidden');
  el.login.classList.add('hidden');
  el.spec.classList.remove('hidden');
  // The options panel is only offered once we are watching, and it starts on
  // the least privileged view this socket can actually use.
  el.specPanel.classList.remove('hidden');
  syncSpecPanel();
  resize();
});

socket.on('spectatorFrame', (f) => {
  if (!state.spectator) return;
  applySpec(f);
});

// ================= spectator =================

/**
 * Ask the server for a view. Everything the mode needs travels with the
 * request; the server decides what of it is allowed and filters the frame, so
 * nothing here can widen what we are shown.
 */
function requestSpectate(req) {
  el.specErr.textContent = '';
  socket.emit('spectate', req, (res) => {
    if (!res) return;
    if (res.error) {
      el.specErr.textContent = SPEC_ERRORS[res.error] || res.error;
      // a remembered secret the server refused is worse than none: drop it and
      // put the box back in front of them so the next try can be typed in
      if (res.error === 'bad_admin_secret') {
        forgetAdminSecret();
        el.specSecret.value = '';
        refreshSpecAdminOpts();
        el.specSecret.focus();
      }
      return;
    }
    if (res.mode === 'admin') storeAdminSecret(req.secret || el.specSecret.value);
    state.specMode = res.mode;
    if (typeof res.depthMargin === 'number') {
      state.specMargin = res.depthMargin;
      el.specMargin.value = String(res.depthMargin);
    }
    syncSpecPanel();
  });
}

// The admin secret is a shared server secret, so the server never sends it back.
// Remembering locally what was accepted means returning to the Admin view does
// not ask again; a refusal clears it and asks afresh.
const ADMIN_SECRET_KEY = 'diggame.adminSecret';
function readAdminSecret() {
  try { return localStorage.getItem(ADMIN_SECRET_KEY) || ''; } catch { return ''; }
}
function storeAdminSecret(secret) {
  if (!secret) return;
  try { localStorage.setItem(ADMIN_SECRET_KEY, secret); } catch { /* private mode */ }
}
function forgetAdminSecret() {
  try { localStorage.removeItem(ADMIN_SECRET_KEY); } catch { /* private mode */ }
}

const SPEC_ERRORS = {
  bad_admin_secret: 'That is not the admin secret.',
  admin_view_disabled: 'The admin view is switched off on this server.',
  not_logged_in: 'Log in first to watch your own discoveries.',
};

/** The request this socket should send, given the state of the panel. */
function specRequestFromPanel() {
  const mode = el.specMode.value;
  const req = { mode };
  if (mode === 'admin') {
    req.secret = el.specSecret.value;
    req.adminAll = !el.specAggregate.checked;
    const margin = Number(el.specMargin.value);
    req.depthMargin = Number.isFinite(margin) && margin >= 0 ? Math.floor(margin) : 0;
  }
  return req;
}

/** Show the admin-only fields only while Admin is the picked mode. This never
 * touches the select, so it is safe to run from the change handler. */
function refreshSpecAdminOpts() {
  el.specAdminOpts.classList.toggle('hidden', el.specMode.value !== 'admin');
}

/** Reflect the agreed mode in the panel, and show admin fields only for admin. */
function syncSpecPanel() {
  if (state.specMode) el.specMode.value = state.specMode;
  refreshSpecAdminOpts();
}

/**
 * The mode dropdown switches the view as soon as it changes. Public and player
 * are sent straight away; Admin first needs the secret, which is remembered
 * after it is accepted so coming back does not ask again.
 */
function onSpecModeChange() {
  refreshSpecAdminOpts();
  if (el.specMode.value !== 'admin') {
    requestSpectate({ mode: el.specMode.value });
    return;
  }
  const remembered = readAdminSecret();
  if (remembered) {
    el.specSecret.value = remembered;
    requestSpectate(specRequestFromPanel());
  } else {
    el.specSecret.value = '';
    el.specSecret.focus();
  }
}

/**
 * Choose what the camera follows, from the dropdown or a click on a scoreboard
 * row. `p:<id>` pins the camera to that player, 'deepest' hands it to the
 * deepest player, and anything else is manual. The frame decides later whether
 * the named player is still there; picking never widens what is on screen.
 */
function setSpecFollow(value) {
  const cam = state.specCam;
  if (value === 'deepest') {
    cam.mode = 'deepest';
    cam.target = null;
  } else if (typeof value === 'string' && value.startsWith('p:')) {
    cam.mode = 'player';
    cam.target = Number(value.slice(2));
  } else {
    cam.mode = 'manual';
    cam.target = null;
  }
  state.keys.clear();
  if (el.specFollow) el.specFollow.value = value;
}

/**
 * Keep the follow dropdown in step with the roster. On every frame, because a
 * followed player can log off at any moment: when the id is gone the camera
 * drops back to manual instead of sitting on ground they have left, and an
 * empty pit drops 'deepest' back to manual too. The options are rebuilt only
 * when the roster really changes, so the select is not churned every frame.
 */
function syncSpecFollow() {
  const cam = state.specCam;
  const players = state.spec.players || [];
  if (cam.mode === 'player' && !players.some((p) => p.id === cam.target)) {
    cam.mode = 'manual';
    cam.target = null;
  }
  if (cam.mode === 'deepest' && players.length === 0) {
    cam.mode = 'manual';
  }
  if (!el.specFollow) return;
  const sorted = players.slice().sort((a, b) => a.name.localeCompare(b.name));
  const roster = sorted.map((p) => p.id + ':' + p.name).join('|');
  if (roster !== syncSpecFollow._roster) {
    syncSpecFollow._roster = roster;
    const option = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    };
    el.specFollow.replaceChildren(
      option('manual', 'Manual'),
      option('deepest', 'Deepest player'),
      ...sorted.map((p) => option('p:' + p.id, p.name)),
    );
  }
  el.specFollow.value = state.specCam.mode === 'player' ? 'p:' + state.specCam.target : state.specCam.mode;
}

function applySpec(f) {
  if (!f) return;
  if (f.mode) state.specMode = f.mode;
  let deepest = state.spec.deepestY || 0;
  for (const b of f.blocks || []) {
    state.spec.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
    if (b.y > deepest) deepest = b.y;
  }
  // the deepest cell anybody knows about, so the camera can be clamped to the
  // real bottom of the pit instead of an invented one
  state.spec.deepestY = deepest;
  state.spec.players = f.players || [];
  state.spec.stats = f.stats || [];
  state.spec.digs = f.digs || [];
  state.spec.traps = f.traps || [];
  state.spec.width = f.width || state.spec.width;
  state.spec.surfaceY = f.surfaceY || 0;
  if (typeof f.maxY === 'number') state.spec.maxY = f.maxY;
  syncSpecFollow();
  clampSpecCam();
  updateSpecBoard();
}

/**
 * The scoreboard. Depth and best depth are public, so they are on every frame
 * in every mode - a spectator gets the standings without being able to see the
 * ground the players are standing on.
 */
function updateSpecBoard() {
  const rows = el.specBoardRows;
  if (!rows) return;
  const stats = (state.spec.stats || []).slice().sort(
    (a, b) => (b.maxDepth || 0) - (a.maxDepth || 0) || a.name.localeCompare(b.name),
  );
  const t = now();
  const lead = stats.length ? Math.max(...stats.map((s) => s.maxDepth || 0)) : 0;
  const alive = new Map((state.spec.players || []).map((p) => [p.id, p]));

  // children is an HTMLCollection, whose length is a getter with no setter.
  // Assigning to it throws, which used to abort the whole spectator frame
  // before the view was ever shown - the view then silently did nothing.
  rows.replaceChildren();
  for (const s of stats) {
    const tr = document.createElement('tr');
    if (s.maxDepth === lead && lead > 0) tr.className = 'lead';
    if (alive.has(s.id) && alive.get(s.id).alive === false) tr.className = 'dead';

    const name = document.createElement('td');
    name.textContent = s.name;
    const depth = document.createElement('td');
    depth.className = 'num';
    depth.textContent = String(s.depth);
    const best = document.createElement('td');
    best.className = 'num';
    best.textContent = String(s.maxDepth);
    const items = document.createElement('td');
    const shovel = Math.max(0, Math.ceil((s.shovelUntil - t) / 1000));
    items.textContent = shovel > 0
      ? `🛡${s.armor} 💣${s.dynamite} ⛏${shovel}s`
      : `🛡${s.armor} 💣${s.dynamite} 🪤${s.trap}`;

    tr.append(name, depth, best, items);
    // Clicking a row pins the camera to that player. Only rows whose player is
    // on the field can be followed: a stat with nobody behind it would just
    // bounce straight back to manual.
    if (alive.has(s.id)) tr.addEventListener('click', () => setSpecFollow('p:' + s.id));
    rows.appendChild(tr);
  }
  el.specBoardEmpty.classList.toggle('hidden', stats.length > 0);
}

/** Enter spectator mode. The view depends on whether there is an account. */
function startSpectating() {
  if (state.spectator) return;
  closePopups();
  const mode = state.me ? 'player' : 'public';
  el.specMode.value = mode;
  syncSpecPanel();
  requestSpectate({ mode });
}

function stopSpectating() {
  socket.emit('unspectate');
  state.spectator = false;
  state.keys.clear();
  el.spec.classList.add('hidden');
  el.specPanel.classList.add('hidden');
  // an anonymous watcher has nowhere else to go back to
  if (state.me) {
    el.game.classList.remove('hidden');
    el.cv.classList.remove('hidden');
  } else {
    el.login.classList.remove('hidden');
  }
  resize();
}

function toggleSpectating() {
  if (tutorialOpen()) return;
  if (state.spectator) stopSpectating();
  else startSpectating();
}

// Both spectator buttons toggle, so pressing the one you pressed to get in
// takes you back out again.
document.getElementById('spectateBtn').addEventListener('click', () => toggleSpectating());
document.getElementById('specLoginBtn').addEventListener('click', () => toggleSpectating());

// Picking a mode switches the view at once. Picking Admin reveals the secret
// box (and reuses one the server already accepted); a refused remembered secret
// clears the box so it can be typed again.
el.specMode.addEventListener('change', onSpecModeChange);
el.specSecret.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') requestSpectate(specRequestFromPanel());
});
// Re-send the admin frame when its own options change, but only while it is the
// view on show - there is no Apply button to do it by hand.
const applyAdminOpts = () => {
  if (el.specMode.value === 'admin') requestSpectate(specRequestFromPanel());
};
el.specAggregate.addEventListener('change', applyAdminOpts);
el.specMargin.addEventListener('change', applyAdminOpts);

// The follow dropdown hands the camera to manual, to the deepest player, or to
// a named one. WASD takes it back to manual.
el.specFollow.addEventListener('change', () => setSpecFollow(el.specFollow.value));

document.getElementById('backBtn').addEventListener('click', stopSpectating);

function toggleMenu() {
  if (!state.me) return;
  togglePanel('profile');
}

document.getElementById('menuBtn').addEventListener('click', toggleMenu);
document.getElementById('closeProfile').addEventListener('click', hideProfile);
// The on-screen button is a toggle, like every other panel button. It used to
// only ever open the dialog, so the one key that always worked was Esc.
document.getElementById('rulesBtn').addEventListener('click', () => togglePanel('tutorial'));
document.getElementById('tutBack').addEventListener('click', tutorialBack);
document.getElementById('tutNext').addEventListener('click', tutorialNext);
document.getElementById('tutSkip').addEventListener('click', hideRules);

for (const b of document.querySelectorAll('#actions button')) {
  b.addEventListener('click', () => sendAction(b.dataset.act));
}

// ================= emotes =================

// The popup's buttons, and the glyph the bubble above a head draws. Kept in one
// list so the button and the bubble can never disagree about an emote.
const EMOTE_LIST = [
  { id: 'wave', glyph: '👋', label: 'Wave' },
  { id: 'smile', glyph: '🙂', label: 'Smile' },
  { id: 'shout', glyph: '💢', label: 'Shout' },
  { id: 'oops', glyph: '😳', label: 'Oops' },
  { id: 'thumbsup', glyph: '👍', label: 'Thumbs up' },
];

function emoteGlyph(id) {
  const found = EMOTE_LIST.find((e) => e.id === id);
  return found ? found.glyph : '😊';
}

/** Fill the popup once: the buttons never change, only the panel shows. */
function buildEmotePicker() {
  el.emoteList.replaceChildren();
  for (const em of EMOTE_LIST) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.emote = em.id;
    b.title = em.label;
    b.textContent = em.glyph;
    // Picking one sends it and gets out of the way, so the bubble is not hidden
    // behind the panel the reader just clicked.
    b.addEventListener('click', () => { sendEmote(em.id); hideEmotes(); });
    el.emoteList.appendChild(b);
  }
}
buildEmotePicker();

function showEmotes() {
  if (!state.me || state.halted) return;
  el.emotePanel.classList.remove('hidden');
}

function hideEmotes() {
  el.emotePanel.classList.add('hidden');
}

function toggleEmotes() {
  togglePanel('emotes');
}

document.getElementById('emoteBtn').addEventListener('click', toggleEmotes);
document.getElementById('closeEmote').addEventListener('click', hideEmotes);

// ================= tutorial =================

/**
 * The block alphabet, one legend row per block type. The page grids below use
 * these exact characters, and the swatches use the same colours the canvas
 * does, so a legend and the field cannot drift apart.
 */
const BLOCKS = {
  sky: { ch: '~', name: 'Sky', cls: 'sky', note: 'above the surface; you cannot dig it' },
  surface: { ch: '=', name: 'Surface', cls: 'surface', note: 'plain dirt with grass on top; never stone or spikes' },
  dirt: { ch: '#', name: 'Dirt', cls: 'dirt', note: 'walk into it to start digging; the dig clears itself and you step down' },
  stone: { ch: 'S', name: 'Stone', cls: 'stone', note: 'cannot be dug, but a dynamite blast clears it' },
  spikes: { ch: '^', name: 'Spikes', cls: 'spikes', note: 'drains your health; armour soaks the strike first' },
  dug: { ch: 'o', name: 'Dug out', cls: 'dug', note: 'cleared by a dig or a blast; walk freely, no timer' },
  loot: { ch: 'd', name: 'Dirt with loot', cls: 'dirt item', note: 'the item is waiting where it is drawn' },
  item: { ch: '*', name: 'Item', cls: 'item', note: 'armour, golden shovel, dynamite or a bear trap' },
  bedrock: { ch: 'X', name: 'Bedrock', cls: 'bedrock', note: 'unbreakable gate bands, each with a single gap' },
  boss: { ch: '@', name: 'Boss', cls: 'boss', note: 'dig into it to fight; win a weapon' },
  unknown: { ch: '?', name: 'Unknown', cls: 'unknown', note: 'nobody has looked there yet' },
};

/**
 * The tutorial, one essential idea per page. Each page carries a small slice of
 * the field (drawn with the same block alphabet as the game) and a legend that
 * names only the blocks it introduces, so a page can be read on its own.
 */
const TUTORIAL_PAGES = [
  {
    title: 'Welcome to the pit',
    html: 'Everybody starts on the surface of one shared pit. Dig down, mind the spikes, and try to finish deepest. Death only sends you back to the top - your best depth is kept.',
    grid: [
      '~~~~~~~~~~',
      '==========',
      '##########',
      '##########',
    ],
    legend: ['sky', 'surface', 'dirt'],
  },
  {
    title: 'Moving and digging',
    html: 'Arrows or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move you one cell. You only ever stand in empty cells, so walking a tunnel is instant and starts no timer. Walking into dirt starts a dig; the block clears itself and you step down into it. Pressing the same direction again while digging does nothing, so you cannot restart your own timer by accident.',
    grid: [
      '##########',
      '#o########',
      '#o########',
      '#o########',
    ],
    legend: ['dirt', 'dug'],
  },
  {
    title: 'Stone and spikes',
    html: 'Stone cannot be dug - go round it, or clear it with <em>dynamite</em>. Spikes cost you health: <em>armour</em> soaks the strike first and only what is left over comes off your bar, but you end up standing on them, so stepping off and back on costs you again. If your health runs out you die. Caught on spikes, dig sideways - the dig will still finish.',
    grid: [
      '#S#^#####',
      '#o#o#####',
      '#S#o#####',
      '#S#^#####',
    ],
    legend: ['stone', 'spikes'],
  },
  {
    title: 'Reading the field',
    html: 'Every cell you discover is remembered, even after you move away. Cells nobody has looked into stay flat grey, and cells that have been dug read as dark tunnels. This is the whole alphabet.',
    grid: [
      '~~~~~~~~~~',
      '==========',
      '#S#^#d#o#S',
      '#d#*#^#o#d',
      '#X#@#S#?#o',
      '##########',
    ],
    legend: ['sky', 'surface', 'dirt', 'stone', 'spikes', 'dug', 'loot', 'item', 'bedrock', 'boss', 'unknown'],
  },
  {
    title: 'Loot in the dirt',
    html: 'Some dirt blocks hold an item, drawn on the block itself so you can judge a dig before you start it. Once an item is taken it is gone for everyone, and a resync never draws it back. <em>Armour</em> is banked as points that soak spikes and boss blows, a <em>golden shovel</em> digs faster for a minute, a <em>potion</em> mends health, and there is dynamite and the bear trap.',
    grid: [
      '#d#*#d####',
      '#o#o#o####',
      '#d#d#d####',
      '##########',
    ],
    legend: ['loot', 'item'],
  },
  {
    title: 'Health and potions',
    html: 'You have one bar of health, shown in the corner, and it stays with you as you dig and as you fight. A <em>potion</em> mends it: press <kbd>I</kbd> and use one from your pack here on the field, or drink it in a fight. A full bar wastes nothing - the potion is kept for later.',
    grid: [
      '#####',
      '#^#o#',
      '#o#*#',
      '#o#o#',
      '#####',
    ],
    legend: ['spikes', 'dug', 'item'],
  },
  {
    title: 'Dynamite and traps',
    html: '<kbd>Q</kbd> blows dynamite: it clears the eight cells around you <em>and the one you are standing on</em>, so it frees you even from spikes. <kbd>E</kbd> sets a bear trap under your feet - secret to everybody else, and whoever walks into it is stuck for a minute. The on-screen buttons do the same.',
    grid: [
      '#####',
      '#ooo#',
      '#ooo#',
      '#ooo#',
      '#####',
    ],
    legend: ['dug'],
  },
  {
    title: 'Gates and bosses',
    html: 'Every so often a band of bedrock crosses the pit, solid except for a single gap, and a boss waits in that gap. Smaller minibosses lurk in the levels between the gates. Dig into a boss to begin the fight; it blocks the only way down until it is beaten.',
    grid: [
      'XXXXXXXXXX',
      'XXXX@XXXXX',
      '#S###d##S#',
      '##########',
    ],
    legend: ['bedrock', 'boss'],
  },
  {
    title: 'Fights and weapons',
    html: 'A fight is turn-based: on your turn you can Attack, Defend, use an Item, or a Skill from your weapon. The field is frozen until it ends, and the health and armour you carried in fight with you - armour is spent first, and whatever health and armour are left come back when the fight is over. Weapons are only won from fights, never dug from the dirt; press <kbd>I</kbd> to pick which one to carry.',
    weapons: true,
    grid: [
      '#####',
      '#ooo#',
      '#o@o#',
      '#ooo#',
      '#####',
    ],
    legend: ['boss', 'dug'],
  },
  {
    title: 'Watching, score and your code',
    html: '<kbd>V</kbd> switches to spectator mode, even before you log in. Depth is how far below the spawn row you are, and your best depth is the number other players are measured by. Your code, shown in the menu, brings back your stats and everything you have dug - enter it next time to keep your place.',
    grid: [
      '??????????',
      '#o#S#^#o##',
      '##########',
    ],
    legend: ['unknown', 'dug'],
  },
];

/** The weapons page's bullet list, built from the display mirror so it stays
 *  in step with the tooltip numbers the inventory shows. */
function buildWeaponList() {
  const list = document.createElement('ul');
  list.className = 'ruleWeapons';
  for (const id of Object.keys(WEAPONS)) {
    const w = WEAPONS[id];
    // bare hands are not won from a fight, so they are not on the loot page
    if (id === 'bare') continue;
    const li = document.createElement('li');
    const glyph = document.createElement('span');
    glyph.className = 'wg';
    glyph.textContent = w.glyph;
    const name = document.createElement('b');
    name.textContent = w.name;
    const stats = document.createElement('span');
    stats.className = 'wstats';
    stats.textContent = `dmg ${w.damage} · hit ${Math.round(w.hit * 100)}% · crit ${Math.round(w.crit * 100)}%`;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = ` - ${w.desc}`;
    li.append(glyph, name, stats, note);
    if (w.skill) {
      const skill = document.createElement('span');
      skill.className = 'note wskill';
      skill.textContent = `${w.skill.name}: spend a turn to strike for ${w.skill.mult}x base damage.`;
      li.appendChild(skill);
    }
    list.appendChild(li);
  }
  return list;
}

/** Draw one tutorial page into the dialog, footer included. */
function renderTutorialPage() {
  const page = TUTORIAL_PAGES[state.tutPage];
  el.rulesBody.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = page.title;
  const text = document.createElement('p');
  text.innerHTML = page.html;
  el.rulesBody.append(heading, text);

  if (page.weapons) el.rulesBody.appendChild(buildWeaponList());

  if (page.grid) {
    const grid = document.createElement('pre');
    grid.className = 'ruleGrid';
    grid.textContent = page.grid.join('\n');
    el.rulesBody.appendChild(grid);
  }

  if (page.legend) {
    const legend = document.createElement('ul');
    legend.className = 'ruleLegend';
    for (const key of page.legend) {
      const item = BLOCKS[key];
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = `swatch sw-${item.cls}`;
      sw.textContent = item.ch;
      const label = document.createElement('b');
      label.textContent = item.name;
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = ` - ${item.note}`;
      li.append(sw, label, note);
      legend.appendChild(li);
    }
    el.rulesBody.appendChild(legend);
  }

  const last = state.tutPage === TUTORIAL_PAGES.length - 1;
  el.tutPage.textContent = `Page ${state.tutPage + 1} of ${TUTORIAL_PAGES.length}`;
  el.tutBack.disabled = state.tutPage === 0;
  el.tutSkip.classList.toggle('hidden', last);
  el.tutNext.textContent = last ? 'Got it' : 'Next';
}
renderTutorialPage();

/**
 * Show the tutorial, always from the first page. Closing it is what tells the
 * server it has been read, so the dialog opens by itself exactly once per
 * account rather than once per visit.
 */
function showRules() {
  state.tutPage = 0;
  renderTutorialPage();
  el.rules.classList.remove('hidden');
  state.rulesShown = true;
  if (el.topControls) el.topControls.classList.toggle('locked', true);
}

/** Turn the page; on the last page Next finishes, the same as Got it. */
function tutorialNext() {
  if (state.tutPage >= TUTORIAL_PAGES.length - 1) { hideRules(); return; }
  state.tutPage += 1;
  renderTutorialPage();
}

function tutorialBack() {
  if (state.tutPage === 0) return;
  state.tutPage -= 1;
  renderTutorialPage();
}

function hideRules() {
  el.rules.classList.add('hidden');
  if (el.topControls) el.topControls.classList.toggle('locked', false);
  // The rules were read by an account, which may not have spawned yet: a player
  // still choosing a class has a code but no player object.
  if ((state.me || state.code) && state.rulesShown) {
    state.rulesShown = false;
    socket.emit('rulesSeen');
  }
  // A brand new account reads the rules first, and only then picks a class.
  if (state.pendingClass) showClassChoose();
}

/** The windows behind the top-right buttons are mutually exclusive. */
function tutorialOpen() {
  return !el.rules.classList.contains('hidden');
}

function showProfile() {
  if (!state.me) return;
  el.profile.classList.remove('hidden');
}
function hideProfile() {
  el.profile.classList.add('hidden');
}

const POPUP = {
  tutorial: {
    isOpen: tutorialOpen,
    close: hideRules,
    open: showRules,
  },
  emotes: {
    isOpen: () => !el.emotePanel.classList.contains('hidden'),
    close: hideEmotes,
    open: showEmotes,
  },
  inventory: {
    isOpen: () => !el.inventoryPanel.classList.contains('hidden'),
    close: hideInventory,
    open: showInventory,
  },
  profile: {
    isOpen: () => !el.profile.classList.contains('hidden'),
    close: hideProfile,
    open: showProfile,
  },
};

function closePopups() {
  for (const p of Object.values(POPUP)) if (p.isOpen()) p.close();
}

function openPanel(name) {
  const p = POPUP[name];
  if (!p) return;
  if (name !== 'tutorial' && tutorialOpen()) return;
  // Spectator mode is one more surface in the same exclusive set: opening a
  // panel leaves the view first, and the panel then opens over the field.
  if (state.spectator) stopSpectating();
  for (const [key, pp] of Object.entries(POPUP)) {
    if (key !== name && pp.isOpen()) pp.close();
  }
  p.open();
}

function togglePanel(name) {
  const p = POPUP[name];
  if (!p) return;
  if (p.isOpen()) { p.close(); return; }
  openPanel(name);
}

// ================= input =================

// Scoped to the game view, and it never blocks typing: a keypress while the
// login form or a text field has focus is left alone (BUGS: "the keydown
// handler preventsDefault's on everything, so you cannot type your name").
const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
  q: 'useDynamite', Q: 'useDynamite',
  e: 'placeTrap', E: 'placeTrap',
};

/** Panel shortcuts, checked before the movement table because none of them are
 *  movement keys and Esc has to work no matter what else it would have meant. */
const SHORTCUTS = {
  v: 'spectator', V: 'spectator',
  m: 'menu', M: 'menu',
  p: 'emotes', P: 'emotes',
  i: 'inventory', I: 'inventory',
};

/**
 * Esc closes the topmost thing on screen, and only that. The tutorial first,
 * then the menu, then spectator mode: a dialog opened on top of a panel is the
 * one the reader meant to dismiss.
 * @returns {boolean} whether something was actually closed
 */
function closeTopmost() {
  if (!el.rules.classList.contains('hidden')) { hideRules(); return true; }
  if (!el.emotePanel.classList.contains('hidden')) { hideEmotes(); return true; }
  if (!el.inventoryPanel.classList.contains('hidden')) { hideInventory(); return true; }
  if (state.battleTarget) { cancelTarget(); return true; }
  if (!el.battleItemMenu.classList.contains('hidden')) { hideItemMenu(); return true; }
  if (!el.battleSkillMenu.classList.contains('hidden')) { hideSkillMenu(); return true; }
  if (state.battleInvite) { hideInvite(); return true; }
  if (!el.profile.classList.contains('hidden')) { el.profile.classList.add('hidden'); return true; }
  if (state.spectator) { stopSpectating(); return true; }
  return false;
}

function typingInAField(t) {
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}

// The physical key, not the layout's character: WASD and every shortcut must
// read the same on a Russian, Greek or AZERTY keyboard (BUGS: "WASD movement
// keys work only in English"). `e.code` names the physical position regardless
// of layout; `e.key` is the fallback for any key `code` cannot name, and for
// stubs that set only `key`.
const CODE_KEYS = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e',
  KeyV: 'v', KeyM: 'm', KeyP: 'p', KeyI: 'i',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Space: ' ', Enter: 'Enter', Escape: 'Escape',
};
function keyOf(e) {
  return CODE_KEYS[e.code] || e.key;
}

// ---- input ----
// Scoped to the game view, and it never blocks typing: a keypress while the
// login form or a text field has focus is left alone (BUGS: "the keydown
// handler preventsDefault's on everything, so you cannot type your name").
window.addEventListener('keydown', (e) => {
  if (state.halted) return;
  if (typingInAField(e.target)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const key = keyOf(e);
  if (key === 'Escape') {
    // nothing open? leave the key to the browser, which uses it to leave full
    // screen and to cancel things
    if (closeTopmost()) e.preventDefault();
    return;
  }

  const shortcut = SHORTCUTS[key];
  if (shortcut) {
    e.preventDefault();
    // holding V down must not flicker between the two views
    if (!e.repeat) {
      if (shortcut === 'menu') togglePanel('profile');
      else if (shortcut === 'emotes') togglePanel('emotes');
      else if (shortcut === 'inventory') togglePanel('inventory');
      else toggleSpectating();
    }
    return;
  }

  // Locked in a fight: the field verbs are frozen, so the canvas does not move
  // and nothing is sent. While a healing item is being aimed the arrows walk the
  // cursor and Enter throws it; otherwise Space/Enter is the Action verb.
  if (state.battle) {
    e.preventDefault();
    if (state.battleTarget) {
      if (key === 'ArrowLeft' || key === 'a') cycleTarget(-1);
      else if (key === 'ArrowRight' || key === 'd') cycleTarget(1);
      else if (key === ' ' || key === 'Enter') confirmTarget();
      return;
    }
    if ((key === ' ' || key === 'Enter') && state.battle.isMyTurn && state.battle.phase === 'active') {
      sendBattle('attack');
    }
    return;
  }

  const dir = KEYS[key];
  if (!dir) return;

  // Spectating: the arrow keys and WASD drive the camera over the field instead
  // of moving a character (BUGS v0.3.0). Q and E are ignored here, so a
  // spectating player cannot dig or place traps from the spectator view.
  // Checked before state.me, because a socket may spectate without playing.
  if (state.spectator) {
    if (dir === 'useDynamite' || dir === 'placeTrap') return;
    e.preventDefault();
    if (state.specCam.mode !== 'manual') {
      state.specCam.mode = 'manual';
      state.specCam.target = null;
      syncSpecFollow();
    }
    state.keys.add(dir);
    return;
  }

  // Not logged in yet: the login form owns the keyboard, including the letters
  // that would otherwise be movement keys.
  if (!state.me) return;

  // only swallow the keys we actually use, and only arrows and letters
  e.preventDefault();
  if (dir === 'useDynamite') sendAction('useDynamite');
  else if (dir === 'placeTrap') sendAction('placeTrap');
  else sendAction('move', dir);
});

// Held keys need a matching release, or the camera walks away on its own.
window.addEventListener('keyup', (e) => {
  const dir = KEYS[keyOf(e)];
  if (dir) state.keys.delete(dir);
});
// Releasing focus mid-keypress would otherwise leave a key stuck down.
window.addEventListener('blur', () => state.keys.clear());

// ================= hud =================

function setStatus() {
  const bits = [];
  if (!state.connected) bits.push('offline');
  if (state.me && !state.me.alive) bits.push('DEAD');
  const stuck = state.me ? Math.max(0, Math.ceil((state.me.stuckUntil - now()) / 1000)) : 0;
  if (stuck > 0) bits.push(`STUCK ${stuck}s`);
  el.status.textContent = bits.join(' · ');
  el.status.className = !state.connected ? 'bad' : '';
}

function updateHud() {
  if (!state.me) return;
  const m = state.me;
  // The field health bar: the same pool a fight draws on, painted the same red,
  // with the armour points it would spend first shown beside the numbers.
  const maxHp = m.maxHp || 0;
  const hp = Math.max(0, Math.min(m.hp || 0, maxHp));
  el.healthFill.style.width = (maxHp > 0 ? (hp / maxHp) * 100 : 0) + '%';
  el.healthText.textContent = maxHp > 0
    ? `${hp} / ${maxHp}` + (m.armor > 0 ? `   🛡 ${m.armor}` : '')
    : '';
  const inv = [`🛡 ${m.armor}`, `💣 ${m.dynamite}`, `🪤 ${m.trap}`, `🧪 ${m.potion || 0}`];
  const w = WEAPONS[m.weapon];
  // bare hands are always equipped and are the absence of a weapon, so they do
  // not clutter the HUD
  if (w && w.id !== 'bare') inv.push(`${w.glyph} ${w.name}`);
  const shovel = Math.max(0, Math.ceil((m.shovelUntil - now()) / 1000));
  if (shovel > 0) inv.push(`⛏ ${shovel}s`);
  el.inventory.textContent = inv.join('   ');
  setStatus();

  const depth = m.maxDepth || 0;
  const parts = [`depth ${depth}`];
  if (m.alive && m.digging) parts.push('digging…');
  el.stats.textContent = parts.join('  ·  ');
  updateProfile();
  // keep an open inventory panel in step with the snapshot
  if (!el.inventoryPanel.classList.contains('hidden')) renderInventory();
}

function updateProfile() {
  if (!state.stats) return;
  el.pMaxDepth.textContent = state.stats.maxDepth;
  el.pDeaths.textContent = state.stats.deaths;
  el.pItems.textContent = state.stats.itemsCollected;
  el.pRuns.textContent = state.stats.runsPlayed;
}

function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function addEffect(kind, x, y) {
  if (x == null || y == null) return;
  state.effects.push({ kind, x, y, until: Date.now() + (kind === 'boom' ? 700 : 400) });
  if (state.effects.length > 40) state.effects.splice(0, state.effects.length - 40);
}

// ================= rendering =================

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  el.cv.width = w; el.cv.height = h;
  specCv.width = w; specCv.height = h;
}
window.addEventListener('resize', resize);
resize();

const COLORS = {
  dirt: '#8b5a2b',
  grass: '#4a8a2c',
  stone: '#8a8a8a',
  spikes: '#c8c8c8',
  bedrock: '#1b1b22',
  boss: '#c62828',
  // a cell nobody has discovered: flat grey, so the pit reads as solid rock you
  // simply have not looked into yet
  unknown: '#333',
  // a cell that has been dug out or blown clear: the same dirt, taken right
  // down, so an excavated tunnel is obviously not a blank hole
  dug: '#2b1c10',
};

/**
 * One block.
 *
 * `y >= surfaceY` is what separates "dug" from "sky": both are type 'air', but
 * the air above the surface was never anything and must keep showing sky,
 * while air below it is a hole somebody made.
 */
function drawBlock(c, sx, sy, type, item, y, surfaceY) {
  if (type == null) return;
  const isSurface = y === surfaceY && type === 'dirt';

  if (type === 'air') {
    if (y < surfaceY) return; // sky: the background is the sky
    c.fillStyle = COLORS.dug;
    c.fillRect(sx, sy, TILE, TILE);
    c.fillStyle = 'rgba(0,0,0,0.3)';
    for (let i = 0; i < 4; i++) c.fillRect(sx + (i * 7) % TILE, sy + (i * 11) % TILE, 3, 3);
  } else {
    c.fillStyle = isSurface ? '#6b4a2a' : COLORS[type] || COLORS.unknown;
    c.fillRect(sx, sy, TILE, TILE);

    if (type === 'dirt') {
      c.fillStyle = 'rgba(0,0,0,0.15)';
      for (let i = 0; i < 4; i++) c.fillRect(sx + (i * 7) % TILE, sy + (i * 11) % TILE, 3, 3);
    } else if (type === 'stone') {
      c.strokeStyle = 'rgba(0,0,0,0.3)';
      c.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
    } else if (type === 'spikes') {
      c.fillStyle = '#333';
      for (let i = 0; i < 4; i++) {
        const px = sx + i * 8 + 2;
        c.beginPath();
        c.moveTo(px, sy + TILE);
        c.lineTo(px + 4, sy + 6);
        c.lineTo(px + 8, sy + TILE);
        c.fill();
      }
    } else if (type === 'bedrock') {
      c.fillStyle = 'rgba(255,255,255,0.08)';
      for (let i = 0; i < 4; i++) c.fillRect(sx + (i * 9) % TILE, sy + (i * 13) % TILE, 4, 4);
    } else if (type === 'boss') {
      // A boss is a battle, not a death: a red tile with two crossed swords,
      // drawn as paths rather than a glyph so it renders the same everywhere.
      c.fillStyle = COLORS.boss;
      c.fillRect(sx, sy, TILE, TILE);
      c.save();
      c.strokeStyle = '#3a0d0d';
      c.lineWidth = 3 * (TILE / 32);
      c.beginPath();
      c.moveTo(sx + 5 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 11 * (TILE / 32), sy + 21 * (TILE / 32));
      c.moveTo(sx + 27 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 21 * (TILE / 32), sy + 21 * (TILE / 32));
      c.stroke();
      c.strokeStyle = '#f5f5f5';
      c.lineWidth = 2.5 * (TILE / 32);
      c.beginPath();
      c.moveTo(sx + 5 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 27 * (TILE / 32), sy + 5 * (TILE / 32));
      c.moveTo(sx + 27 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 5 * (TILE / 32), sy + 5 * (TILE / 32));
      c.stroke();
      c.lineWidth = 2 * (TILE / 32);
      c.beginPath();
      c.moveTo(sx + 7 * (TILE / 32), sy + 18 * (TILE / 32));
      c.lineTo(sx + 14 * (TILE / 32), sy + 25 * (TILE / 32));
      c.moveTo(sx + 25 * (TILE / 32), sy + 18 * (TILE / 32));
      c.lineTo(sx + 18 * (TILE / 32), sy + 25 * (TILE / 32));
      c.stroke();
      c.restore();
    }
  }

  if (isSurface) {
    // grass on top of the surface row
    c.fillStyle = COLORS.grass;
    c.fillRect(sx, sy, TILE, 6);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(sx, sy, TILE, 2);
  }

  if (item) {
    c.fillStyle = '#ff0';
    c.font = '16px sans-serif';
    c.textAlign = 'center';
    c.fillText((ITEM[item] || {}).sym || '?', sx + TILE / 2, sy + TILE / 2 + 6);
  }
}

/** A cell that is inside the world but that nobody has discovered. */
function drawUnknown(c, sx, sy) {
  c.fillStyle = COLORS.unknown;
  c.fillRect(sx, sy, TILE, TILE);
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.lineWidth = 1;
  c.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
}

function drawFlash(c, sx, sy) {
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 2;
  c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
}

function drawPlayer(c, p, sx, sy) {
  if (!p.alive) {
    c.fillStyle = 'rgba(120,120,120,0.5)';
    c.fillRect(sx + 4, sy + 8, TILE - 8, TILE - 10);
    return;
  }
  // The class sprite is pre-rendered at tile size, so drawing a player is one
  // blit; all the per-class detail lives in HERO_FIELD.
  const sprite = fieldSprite(p.model);
  c.drawImage(sprite, sx + (TILE - sprite.width) / 2, sy + (TILE - sprite.height) / 2);
  // Being impaled: the model is in the spikes and about to stop existing, so it
  // is drawn sunk into them rather than standing on top of them.
  if (p.dying) {
    c.fillStyle = 'rgba(200,60,60,0.55)';
    c.fillRect(sx + 2, sy + TILE - 8, TILE - 4, 8);
  }
  if (p.stuck) {
    c.strokeStyle = '#f44';
    c.lineWidth = 2;
    c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
  }
  // Emote bubble above the player name
  const nowT = now();
  if (p.emote && p.emote.until > nowT) {
    c.font = '20px sans-serif';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,0.7)';
    const w = 24, h = 24;
    c.fillRect(sx + TILE / 2 - w / 2, sy - 36, w, h);
    c.fillStyle = '#fff';
    c.fillText(emoteGlyph(p.emote.id), sx + TILE / 2, sy - 36 + 18);
  }
  c.font = '12px sans-serif';
  c.textAlign = 'center';
  c.strokeStyle = '#000';
  c.lineWidth = 3;
  c.strokeText(p.name, sx + TILE / 2, sy - 4);
  c.fillStyle = '#fff';
  c.fillText(p.name, sx + TILE / 2, sy - 4);
}

function drawDigBar(c, sx, sy, dig) {
  const progress = Math.max(0, Math.min(1, (now() - dig.startedAt) / dig.duration));
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fillRect(sx, sy, TILE, TILE);
  c.fillStyle = 'rgba(255,220,80,0.5)';
  c.fillRect(sx, sy + TILE * (1 - progress), TILE, TILE * progress);
  c.strokeStyle = '#ffd050';
  c.lineWidth = 2;
  c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
}

function drawEffect(c, e, cx, cy) {
  const t = 1 - (e.until - Date.now()) / (e.kind === 'boom' ? 700 : 400);
  const sx = e.x * TILE - cx, sy = e.y * TILE - cy;
  if (e.kind === 'boom') {
    c.fillStyle = `rgba(255,${180 - t * 160},0,${0.7 * (1 - t)})`;
    c.beginPath();
    c.arc(sx + TILE / 2, sy + TILE / 2, (4 + t * 40), 0, Math.PI * 2);
    c.fill();
  } else {
    c.strokeStyle = `rgba(255,80,80,${1 - t})`;
    c.lineWidth = 3;
    c.strokeRect(sx + 4, sy + 4, TILE - 8, TILE - 8);
  }
}

function background(c, W, H) {
  const grd = c.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#87ceeb');
  grd.addColorStop(0.35, '#5a5a5a');
  grd.addColorStop(1, '#1a1a1a');
  c.fillStyle = grd;
  c.fillRect(0, 0, W, H);
}

function renderGame(dt) {
  const W = el.cv.width, H = el.cv.height;
  background(ctx, W, H);
  if (!state.me) return;

  // Interpolate towards the authoritative position. This is presentation only:
  // a dropped frame or a slow packet makes it smoother, never wrong, and a
  // teleport-sized jump snaps instead of sliding.
  const tx = state.me.x, ty = state.me.y;
  const k = state.snap ? 1 : Math.min(1, dt / 60);
  state.drawMe.x += (tx - state.drawMe.x) * k;
  state.drawMe.y += (ty - state.drawMe.y) * k;
  state.snap = false;
  const cx = state.drawMe.x * TILE - W / 2 + TILE / 2;
  const cy = state.drawMe.y * TILE - H / 2 + TILE / 2;

  const x0 = Math.floor(cx / TILE) - 1, y0 = Math.floor(cy / TILE) - 1;
  const x1 = Math.ceil((cx + W) / TILE) + 1, y1 = Math.ceil((cy + H) / TILE) + 1;
  const t = now();

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sx = x * TILE - cx, sy = y * TILE - cy;
      if (x < 0 || x >= state.width) {
        ctx.fillStyle = '#000';
        ctx.fillRect(sx, sy, TILE, TILE);
        continue;
      }
      const b = state.blocks[x + ',' + y];
      if (b) drawBlock(ctx, sx, sy, b.type, b.item, y, state.surfaceY);
      else if (y >= state.surfaceY) drawUnknown(ctx, sx, sy);
      // above the surface an unknown cell is still sky
      const f = state.flashes[x + ',' + y];
      if (f && f > t) drawFlash(ctx, sx, sy);
    }
  }
  for (const k2 of Object.keys(state.flashes)) if (state.flashes[k2] < t) delete state.flashes[k2];

  // Our own bear traps. Nobody else can see these, so this is the only place
  // they appear in the game view (BUGS v0.3.0). Drawn under the players.
  ctx.fillStyle = 'rgba(255,60,60,0.4)';
  ctx.strokeStyle = 'rgba(255,80,80,0.9)';
  ctx.lineWidth = 2;
  for (const tr of state.myTraps) {
    const tx = tr.x * TILE - cx + 4, ty = tr.y * TILE - cy + 4;
    ctx.fillRect(tx, ty, TILE - 8, TILE - 8);
    ctx.strokeRect(tx, ty, TILE - 8, TILE - 8);
  }

  if (state.dig) {
    const sx = state.dig.x * TILE - cx, sy = state.dig.y * TILE - cy;
    drawDigBar(ctx, sx, sy, state.dig);
  }

  // Loot left on the ground by a defeated boss. Drawn with the item glyph, so
  // it reads as something to walk over and pick up.
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  for (const g of state.loot) {
    const lx = g.x * TILE - cx + TILE / 2, ly = g.y * TILE - cy + TILE / 2;
    if (lx < -TILE || lx > W + TILE || ly < -TILE || ly > H + TILE) continue;
    const meta = g.type === 'weapon' ? (WEAPONS[g.id] || {}) : (ITEM[g.id] || {});
    ctx.fillStyle = '#000';
    ctx.fillRect(g.x * TILE - cx + 6, g.y * TILE - cy + 6, TILE - 12, TILE - 12);
    ctx.fillStyle = '#ffd54f';
    ctx.fillText(meta.glyph || meta.sym || '?', lx, ly + 6);
  }

  for (const p of state.players) {
    if (!state.me || p.id === state.me.id) continue;
    const sx = p.x * TILE - cx, sy = p.y * TILE - cy;
    if (sx < -TILE || sx > W + TILE || sy < -TILE || sy > H + TILE) continue;
    drawPlayer(ctx, p, sx, sy);
  }

  // ourselves last, so we are never hidden behind someone else. Forced alive:
  // we are drawn as the live player until the respawn actually lands, which is
  // what makes the step into the spikes and the death two separate moments.
  drawPlayer(ctx, {
    ...state.me,
    alive: true,
    stuck: state.me.stuckUntil > t,
    dying: state.me.dyingAt > t,
  }, state.drawMe.x * TILE - cx, state.drawMe.y * TILE - cy);

  state.effects = state.effects.filter((e) => e.until > Date.now());
  for (const e of state.effects) drawEffect(ctx, e, cx, cy);
}

const SPEC_SPEED = 9;      // blocks per second
const SPEC_MIN_Y = -6;     // a couple of rows of sky above the surface

/** How deep anybody has dug, so the camera can stop at the bottom of the pit. */
function specDeepestY() {
  let m = state.spec.surfaceY;
  for (const p of state.spec.players) if (p.alive) m = Math.max(m, p.y);
  for (const d of state.spec.digs) m = Math.max(m, d.y);
  // the server says how far down this view is allowed to show, which is the
  // bottom of what it sent plus wherever the action currently is
  m = Math.max(m, state.spec.maxY || 0);
  // discovered cells only go as deep as the deepest dig, but be safe and use
  // whatever the world itself has opened up
  m = Math.max(m, state.spec.deepestY || 0);
  return m;
}

function clampSpecCam() {
  const c = state.specCam;
  const maxX = Math.max(0, state.spec.width - 1);
  const maxY = specDeepestY() + 2;
  c.x = Math.min(maxX, Math.max(0, c.x));
  c.y = Math.min(maxY, Math.max(SPEC_MIN_Y, c.y));
}

function moveSpecCam(dt) {
  const c = state.specCam;
  const k = state.keys;
  // diagonals are faster, same as a normal 8-way walk
  const dx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
  const dy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
  if (!dx && !dy) return false;
  c.mode = 'manual';   // taking the wheel ends whatever was being followed
  c.target = null;
  const len = Math.hypot(dx, dy) || 1;
  const step = SPEC_SPEED * (dt / 1000);
  c.x += (dx / len) * step;
  c.y += (dy / len) * step;
  clampSpecCam();
  return true;
}

/**
 * Put the camera where the chosen follow mode wants it this frame. The server
 * only sends players who are still on the field, so a missing target means the
 * watched player logged off: the camera drops back to manual rather than
 * parking on stale ground. `deepest` follows the deepest living player and,
 * while everyone is dead, holds the last player it watched if they are still
 * listed; it only gives up (to manual) when the pit is empty.
 * @returns {boolean} whether the camera was moved
 */
function resolveFollow() {
  const c = state.specCam;
  const players = state.spec.players;

  if (c.mode === 'player') {
    const t = players.find((p) => p.id === c.target);
    if (!t) {
      c.mode = 'manual';
      c.target = null;
      return false;
    }
    c.x = t.x;
    c.y = t.y;
    return true;
  }

  if (c.mode === 'deepest') {
    if (players.length === 0) {
      c.mode = 'manual';
      return false;
    }
    // the deepest one still alive, or the last one watched while nobody is
    let deep = null;
    for (const p of players) if (p.alive && (!deep || p.y > deep.y)) deep = p;
    if (!deep) deep = players.find((p) => p.id === c.target) || null;
    if (!deep) for (const p of players) if (!deep || p.y > deep.y) deep = p;
    c.target = deep.id;
    c.x = deep.x;
    c.y = deep.y;
    return true;
  }

  return false;
}

function renderSpectator(dt) {
  const c = specCtx, W = specCv.width, H = specCv.height;
  background(c, W, H);
  const ps = state.spec.players;

  moveSpecCam(dt || 16);
  resolveFollow();
  clampSpecCam();

  const cx = state.specCam.x * TILE - W / 2, cy = state.specCam.y * TILE - H / 2;

  const x0 = Math.floor(cx / TILE) - 1, y0 = Math.floor(cy / TILE) - 1;
  const x1 = Math.ceil((cx + W) / TILE) + 1, y1 = Math.ceil((cy + H) / TILE) + 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x * TILE - cx, py = y * TILE - cy;
      if (x < 0 || x >= state.spec.width) {
        c.fillStyle = '#000';
        c.fillRect(px, py, TILE, TILE);
        continue;
      }
      const b = state.spec.blocks[x + ',' + y];
      if (b) drawBlock(c, px, py, b.type, b.item, y, state.spec.surfaceY);
      // the public view deliberately knows nothing below the surface, and it is
      // greyed out rather than left blank, exactly like an undiscovered cell
      else if (y >= state.spec.surfaceY) drawUnknown(c, px, py);
    }
  }

  c.fillStyle = 'rgba(255,0,0,0.35)';
  for (const t of state.spec.traps) {
    c.fillRect(t.x * TILE - cx + 4, t.y * TILE - cy + 4, TILE - 8, TILE - 8);
  }
  for (const d of state.spec.digs) {
    c.fillStyle = 'rgba(255,220,80,0.35)';
    c.fillRect(d.x * TILE - cx, d.y * TILE - cy, TILE, TILE);
  }
  for (const p of ps) drawPlayer(c, p, p.x * TILE - cx, p.y * TILE - cy);
}

let last = 0;
function loop(ts) {
  const dt = last ? Math.min(200, ts - last) : 16;
  last = ts;
  if (state.spectator) renderSpectator(dt);
  else renderGame(dt);
  if (state.battle) updateBattleClock();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// countdowns and the shovel timer need a nudge even when nothing is happening
setInterval(() => { if (state.me) updateHud(); }, 500);

// If the socket goes quiet, ask for a full state. Catches the case where an
// event was lost but the connection itself looks fine.
setInterval(() => {
  if (state.me && !state.halted && !pending) sync();
}, 5000);
