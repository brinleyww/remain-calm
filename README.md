# REMAIN CALM

*Municipal Outbreak Response.* You run a city's Office of Civil Preparedness. An outbreak starts somewhere in the district, and you have a budget, a few hours of planning and a printed map. Wall off safe zones, cut gates so residents can get in, put riflemen on the tall roofs, and call in support once the clock is running. Your score is the share of residents still alive at the end.

It runs in the browser with plain JavaScript modules. There is no build step and nothing to install. This is version 0.2.0 (`js/version.js`); the title screen shows it.

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

The **Key** button under View in the left rack shows a map key: residents, zombies, units and the four mutants.

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

The *Real place* tab looks a place up with the OpenStreetMap Nominatim service. You then drag the square on an OpenStreetMap tile map. Roads, buildings, water and parks for that square are downloaded from the Overpass API, trying more than one public mirror. Requests are only made when you press a button, and each has a timeout. Downloads are cached in your browser, so importing the same square again is instant. If the services are busy, you can export an OSM XML or Overpass JSON file yourself and drop it on the tab. Large or dense areas take a while to convert, and very big maps can run slowly. The game warns you when the population is capped.

Map data for imported places is © OpenStreetMap contributors and available under the Open Database License (<https://www.openstreetmap.org/copyright>). The attribution is shown in game and stored in the map's author field. The live import has only been tested against recorded responses, so a change on the services' side may need a fix.

## Population and performance

*Population scale* is in Settings, under Simulation. It runs from 5% to 200% and the default is 100%. It sets how many residents appear as people on the map. Money and score always use the full population, and the outbreak grows and shrinks with the scale, so the difficulty stays about the same. The note under the slider says what to expect on a 4 km city. A setting saved at the old 35% default moves to 100%; any other saved value is kept. Very large maps are capped at 250,000 people.

These figures are from headless Chrome on a desktop with a fast graphics card, 1600×900. Each is a generated city on its final stage at the default settings, during a battle with several thousand zombies.

| City | People | Sim ms per tick (average / p95) | Render ms per frame (whole city / street zoom) | 1× | 4× |
| --- | --- | --- | --- | --- | --- |
| 2 km | 28,200 | 3.2–4.0 / 4.5–6.0 | 1.4 / 0.3–0.4 | 57 fps | 4.0× real speed at 57 fps |
| 4 km | 104,000 | 7.0–8.2 / 9.9–11.4 | 3.6–3.9 / 0.7–0.9 | 57 fps | 4.0× real speed at 56 fps |

At 150% a 4 km city still reaches 4× but drops frames, and at 200% (about 206,000 people) 4× manages about 3.5×. Very packed crowds seen close up switch to a faster drawing method. On a laptop, or if battles stutter, lower the population scale.

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
