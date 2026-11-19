# REMAIN CALM

*Municipal Outbreak Response.* You run a city's Office of Civil Preparedness. An outbreak starts somewhere in the district, and you have a budget, a few hours of planning and a printed map. Wall off safe zones, cut gates so residents can get in, put riflemen on the tall roofs, and call in support once the clock is running. Your score is the share of residents still alive at the end.

It runs in the browser with plain JavaScript modules. There is no build step and nothing to install. This is version 0.3.0 (`js/version.js`); the title screen shows it.

## What's new: roads on more than one level

- **Motorways, flyovers and tunnels.** Roads can now run above or below the street. In a real place, a bridge over a road, a path or a railway becomes a deck, a tunnel goes underground, and link roads slope up and down between them, so an expressway interchange works the way it does on the ground. A bridge that only crosses water stays the destructible bridge it always was. Generated cities of 3 km and more get a motorway (two from 6 km) on viaducts over the main roads, the railway and the water, with diamond interchanges and one underpass. Campaign cities are unchanged.
- **People and zombies use every level.** Residents and the infected walk up the ramps, along the decks and through the tunnels. A zombie under a deck cannot reach the people on it, and the other way round. A wall or gate blocks every level of the ground it stands on, so a safe zone also owns the decks above it and the tunnels below it: a resident on a deck over the zone is safe, and a zombie there breaches it.
- **Decks can come down.** An overpass has hit points like a bridge (explosives do double damage). When a deck falls, everyone on it falls with it, swimmers over water drop into the river, and the ground under it turns to rubble. The city rebuilds it at the next stage. A small blast hits only the level it goes off on; a big one reaches the ground and the decks; tunnels are hit only from inside, or by the nuclear strike. Paratroopers dropped over a deck land on it.
- **On the map**, decks are drawn over the people below them, with a shadow and piers; tunnels are a dashed casing with a mark where they go under; people in tunnels show faintly. Trains disappear into rail tunnels and run over viaducts. Press **L** (or *Decks* under View) to fade the decks and see what is under them. A click takes troops on the highest level first, and hovering a deck shows *Overpass* and its structural integrity.
- **Map editor**: a road's *Level* (tunnel, ground, deck 1 to 3), *Ramp at start / end*, and the height of every node; the *Levels* view (L) tints roads by level. *Inspect* warns about a deck that ends in mid-air, a ramp steeper than one level per 30 m, and a ramp that meets the ground inside a building.
- **Map files**: a map whose roads have heights is saved as format version 2, which older builds cannot open. Maps without them are saved exactly as before. Rail bridges and viaducts are now scenery: nobody walks along them, and boats pass under them.

## What's new in 0.3.0

- **Troop orders.** With no tool chosen, drag a box or click to select your squads (paratroopers, militia, police) and the vehicles you command (boats, armoured carrier, tank). Shift adds or drops one; a double-click takes every squad of that kind on screen. Right-click sends them there, or press M and click: squads march together, through gates, and hold the spot. H hunts, K holds where they stand, and Z sends squads back to your nearest safe zone with a gate, boats back to their moorings and armour to where it landed. Esc clears the selection. Left drag no longer pans the map; use right or middle drag. All four order keys can be rebound in Settings.
- **Boats** on open water: patrol boat, gunboat, rocket barge, evac ferry and water mines (see *Boats* below). In the campaign the patrol boat and water mines are issued from the start, the ferry after the first stage of Port Ashby, the gunboat after the second stage of Carrowmere and the rocket barge after the third stage of Halden Cross. Free Play has every boat.
- **A faster clock.** 1× now runs twice as fast as it did, and there is an 8× step. When the computer cannot keep up, the speed control shows the speed it really reaches, and the picture stays smooth instead of stuttering.
- **Railways and trains.** Zoomed out, a railway is the classic chequered map line. Closer in you see the ballast bed, sleepers and both rails, level crossings with barrier arms, rail bridges over water, platforms at the stations and buffer stops at the ends of the line. Trains run on long routes, in from one edge of the map and out at another, or up to the end of a line and back. They stop at the stations and sound a horn as they pull away. They are only scenery: they never hit anyone, they pause with the game and run faster at higher speeds, and both co-op players see the same trains. *Trains on the railways* in Settings turns them off.
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
| U | Upgrade (click or drag across units; troops are ignored, Alt takes the next unit under the cursor) |
| X | Refund (click one placement, or drag a box and choose from the list; troops are ignored, Alt takes the next placement under the cursor) |
| P | Paint mode: drag across roofs to garrison every building you pass |
| D | Detonate the selected demolition charge |
| Click (no tool) | Open what you built under the cursor (unit, gate, wall, hold point, corridor), even with troops standing on it; anywhere on a manned roof opens its unit. With nothing built there it takes the squad, then the building, then the zone. The thing a click would take is outlined and named in a tooltip |
| Click again on the spot (within a second) or Alt+click | The next thing under the cursor: other builds, the squad, the building, the zone. The tooltip names it ("click again for Paratroopers") |
| Left drag (no tool) | Select your troops: every squad with a man in the box, and commandable vehicles. Shift-click adds or drops a squad even on top of a build; double-click takes every squad of that kind on screen |
| Right-click (troops selected) | Move them there. They walk as a group, through gates, and hold the spot |
| M / H / K / Z | Selected troops: move (then click the point) / hunt / hold where they stand / back to your nearest safe zone (boats to their moorings, armour to where it landed) |
| V / C / R | Building heights view / special buildings view / range rings |
| L | Fade the decks (overpasses) to see under them; only on maps with roads on more than one level |
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
- **Free Play.** Choose a generated city (seed, 1–10 km, water, density, bridges, stages), a real place (up to 10 km), or a map from your library. Add mutators and choose a difficulty. Free play uses everything you have unlocked, plus every boat.
- **Daily Challenge.** A generated city and two mutators chosen from the date. Your best result for each day is kept.
- **Sandbox.** Unlimited money and command points, with everything unlocked. Results are not recorded.
- **Co-operative.** Two players link directly by swapping two codes; there is no server. The host picks the city and both players plan together. Money and command points are split evenly. Each player owns their own zones, walls and units, and READY needs both players. Both boards run the same clock, so the slower computer sets the pace. Some strict networks block direct links.
- **Map Editor.** Start from a blank sheet (up to 12 km), a generated city (up to 10 km) or an imported map. You can draw roads (including bridges, paths and rail), buildings, water, parks, stage boundaries and outbreak hints. A selected road has a *Level* (tunnel −2 or −1, ground, deck 1 to 3), buttons to put a ramp at either end (it slopes down to the ground, or to the height of the road it meets), and a *Node heights* field with one height per node; double-clicking a road to add a node gives it the height between its neighbours. The *Levels* view (L) colours tunnels and decks by level. Inspect the sheet for problems, *Test play* it, save it to the library or export it.
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

Squares run from 0.5 to 10 km. Anything over 2 km is downloaded in 2 km parts, at most two at a time: 4 parts for 4 km, 16 for 8 km and 25 for 10 km. The square on the map shows the parts and shades each one as it arrives, a part that finds every server busy waits 15 to 45 seconds and asks again while the others carry on, and if a part still fails, *Retry* fetches only the parts still missing. An 8 or 10 km city usually takes one to three minutes to download and draw, longer when the servers are busy.

Public parks and gardens become parks. Back gardens and other private yards (a garden that is private or marked as a residential garden) stay open ground.

Bridges and tunnels keep their levels. Bridge ways are joined end to end; a bridge over a road, path or railway becomes a deck at its `layer` (1 to 3), one over water only stays a level-0 water bridge, and one over nothing stays a road. Tunnels go to level −1 or −2; covered ways and building passages stay on the ground; indoor ways, upper floors and underground parking aisles are left out. Link roads that meet a deck slope along their length, and a deck that meets a plain road ramps down over its last 24 to 40 m. Rail bridges are drawn up on viaducts and rail tunnels and the subway below ground, as scenery.

The map editor's *New drafting sheet* has the same finder under *Real place*: search, drag the square, fetch or drop a file, then *Draft from this place* to redraw it.

Map data for imported places is © OpenStreetMap contributors and available under the Open Database License (<https://www.openstreetmap.org/copyright>). The attribution is shown in game and stored in the map's author field. The import is tested against recorded responses, and `node test/osm_live.mjs` checks the real services now and then; a change on their side may still need a fix.

## Population and performance

*Population scale* is in Settings, under Simulation. It runs from 5% to 200% and the default is 100%. It sets how many residents appear as people on the map. Money and score always use the full population, and the outbreak grows and shrinks with the scale, so the difficulty stays about the same. The note under the slider says what to expect on a 4 km city. A setting saved at the old 35% default moves to 100%; any other saved value is kept. Very large maps are capped at 250,000 people.

**Big sheets.** On a sheet larger than 5 km square, every stage is thinned by the same factor so that the final stage holds about 120,000 people at 100% (`population.autoCap` and `population.autoCapKm2` in the config). An 8 km generated city keeps about a third of its residents and a 10 km city about a quarter; the outbreak shrinks with them, and money and score still use the full population. Maps of 5 km or less are not affected. Free Play, the import facts and the editor show what you will get, for example *8 km · about 120,000 residents at the final stage · population limited for speed*. The population scale multiplies the limit too, up to 250,000, at your own risk. Generated cities over 6 km are laid out as a metro area: a core the size of a 5 km city, satellite town centres, an orbital road, a second railway and a broken green belt.

These figures are from headless Chrome on a desktop with a fast graphics card, 1600×900, whole city in view. Each is a generated river city on its final stage at the default settings. Every step starts from the same battle state, a minute of battle time after READY (about 7,000 zombies), and is measured for 8 seconds while the battle grows to between 8,000 and 21,000 zombies. Each cell is the clock speed reached and the frame rate. Headless frame pacing is approximate.

| City | People | Sim ms per tick | Render ms per frame | 0.5× and 1× | 2× | 4× | 8× |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 km | 27,300 | 3.8–4.3 | 1.3–1.6 | full speed, 57 fps | 2.0× at 57 fps | 4.0× at 57 fps | 5.5× at 51 fps |
| 4 km | 104,700 | 7.7–8.8 | 3.2–4.2 | full speed, 57 fps | 1.8× at 57 fps | 1.8–2.6× at 51–54 fps | 2.5–2.6× at 50–51 fps |

Big sheets, measured the same way but with a minute of battle stepped straight after READY and 6 seconds per speed step (generated river cities, final stage, 120,000 people after thinning; 4 km for comparison). The figures in each cell are the clock speed reached and the frame rate; 1× asks for 2 sim seconds per second.

| City | People | Generate / start | Sim ms per tick | Render ms, whole sheet / street | 1× | 2× | 4× | Memory (JS heap + typed arrays) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 km | 104,800 | 0.7 s / 0.4 s | 6.7 | 4.6 / 1.7 | full speed, 60 fps | 3.1× at 60 fps | 2.6× at 52 fps | 27 + 116 MB |
| 8 km | 120,000 | 2.2 s / 1.1 s | 7.6 | 5.7 / 1.5 | full speed, 60 fps | 3.4× at 60 fps | 3.2× at 59 fps | 81 + 359 MB |
| 10 km | 120,000 | 3.1 s / 1.2 s | 8.7 | 4.8 / 1.5 | full speed, 60 fps | 2.9× at 57 fps | 2.9× at 59 fps | 139 + 548 MB |

Big sheets start with fewer zombies per square kilometre (the outbreak is thinned with the crowd), which is part of why their faster steps keep up.

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
js/render/            palette, camera, static map renderer (tiled cache), decks and tunnels, railways and trains, live world layer, effects
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

This runs the simulation, movement, combat, targeting, map, shell, editor, lockstep, integration, train and multi-level road (`test/decks.mjs`: grid, fields, a leak suite across levels, agents, blasts, fallen decks, determinism) suites in Node 20 or later. `node test/deck_bench.mjs` compares one 4 km city flat, with its motorway, and with every long main road raised (ms per tick and memory); `sim_bench --city --flat` and `combat_bench --flat` run the city without its motorway. `node test/sim_bench.mjs --city`, `node test/combat_bench.mjs` and `node test/crowd_bench.mjs` measure simulation speed. `node --expose-gc test/bigmap_bench.mjs 4,8,10` measures big sheets (generation, stage times, ms per tick, memory). `node test/osm_live.mjs` is a live check against the real map services; it is not part of the suite, so run it only now and then.
