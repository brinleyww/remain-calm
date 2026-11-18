# REMAIN CALM

*Municipal Outbreak Response.* You run a city's Office of Civil Preparedness. An outbreak starts somewhere in the district, and you have a budget, a few hours of planning and a printed map. Wall off safe zones, cut gates so residents can get in, put riflemen on the tall roofs, and call in support once the clock is running. Your score is the share of residents still alive at the end.

It runs in the browser with plain JavaScript modules. There is no build step and nothing to install.

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
| `,` `.` | Slower / faster (0.5×, 1×, 2×, 4×) |
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
| V / C / R | Building heights view / special buildings view / range rings |
| Ctrl+Z | Undo (planning, single player) |
| Enter | Close a zone / next stage |
| Esc | Cancel the current tool, then the pause menu |
| WASD or arrows | Pan |
| Right or middle drag | Pan |
| Wheel | Zoom |
| Home | Fit the stage on screen |

## Modes

- **Campaign.** Six fictional cities, each with four to seven stages. A city opens when every stage of the previous one has at least a bronze badge. Clearing stages issues new units, abilities and upgrade tiers. Finishing a whole city in one sitting without a loss or a retry marks it *Flawless*. Hardcore and Ultra difficulty open once the campaign is complete.
- **Free Play.** Choose a generated city (seed, 1–5 km, water, density, bridges, stages), a real place, or a map from your library. Add mutators and choose a difficulty. Free play uses everything you have unlocked.
- **Daily Challenge.** A generated city and two mutators chosen from the date. Your best result for each day is kept.
- **Sandbox.** Unlimited money and command points, with everything unlocked. Results are not recorded.
- **Co-operative.** Two players link directly by swapping two codes; there is no server. The host picks the city and both players plan together. Money and command points are split evenly. Each player owns their own zones, walls and units, and READY needs both players. Some strict networks block direct links.
- **Map Editor.** Start from a blank sheet, a generated city or an imported map. You can draw roads (including bridges, paths and rail), buildings, water, parks, stage boundaries and outbreak hints. Inspect the sheet for problems, *Test play* it, save it to the library or export it.
- **Library.** Your saved maps, mutators and scenarios. Sort, search and star them, export or import `.rcmap.json` files, and copy or paste share codes.

### Mutators

A mutator is a list of `path=value` lines that override the numbers in `js/data/config.js`. Later lines win. There are built-in presets, and you can write your own in the library. For example:

```
zombie.speed=4.76
economy.moneyBase=3000
outbreak.maxSites=18
```

## Real places and map data

The *Real place* tab looks a place up with the OpenStreetMap Nominatim service. It then downloads roads, buildings, water and parks for the square you choose from the Overpass API. Requests are only made when you press a button, one at a time, and each has a timeout. Large or dense areas take a while to convert, and very big maps can run slowly. The game warns you when the population is capped.

Map data for imported places is © OpenStreetMap contributors and available under the Open Database License (<https://www.openstreetmap.org/copyright>). The attribution is shown in game and stored in the map's author field. The live import has only been tested against recorded responses, so a change on the services' side may need a fix.

## Performance

Population size in Settings (5–100%, default 35%) scales how many residents spawn. The tested worst case is a 4 km generated city on its final stage in headless Chrome on a desktop:

- At the default 35%: about 15,700 people. Each simulation tick takes about 2.6 ms and each frame renders in about 1.5 ms.
- At 100%: about 45,000 people. Each tick takes 6–7 ms and the whole-city view renders in about 2.3 ms.

Both settings hold 60 fps at 1× and at 4×. If the game runs slowly on your machine, lower the population size in Settings.

## Project layout

```
index.html            the game (title screen and menus)
dev.html              developer page: a generated city straight into planning (?seed=&size=&stage=&mut=...)
styleguide.html       every UI component, the three print palettes and a live map renderer
css/                  base.css (tokens, type, components) · shell.css (menus) · game.css (HUD) · editor.css
js/main.js            boot, screen router, session launch, results to progress
js/data/config.js     every game number; mutators override it
js/util/              rng, geometry, events, gzip share codes
js/map/               map format, city generator, OpenStreetMap import, campaign cities, IndexedDB library
js/sim/               deterministic, DOM-free simulation: grid, world, agents, navigation fields, zones,
                      fire, structures, stages, economy, mutants, units, combat, abilities, vehicles
js/render/            palette, camera, static map renderer (tiled cache), live world layer, effects
js/game/              in-game session: loop, input, tools, HUD, info card, result card, menus, sound
js/ui/                menu screens, loadout, settings, library, import, mutator editor, map editor, co-op lobby
js/meta/              settings, progress and unlocks, achievements
js/net/coop.js        WebRTC link with copy-paste codes and deterministic lockstep
test/                 node test suites (node test/all.mjs) and browser harnesses for the editor and co-op
```

The simulation in `js/sim` uses only its seeded random number generator and a fixed tick. Every player action goes through `world.exec(command)`, so two machines given the same commands stay in step, and undo and retry can restore exact snapshots.

## Tests

```
node test/all.mjs
```

This runs the simulation, combat, map, shell, editor, lockstep and integration suites in Node 20 or later. `node test/sim_bench.mjs --city` and `node test/combat_bench.mjs` measure simulation speed.
