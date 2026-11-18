# REMAIN CALM

*Municipal Outbreak Response.* You run a city's Office of Civil Preparedness. An outbreak starts somewhere in the district, and you have a budget, a few hours of planning and a printed map. Wall off safe zones, cut gates so residents can get in, put riflemen on the tall roofs, and call in support once the clock is running. Your score is the share of residents still alive at the end.

It runs in the browser with plain JavaScript modules. There is no build step and nothing to install. This is version 0.3.0 (`js/version.js`); the title screen shows it.

## What's new in 0.3.0

- **Troop orders.** With no tool chosen, drag a box or click to select your squads (paratroopers, militia, police) and the vehicles you command (boats, armoured carrier, tank). Shift adds or drops one; a double-click takes every squad of that kind on screen. Right-click sends them there, or press M and click: squads march together, through gates, and hold the spot. H hunts, K holds where they stand, and Z sends squads back to your nearest safe zone with a gate, boats back to their moorings and armour to where it landed. Esc clears the selection. Left drag no longer pans the map; use right or middle drag. All four order keys can be rebound in Settings.
- **Boats** on open water: patrol boat, gunboat, rocket barge, evac ferry and water mines (see *Boats* below). In the campaign the patrol boat and water mines are issued from the start, the ferry after the first stage of Port Ashby, the gunboat after the second stage of Carrowmere and the rocket barge after the third stage of Halden Cross. Free Play has every boat.
- **A faster clock.** 1× now runs twice as fast as it did, and there is an 8× step. When the computer cannot keep up, the speed control shows the speed it really reaches, and the picture stays smooth instead of stuttering.
- **Real place import fixes.** Back gardens and other private yards stay open ground instead of becoming parks. *Cancel* works at every step, *Download again* replaces a copy kept in the browser, the facts show the residents you will get at your population setting, and the map editor's *New drafting sheet* has a *Real place* tab.

## What's new in 0.2.0

- **Residents reach the safe zones.** Calm residents within 350 m of a gate, measured along the streets, walk in, and lured residents walk a little faster. Their route avoids zombie packs and spreads out across gates when one queue gets long. If a gate would open onto a building, it slides up to 12 m along the wall to a real opening. If it still opens onto a building or only a narrow gap, the gate preview turns red and says so. Residents no longer get stuck standing on the inner edge of a wall.
- **Walls are true lines** at any angle. Zombies and residents stop at the drawn line, with no gaps at diagonals. Overlapping zones draw a single outer wall.
- **Bigger crowds.** Population defaults to 100% (it was 35%), and generated cities are denser: about 27,000 people on a 2 km city and 103,000 on a 4 km city at the final stage. Outbreaks were rescaled to the same number of zombies as before, so early stages play much as they did in 0.1. Later stages are somewhat harder, because the zombies have denser crowds to infect.
- **People and zombies are drawn as circles.** Each kind of mutant has its own colour and mark: explosive, armoured, swimmer and giant. A **Key** toggle under View shows a map key.
- **Guns share out targets.** Two guns no longer fire at the same zombie. Artillery aims where a group will be when the shell lands, skips groups that are already covered, and favours zombies close to residents.
- **The map grows** with an animation when you go to the next stage. Click, Space, Enter or Esc skips it.
- **Feedback tab** on every screen (see below).
- **Real places:** you pick the square on a map. Downloads are cached and try several Overpass mirrors. You can also load an OSM XML or Overpass JSON file that you exported yourself.

## Running it

From this folder:

```
python -m http.server 8642
```

Then open <http://localhost:8642/>.

Any static file server works. Opening `index.html` straight from disk does not, because browsers block ES modules on `file://`.

Progress, settings and the map library are kept in your browser (localStorage and IndexedDB).

## How a stage plays

1. **Planning.** The clock is stopped. Draw safe zones, add gates, place units and buy ability charges in the loadout (Tab).
2. **READY** (Space). The outbreak sites are revealed and the game pauses once so you can react. Press Space again to start the clock. You can keep building during the battle with whatever money is left.
3. **Result.** You win when every infected person is dead. You lose if fewer than 4% of residents survive. Winning gives a badge based on the percentage saved.
4. **Next stage** (Enter). The boundary grows and everything you built carries over. The city is repaired, residents spawn across the larger area, and the budget and command points are recalculated.
5. **Retry.** After a battle, Retry restores your layout as it was when you pressed READY. During planning, the pause menu's *Clear this stage* resets the stage to how it began.

## Controls

Every key can be rebound in Settings. These are the defaults.

| Key | Action |
| --- | --- |
| Space | READY, then pause / resume |
| `,` `.` | Slower / faster (0.5×, 1×, 2×, 4×, 8×) |
| B | Safe zone: click corners, then Enter or click the first corner. Right-drag a corner to move it |
| N | Standalone wall |
| G | Gate (click one of your zone walls) |
| Q | Evacuation corridor (drag from tail to arrow; wheel or `[` `]` sets width) |
| E | Hold point (drag the outer radius) |
| 1–7 | Units in your loadout slots |
| F1–F8 or Shift+1–8 | Abilities |
| Tab | Loadout (planning only) |
| U | Upgrade (click or drag across units) |
| X | Refund (click one placement, or drag a box and choose from the list) |
| P | Paint mode: drag across roofs to garrison every building you pass |
| D | Detonate the selected demolition charge |
| Left drag or click (no tool) | Select your troops: every squad with a man in the box, and commandable vehicles. Shift adds or drops; double-click takes every squad of that kind on screen |
| Right-click (troops selected) | Move them there. They walk as a group, through gates, and hold the spot |
| M / H / K / Z | Selected troops: move (then click the point) / hunt / hold where they stand / back to your nearest safe zone (boats to their moorings, armour to where it landed) |
| V / C / R | Building heights view / special buildings view / range rings |
| Ctrl+Z | Undo (planning, single player) |
| Enter | Close a zone / next stage |
| Esc | Cancel the current tool or troop selection, then the pause menu |
| WASD or arrows | Pan |
| Right or middle drag | Pan |
| Wheel | Zoom |
| Home | Fit the stage on screen |

The **Key** button under View in the left rack shows a map key: residents, zombies, units and the four mutants.

The battle clock has five speeds, 0.5× to 8×; 1× now runs twice as fast as it did in 0.2.0. When the computer cannot keep up, the speed control shows the speed it really reaches, for example *8× · running 2.5×*. The picture stays smooth and the clock simply runs slower; nothing piles up to catch up later.

## Boats

Boats are placed on open water and sail the connected stretch of water they start on, passing under bridges. A boat needs a minimum area of water inside the stage, and the placement preview shades the water it would use. Swimmers that reach a boat tear at its hull, and a sunk boat is lost for good. Boats go back to their moorings at each new stage.

- **Patrol Boat**: fast, with a machine gun. It patrols near its mooring and shoots the infected on the shore and in the water.
- **Gunboat**: slow and tough, with a deck cannon that hits an area and a machine gun.
- **Rocket Barge**: fires a rocket salvo at crowds, then reloads for a long time.
- **Evac Ferry**: boards residents on the shore near crowds outside the zones. It lands them at a safe zone that touches the water, or takes them out along a river that leaves the map. Like the bus, it counts them as evacuated. If it has nowhere to go, its card says so.
- **Water Mine**: painted on water. It goes off under the infected in the water.

Selected boats take Move, Hunt, Hold and Return orders. Return sends a boat back to its mooring. Clicking a boat also opens its card, with its hull, what it is doing, Upgrade and Refund.

In the campaign the patrol boat and water mines are issued from the start; the ferry, gunboat and rocket barge come later (see *What's new*). Free Play always has all five.

## Modes

- **Campaign.** Six fictional cities, each with four to seven stages. A city opens when every stage of the previous one has at least a bronze badge. Clearing stages issues new units, abilities and upgrade tiers. Finishing a whole city in one sitting without a loss or a retry marks it *Flawless*. Hardcore and Ultra difficulty open once the campaign is complete.
- **Free Play.** Choose a generated city (seed, 1–5 km, water, density, bridges, stages), a real place, or a map from your library. Add mutators and choose a difficulty. Free play uses everything you have unlocked, plus every boat.
- **Daily Challenge.** A generated city and two mutators chosen from the date. Your best result for each day is kept.
- **Sandbox.** Unlimited money and command points, with everything unlocked. Results are not recorded.
- **Co-operative.** Two players link directly by swapping two codes; there is no server. The host picks the city and both players plan together. Money and command points are split evenly. Each player owns their own zones, walls and units, and READY needs both players. Both boards run the same clock, so the slower computer sets the pace. Some strict networks block direct links.
- **Map Editor.** Start from a blank sheet, a generated city or an imported map. You can draw roads (including bridges, paths and rail), buildings, water, parks, stage boundaries and outbreak hints. Inspect the sheet for problems, *Test play* it, save it to the library or export it.
- **Library.** Your saved maps, mutators and scenarios. Sort, search and star them, export or import `.rcmap.json` files, and copy or paste share codes.

### Mutators

A mutator is a list of `path=value` lines that override the numbers in `js/data/config.js`. Later lines win. There are built-in presets, and you can write your own in the library. For example:

```
zombie.speed=4.76
economy.moneyBase=3000
outbreak.maxSites=18
```

## Feedback

A **Feedback** tab is on every screen. On menus it sticks out of the right edge, in the editor it rises from the bottom edge, and in game it hangs from the top bar. The pause menu also has *Send feedback*.

- A note has a kind (bug, idea, balance, praise, other), a message of 3 to 2,000 characters, and an optional name, reply address and map screenshot. *What gets sent* lists everything, including the game version, the mode and the map.
- The draft is saved as you type. Opening the panel pauses a single-player battle.
- Each browser and each network can send one note every 10 minutes, and the server takes at most 300 notes a day. After sending, the panel shows a RECEIVED stamp and counts down to the next allowed note.

### Owner view

Open the game with `?owner` (for example `https://brinleyww.github.io/remain-calm/?owner`), or press *Owner* in the feedback panel, then paste the owner key. You can filter by kind or by unread notes, mark notes read, look at screenshots, delete notes and export everything as JSON. The key is kept only for that browser tab unless you tick *Remember on this device*. Every page on the same github.io address can read the browser's saved data, so only tick it on your own computer. When the key is known, the Feedback tab shows the number of unread notes.

### Deploying the feedback server

The notes go to a small Cloudflare Worker in `feedback-worker/`. It uses one KV namespace for the notes and one Durable Object that applies the 10-minute and daily limits. Both are on Cloudflare's free plan. To deploy it, from a PowerShell window that is logged in to Cloudflare (`npx wrangler@3 login`):

```
powershell -ExecutionPolicy Bypass -File feedback-worker\deploy.ps1
```

On the first run the script:

1. creates the KV namespace and writes its id into `wrangler.toml`;
2. deploys the Worker, which also creates the Durable Object;
3. writes a random owner key to `feedback-worker\.owner-key.txt`, which git ignores;
4. stores that key as the Worker's `OWNER_KEY` secret.

Your owner key is in that file. Never commit it or share it. For a separate salt for hashing addresses, also run `npx wrangler@3 secret put IP_SALT` in `feedback-worker/`; without it the owner key is used as the salt.

The game sends notes to the address in `ENDPOINT` at the top of `js/ui/feedback.js`. If the address wrangler prints after deploying is different, change `ENDPOINT` to match. The Worker only accepts requests from `https://brinleyww.github.io` and from localhost.

To test locally, run `npx --yes wrangler@3 dev --local --port 8779 --var OWNER_KEY:any-test-key` in `feedback-worker/`. Then, in the game's browser console, set `localStorage.setItem('rc.fbEndpoint', 'http://127.0.0.1:8779')`.

## Real places and map data

The *Real place* tab looks a place up with the OpenStreetMap Nominatim service. You then drag the square on an OpenStreetMap tile map. Roads, buildings, water and parks for that square are downloaded from the Overpass API, trying more than one public mirror. Requests are only made when you press a button, and each has a timeout. Downloads are cached in your browser, so importing the same square again is instant; when a copy is kept, *Download again* fetches fresh data and replaces it. If the services are busy, you can export an OSM XML or Overpass JSON file yourself and drop it on the tab. Large or dense areas take a while to convert, and very big maps can run slowly. *Cancel* stops an import at any step, including while the map is being drawn. The facts list the residents you will get at your population setting, and the game warns you when the population is capped.

Public parks and gardens become parks. Back gardens and other private yards (a garden that is private or marked as a residential garden) stay open ground.

The map editor's *New drafting sheet* has the same finder under *Real place*: search, drag the square, fetch or drop a file, then *Draft from this place* to redraw it.

Map data for imported places is © OpenStreetMap contributors and available under the Open Database License (<https://www.openstreetmap.org/copyright>). The attribution is shown in game and stored in the map's author field. The import is tested against recorded responses, and `node test/osm_live.mjs` checks the real services now and then; a change on their side may still need a fix.

## Population and performance

*Population scale* is in Settings, under Simulation. It runs from 5% to 200% and the default is 100%. It sets how many residents appear as people on the map. Money and score always use the full population, and the outbreak grows and shrinks with the scale, so the difficulty stays about the same. The note under the slider says what to expect on a 4 km city. A setting saved at the old 35% default moves to 100%; any other saved value is kept. Very large maps are capped at 250,000 people.

These figures are from headless Chrome on a desktop with a fast graphics card, 1600×900, whole city in view. Each is a generated river city on its final stage at the default settings. Every step starts from the same battle state, a minute of battle time after READY (about 7,000 zombies), and is measured for 8 seconds while the battle grows to between 8,000 and 21,000 zombies. Each cell is the clock speed reached and the frame rate. Headless frame pacing is approximate.

| City | People | Sim ms per tick | Render ms per frame | 0.5× and 1× | 2× | 4× | 8× |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 km | 27,300 | 3.8–4.3 | 1.3–1.6 | full speed, 57 fps | 2.0× at 57 fps | 4.0× at 57 fps | 5.5× at 51 fps |
| 4 km | 104,700 | 7.7–8.8 | 3.2–4.2 | full speed, 57 fps | 1.8× at 57 fps | 1.8–2.6× at 51–54 fps | 2.5–2.6× at 50–51 fps |

When the simulation cannot keep up, each frame gets a fixed share of time for it (about 16 ms on a 4 km city), so the picture stays near 50 fps or better and the clock runs slower instead. The 8× step gets about one millisecond more and aims for 45 fps, so it never runs slower than 4×. A 4 km city sits close to the point where two ticks no longer fit in a frame, so its 4× figure moves with whatever else the computer is doing. The figures from 0.2.0 at 150% and 200% were measured on the old scale: at 150% a 4 km city reached the new 2× but dropped frames, and at 200% (about 206,000 people) the new 2× ran at about 1.75×. Very packed crowds seen close up switch to a faster drawing method. On a laptop, or if battles stutter, lower the population scale.

## Project layout

```
index.html            the game (title screen and menus)
dev.html              developer page: a generated city straight into planning (?seed=&size=&stage=&mut=...)
styleguide.html       every UI component, the three print palettes and a live map renderer
css/                  base.css (tokens, type, components) · shell.css (menus) · game.css (HUD) · editor.css · import.css · feedback.css
js/main.js            boot, screen router, session launch, results to progress
js/data/config.js     every game number; mutators override it
js/util/              rng, geometry, events, gzip share codes
js/map/               map format, city generator, OpenStreetMap import, campaign cities, IndexedDB library
js/sim/               deterministic, DOM-free simulation: grid, world, agents, navigation fields, zones,
                      fire, structures, stages, economy, mutants, units, combat, abilities, vehicles
js/render/            palette, camera, static map renderer (tiled cache), live world layer, effects
js/game/              in-game session: loop, input, tools, HUD, info card, result card, menus, sound
js/ui/                menu screens, loadout, settings, library, import, mutator editor, map editor, co-op lobby, feedback
js/meta/              settings, progress and unlocks, achievements
js/net/coop.js        WebRTC link with copy-paste codes and deterministic lockstep
js/version.js         the version shown on the title screen and sent with feedback
feedback-worker/      the Cloudflare Worker that stores feedback (deploy.ps1 puts it online)
test/                 node test suites (node test/all.mjs) and browser harnesses for the editor and co-op
```

The simulation in `js/sim` uses only its seeded random number generator and a fixed tick. Every player action goes through `world.exec(command)`, so two machines given the same commands stay in step, and undo and retry can restore exact snapshots.

## Tests

```
node test/all.mjs
```

This runs the simulation, movement, combat, targeting, map, shell, editor, lockstep and integration suites in Node 20 or later. `node test/sim_bench.mjs --city`, `node test/combat_bench.mjs` and `node test/crowd_bench.mjs` measure simulation speed. `node test/osm_live.mjs` is a live check against the real map services; it is not part of the suite, so run it only now and then.
