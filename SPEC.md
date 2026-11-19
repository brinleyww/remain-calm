# REMAIN CALM — design + architecture spec

Browser game, vanilla JS ES modules, **no build step, no npm dependencies**. Served by any static server (`python -m http.server 8642` from this folder). Original identity (name, look, UI, maps, text) — the *mechanics* follow a genre reference closely (top-down outbreak simulation + tower defence on real or generated cities). Never use the reference game's name, logo, art, map names or UI look anywhere in code, text or comments.

Numbers live in `js/data/config.js` (single source of truth, overridable by mutators). If this spec and config disagree, config wins. `js/util/rng.js` and `js/util/geom.js` already exist — use them, don't duplicate.

---------------------------------------------------------------------------------------------------
## 1. Identity and art direction

**Name:** REMAIN CALM — subtitle "Municipal Outbreak Response". The player is the city's Office of Civil Preparedness.

**Look: a printed civil-defence plotting map on a desk.** Flat, printed, ink-on-paper. NOT a dark sci-fi tactical HUD, no neon, no glassmorphism, no gradients, no glow, no rounded "card" UI, no emoji, no purple. It must not look AI-generated or templated: hard 1px ink rules, offset solid shadows (no blur), typewriter data, rubber stamps, tabbed manila folders, hand-ruled tables.

Palette tokens (CSS custom properties in `css/base.css`, mirrored in `js/render/palette.js`):
- `--paper #ECE5D3` (desk map paper), `--paper-2 #E2D9C2` (panel), `--card #F6F1E4` (index card), `--ink #1E1C18`, `--ink-2 #4A463D`, `--ink-3 #8A8371` (faint rules)
- map: road `#F8F4EA` with casing `#B9B09A`, building `#CFC6B0` outline `#6F6756`, building shadow `rgba(30,28,24,.18)`, water `#A7B8BC` + hatch `#8EA2A7`, park `#B7BD93`, rubble stipple `#8A8371`, rail `#6F6756` dashed
- agents: civilian `#2B4A7A` (calm) / `#3F6FB0` (panicked), zombie `#B0341F`, mutants: explosive `#E07B00`, shielded `#5A5A5A` ring, swimmer `#1F7F8F`, giant `#6E1408`; police `#1F3B5C` w/ white dot, militia `#7A5A1F`, soldiers `#2F5D3A`
- zones: safety orange `#D9662B` (walls, hatched interior at 10% alpha), gates as gaps with two ticks; corridor amber `#C9962A` dashed + chevrons; hold: two concentric dashed circles
- stamps / alerts: stamp red `#B3261E`, approval green `#2E6B3A`, carbon blue `#27408B`
- badges: bronze `#9A5B2E`, silver `#8C8C8C`, gold `#B38B1D`, sapphire `#2B4C9B`, emerald `#2C7A4B`, ruby `#9B1B30`, diamond `#5B8FA8`

Fonts (Google Fonts link with system fallbacks so it still works offline): **"IBM Plex Mono"** (all numbers/data/typewriter text), **"Archivo Narrow"** (labels, headings, UPPERCASE with letter-spacing .08em). Stamps: Archivo Narrow 700, rotated −4°..+3°, double border, slight SVG turbulence mask for ink texture.

Units/structures on the map are drawn as small stamped plan symbols (our own): garrison = filled square on the building's centroid with a notch per level; sniper = small triangle; turret = circle with a stroke barrel; mortar = circle with "M"; howitzer = circle with long barrel; battleship = hull outline; railgun = long rectangle; mines = tiny x; walls = thick orange lines with hatching; gate = gap with ticks. Buildings get an **oblique drop shadow offset ∝ height** (gives depth while staying a flat print). Special buildings get a stamped circle label: CIV / COM / ARS / REL / HAZ.

Sound: tiny WebAudio-synthesised effects only (dry gunfire ticks, thumps, siren sweep on outbreak, typewriter clack on UI). No files.

---------------------------------------------------------------------------------------------------
## 2. Game rules (mechanics)

### 2.1 Structure
- A **map** has 3–7 **stages** (`map.levels`), each with a boundary polygon; stage k's boundary contains stage k−1's. Stage 1 is a small district; the last stage is the whole map.
- Per stage: **PLANNING** (untimed, sim frozen) → press **READY** (Space) → **BATTLE** (real time; pause, 0.5×/1×/2×/4×/8× speeds, where 1× = `sim.baseSpeed` sim seconds per real second; building still allowed with remaining money) → **RESULT** (win: badge + stats; loss: debrief with RETRY).
- **Next stage** (Enter on the result card): boundary expands, everything the player built **carries over**, the city is restored (buildings, bridges, fires reset), civilians respawn over the whole new boundary, zombies cleared, money cap and SP recomputed for the new stage.
- **Retry** restores the planning state saved when that stage's planning began (placements, loadout, specials choices).

### 2.2 City simulation
- **Population.** Nominal population C = Σ building footprint m² × `population.perM2` × kindMul, over buildings inside the stage boundary. Economy uses C. Spawned civilians = round(C × `population.scale` × f) capped by `sim.maxAgents` (if capped, show "large map" warning). f = `autoCap` / whole-sheet nominal on sheets larger than `autoCapKm2` (25 km²) whose nominal exceeds `autoCap` (120,000), else 1 (`popLimit` in format.js); outbreak zombie counts use the same scale × f. Fields on stages above 25 km² refresh √(area/25 km²) times faster (`bigMul` in nav.js). Civilians spawn in **packs** of 6–30 on walkable cells next to buildings (weighted by building population), standing calm.
- **Civilians** — calm/panic model per agent (panic p ∈ [0,1]):
  - p → 1 when a zombie is within `civ.panicRadius`; panicked neighbours within `panicSpreadRadius` raise p with `panicSpreadChance` per second; p decays slowly when nothing is seen.
  - **Calm**: mill around their pack spot. If a gate is within `gateLureRadius` path distance (civField), they *walk* to it and enter (gates lure). Inside a broadcast radius they walk to the nearest gate of **any** non-breached zone.
  - **Panicked** (p ≥ threshold): *run* (`civ.run`, ≈ 0.59 × zombie speed) down civField to the nearest reachable gate / rescue pickup (bus, medevac). If civField is unreachable, flee directly away from the nearest zombie.
  - **Corridor**: a civilian inside a corridor box follows that corridor's own field to its exit edge, then resumes normal behaviour (short immunity so it isn't re-captured).
  - **Hold**: a civilian inside the outer radius walks into the inner circle and stays there until the hold is removed.
  - **Safe**: once on an interior cell of a non-breached zone, the civilian is SAFE and wanders inside it. If that zone is breached, all its civilians panic and look for another zone (an outer-wall breach empties the zone even if inner walls hold).
  - Infection: a zombie touch (within `zombie.touchRadius`) **instantly infects** a civilian → TURNING for `turnSec` (stands still, staggers), then becomes a zombie. Armed humans have small HP (2–3); each zombie touch-attack (1/s) deals 1; at 0 they turn too.
- **Zombies**
  - Speed `zombie.speed` (swimmers on water × `swimSpeedMul`). HP = `hpStart` for `hpGraceSec` after READY, then +`hpPerMin` per minute up to `hpMax` (× difficulty). All zombies (not individual) share this HP curve; mutants multiply it.
  - Target: nearest human within `sight` → chase directly. Otherwise follow the **scent field** (they "know where every human is", including people inside zones), which routes through walls/gates at a cost so they besiege zones. Blocked by a wall/gate cell → attack it (`wallDps`, giants × `wallDpsMul`). A destroyed wall/gate cell becomes passable. Zombies never path through buildings; water only for swimmers.
  - Flocking: light separation so crowds spread along streets.
  - **Outbreak** (on READY): sites = clamp(round(stageArea_km² × `perKm2`), min, max) × difficulty. Each site: radius `outbreak.radius`, `zombies + zombiesPerLevel × stageIdx` zombies (scaled by `population.scale` when `zombieScaleWithPop`), placed on walkable cells, **never inside or within `minDistFromZone` of a zone**, biased toward civilian density. Sites are chosen from an RNG seeded by (map seed, stage, hash of the current placements) — so they re-roll whenever the layout changes, and are hidden until READY. Option (default on): auto-pause right after READY so the player can react. Later stages may get a **secondary outbreak** at a random time in `secondaryAfterSec`. Mutator `edgeWaves` adds hordes from the boundary edge.
  - **Mutations**: from `mutation.firstSec`, every `intervalSec` a dense zombie cluster becomes a **mosh pit** (ring on map + countdown `pitSec`; zombies within `pitAttract` gather to it). If ≥ `pitMin` zombies are still in the pit when it ends → a mutant spawns from them: explosive (blows up on death/at walls: blast damages humans and walls), shielded (absorbs `shield` damage first), swimmer (crosses water), giant (merges `merge` zombies; × `hpMul` HP, smashes walls fast). Snipers target mutants first. Log "ZOMBIES ARE MUTATING".
- **Buildings**: HP = hpBase + area × hpPerM2 + height × hpPerM. Damaged by heavy weapons/abilities/fire. At 0 they **collapse** (topple: the footprint plus a strip toward a random/impact direction of length ≈ height turns to RUBBLE (walkable, slow); everything under it dies; nearby buildings take domino damage; may catch fire). A garrison/sniper/mortar on a collapsed building is destroyed. Hazard buildings explode when destroyed (blast + fire, chain reaction).
- **Bridges**: road pieces over water. HP = clamp(hpPerM × length + hpPerWidthM × width, hpMin, hpMax); explosives deal × `explosiveMul`. Hover/click shows "structural integrity". At 0 the bridge cells become water; non-swimmers on it drown. Falling buildings damage them.
- **Fire**: coarse grid; spreads to parks/buildings; burns agents (all humans too), buildings, walls; burns out after `burnSec`. Fire, corridors, holds, mosh pits, mines, spikes and oil are ground-only.
- **Multi-level roads** (`js/sim/decks.js`): a road with heights (`z`) puts its tier-0 cells on the ground and every other cell it covers on a node, one per (tier, cell): tiers −2, −1 are tunnels, 1..3 decks. Agents carry `A.tier`. Nodes link to same-tier neighbours (diagonals only between two same-tier sides); where a road changes tier between two orthogonal cells of the same road, a portal links them, and the open ground under the first deck cells of a ramp is `T.RAMP` (unwalkable), so every tier change is one unambiguous step; where that foot lies under another street or a building the cell stays as it is and is shadowed (`lvf` 16): the orthogonal step into it from the portal cell is the portal, and `runLayered` never relaxes it from that side. Fields (civ, scent, swim) run over ground cells and nodes. A wall or gate cell blocks every tier of its cell and shares its HP; a zone owns every tier over its interior (`zoneId` through the ground cell). Zombies chase, touch and infect only on their own tier; armed humans on the ground or a deck shoot anyone above ground, in a tunnel only along it; placed units, boats and aircraft target the ground and decks, never tunnels. Each road's deck nodes form structures of at most 300 m appended to `grid.bridges` (HP × `decks.hpMul`, explosives × `bridge.explosiveMul`): a fallen deck kills the people on it (swimmers over water drop in) and turns the land under it to rubble; stage start rebuilds it. A blast hits only its own tier when smaller than `decks.bigBlastR`, else the ground and every deck; tunnels only from inside or with `allTiers` (nuke). Orders work on every tier: a move goes to `orderTier` (the top surface at the point; `low: true` in the order, sent for Alt or faded decks, takes the tier under it; a click on unwalkable ground over a tunnel takes the tunnel); formation slots spread over links from the target node (`rec.ht` per member) and march fields include the window's nodes (`decks.js windowGraph`, a local graph shaped like grid.deck for runLayered and stepField). Ground vehicles path with a layered A* over the same window graph; `v.tier` follows the path and crush, scratches, boarding and pickups use it; armour, buses, medevacs and paratroopers called onto a deck land on it; a vehicle on a falling deck is destroyed. The bulldozer stays on the ground. Gate checks flood every tier the gate crosses and keep the best opening. Paratroopers land on a deck under them. Rail with heights is scenery (no nodes; trains hide in tunnels and run over viaducts).

### 2.3 Player tools (money)
- **Budget**: money cap for the stage = (moneyBase + moneyMax·C/(C+moneyHalf)) × difficulty. "Spent" = sum of what every current placement cost. Refunds are 100% during planning, `battleRefund` (0) during battle. Sandbox = unlimited.
- **Safe zone** (key B): click corners (≥3), Enter or click the first corner to close. Right-click-drag a corner to edit it in planning. Cost = $100 (first `freeZones` components skip the $100) + wall cost of its perimeter. Overlapping/touching zone polygons merge into one zone (a component) — that is how you extend a zone. Max `maxZones` components; total zone land ≤ `maxLandFrac` of the stage's land. Walls are the boundary cells of each component; interior is the rest.
  - A building counts as **inside** a zone when ≥ 50% of its cells are interior (100% for buildings ≥ `bigBldgArea` m²).
  - Units inside a non-breached zone: unlimited reloads (except turrets: never reload unless a Supply aura), normal cost, fire immediately. Outside: cost × `outsideCostMul`, finite reloads, start firing only `outsideStartDelay` s after READY.
  - **Breach**: a zone is breached the moment a zombie stands on its interior. Breached for the rest of the stage: civilians inside panic; units inside lose unlimited reloads (keep `reloads` base count from then on); militia buildings fire their conversion.
  - **Wall upgrade**: per zone, levels 1–3 (HP × 1/2/3), cost `wall.levelCost`.
- **Wall** (key N): standalone polyline walls, $25 + $0.75/m, `wall.hp` per cell. Total standalone length ≤ 300 m + 100 m per stage index.
- **Gate** (key G): click a wall cell of your zone; makes a `gate.width` gap that civilians and friendly units pass and zombies attack (`gate.hp`). **A zone with no gate cannot be entered** — civilians go to the nearest zone they can reach.
- **Evac corridor** (key Q): click-drag a box from tail to arrow head; mouse wheel changes width. Cost $30 + area × perM2. Persistent until refunded.
- **Hold** (key E): click-drag outer radius; inner circle = innerFrac. Cost $20 + area × perM2. Refunding mid-battle gives nothing.
- **Units** (number keys 1–7 = loadout slots): see `config.units`. Mounts: building (one unit per building; garrison price/range scale with building height; **paint mode** (P) drag over buildings to place on every building swept), ground, water (battleship: water body ≥ minWaterM2; boats: see below), brush (mines/chemical painted per cell; water mines on water cells), line (spikes/oil drawn), building|bridge (C4; detonate manually from its card or key D). Some unit costs grow with how many you already own (`cost: (world, n) => …`).
- **Boats** (`boat: true`, `js/sim/naval.js`): patrol boat, gunboat, rocket barge, evac ferry. Placed on open water; each sails the connected water (plus bridge cells) of the stage it starts on, which must be ≥ its `minWaterM2` inside the stage. Each live boat unit is a commandable vehicle (id 1e7 + unit id) kept in step with its unit on every board change; the unit's mooring is what is saved, and boats return to it at each stage start. Swimmers tear at the hull; a sunk boat is a lost unit. The ferry boards residents on the shore (counted as evacuated) and unloads at a zone on the water or along water that leaves the map.
- **Troop orders** (battle only): left-drag or click selects own squads (any armed group) and commandable vehicles (boats, APC, tank); Shift adds or drops, double-click takes every squad of that kind on screen. Right-click or M then click = move (squads march as a group down a local flow field into formation slots and hold there), H hunt, K hold, Z back to the nearest own gated zone (boats go back to their mooring and armour to its drop point, so only squads need a zone). Orders are the `order` command; selection is client state only.
- **Upgrade** (key U, click or drag over units; or the card's Upgrade button): levels 1→5, each level raises one stat per `ups`; cost = base cost × 1.5^(level−1). Upgrade tiers above 2 must be unlocked (campaign); sandbox: all.
- **Refund** (key X): click one placement, or drag a box → a panel lists counts per type with checkboxes → refund selected.
- **Undo** Ctrl+Z (planning only, single player): reverts the last placement action.
- **Views**: V = colour buildings by height (snipers/garrisons want tall roofs), C = highlight special buildings with labels, R = range rings of all units. Hover shows a tooltip; click selects and opens the info card.

### 2.4 Special buildings
Map buildings of kind civic / trade / armory / rescue are specials (hazard = explodes). A special's **function** can only be chosen while it is inside a safe zone (card shows the options; choosing is free; it stays assigned while inside). Each special stacks independently. Functions and numbers: `config.functions`.
- Civic: **Police** (spawns 1 officer every 2 s up to 100 total, not replaced; stance Pursue/Hold toggle), **Militia** (when the zone is breached, 35% of civilians within 200 m become militia fighters — they no longer count as saved), **Broadcast** (civilians within 600 m head to the nearest gate of any zone), **Radio** (+50% range for units within 250 m).
- Commerce: **Budget** (units placed in this zone cost 20% less), **Reduced cost** (units placed within 47 m cost 60% less), **Repair** (this zone's walls regain 40 HP/s).
- Arsenal: **Supply** (reload time −50% within 250 m; lets turrets restock), **Command post** (+30% fire rate within 250 m).
- Relief: **Medic** (cures TURNING civilians within 80 m inside the zone; heals armed humans), **Airlift** (every 20 s evacuates 5 civilians from the zone — removed and counted as saved).

### 2.5 Abilities (command points, SP)
- SP for the stage = (spBase + spPerLevel × stageIdx + spPerSqrt10k × ⌊√(C/10000)⌋) × difficulty. In the **loadout** (Tab) the player buys charges: each charge costs the ability's `sp`. SP can be reassigned freely before READY.
- In battle an ability is usable once `unlock` seconds have passed since READY; effect lands after `delay`. Targeting per `target`. Ability buttons show charges, an unlock countdown and a delivery countdown marker on the map.
- Full list and numbers: `config.abilities` (paratroopers 20-man squads with Hunt/Guard; call to arms arms civilians in a drawn circle; seek & destroy empties a garrison into police; APC; security bus picks up 400 and drives off-map = saved; medevac picks up 200; bulldozer crushes along a line and clears rubble; rally; controlled demolition topples a building with domino; fire bomb; cruise missile; helicopter hunts until out of ammo, flies to the map edge to rearm, comes back; gas bomb stuns; tank; airstrike = 6 bombs along a drawn line; cluster bomb; gunship orbits 60 s; cure turns zombies in a circle back into civilians; nuke after 45 s, radius 1980 m, kills everything in the core, falloff outside, flash + brief slow-motion).
- **Friendly fire**: aimed attacks (abilities, C4) hurt civilians/soldiers and damage walls/buildings/bridges. Automatic weapons never hurt humans (config `friendlyFire.auto=false`) but heavy shells still chip walls/buildings at `autoStructureMul`.

### 2.6 Win / lose / score
- **Win**: every zombie and turning civilian is dead. Softlock: if no zombie can reach any human (scent field unreachable at all zombie cells) for `softlockSec`, the stage is won and leftovers vanish.
- **Lose**: the moment civilians alive (type CIV, any state, incl. evacuated/airlifted) < `loseBelowPct`% of the stage's spawned civilians.
- **Score** = % of the stage's civilians saved (alive CIV + evacuated at the end; militia excluded). Badge = highest tier in `config.badges` whose `min(stageIdx)` ≤ score (tiers with `minPop` only if C ≥ minPop).
- Result card: big rubber-stamp badge, % saved, civilians saved/lost, zombies killed, per-unit-type table (count, kills, $ spent, $ per kill), time, best-so-far; buttons NEXT STAGE / RETRY / MAP SELECT.

### 2.7 Modes, progression, meta
- **Campaign**: 6 fictional cities (generated from fixed seeds, `js/map/campaign.js`), each 4–7 stages. City N+1 unlocks when every stage of city N has bronze or better. Clearing stages unlocks items per `campaign.js` unlock table (units, abilities, upgrade tiers 3–5). Loadout has 7 unit slots.
- **Free Play**: any map (generated, real-place import, library). Mutators allowed. Uses everything unlocked, plus every boat (`FREE_PLAY_ITEMS` in `js/map/campaign.js`); the campaign issues the patrol boat and water mines from the start and the ferry, gunboat and rocket barge later.
- **Daily Challenge**: a generated city + 2 mutators seeded by the date (YYYYMMDD); best result per day kept.
- **Sandbox**: unlimited money/SP, everything unlocked, not recorded.
- **Difficulty**: Normal / Hardcore / Ultra (multipliers in config). On campaign maps Hardcore and Ultra unlock after finishing the campaign; on custom maps they are open from the start.
- **Records**: local best % and badge per map / stage / difficulty; 14 achievements (our own names) in `js/meta/achievements.js`; Flawless = whole campaign city without a single loss (retry voids it).
- **Mutators ("mods")**: list of `path=value` override lines over config; later lines win. Built-in presets + a text editor to write your own; saved in the library.

### 2.8 Maps, import, editor, library
- **Generated city**: seed, size (1–10 km), water (none/river/coast/lake/islands), density, bridge count, stage count (3–7), `motorways` (default on; campaign cities pass false). Above 6 km the generator lays out a metro area (core sized like a 5 km city, satellite centres, orbital road, second railway, green belt); 6 km and less are generated exactly as before apart from the motorway. From 3 km a motorway (two from 6 km) crosses the sheet, raised (z 1, 90 m ramps) ±140 m around every crossing with a main road, the railway, water and the other motorway (which goes to z 2 there), over the whole inner city, and between raised stretches closer than 350 m; at-grade stretches cut the local streets. One lone main-road crossing becomes an underpass (the main road at z −1 for ±40 m, 70 m ramps), one or two get diamond interchanges (four 8 m slip roads, z 1 → 0 over 160 m, ending on the main road).
- **Real place import**: type a place / postcode / "Street & Street, City" → Nominatim search (pick from results) → choose square size (0.5–10 km; over 2 km fetched as 2 km tiles, at most 2 requests in flight, received tiles shaded on the picker) → Overpass API fetch of roads (incl. paths, rail, bridges, tunnels), buildings (height from `height`/`building:levels`, class from tags), water (areas, riverbanks, rivers/canals as buffered lines, coastline best-effort), parks (leisure/landuse green). Heights (`js/map/osmlevels.js`): `bridge` → z clamp(max(1, layer), 1, 3); `tunnel` → clamp(min(−1, layer), −2, −1); covered ways and building passages ground; indoor ways, `level` ≠ 0 and parking aisles below ground dropped; bridge ways joined into chains at shared end nodes; a chain crossing another way is a deck, one over water only a level-0 `k:'bridge'`, one over nothing a road; `*_link` (and raised) ways meeting a deck end slope along their length, else the chain ramps over clamp(L/4, 24, 40) m; rail bridges +1, rail tunnels and subway −1 (scenery). Converted into MapData with auto stages around the centre. Big maps show a lag warning. Respect API etiquette: user-triggered only, one request at a time, `timeout`, show attribution "© OpenStreetMap contributors".
- **Editor**: blank / generated / imported start. Tools: road (nodes, width, kind incl. bridge/path/rail, level, ramps, node heights; inserted nodes interpolate z, removed ones drop it, resize clips it), building (polygon/rect, height, use, class), water and park (node polygons), erase, select/move/edit properties, stage boundaries (per-stage polygon), outbreak hint points (optional), map settings (name, author, welcome message, colour preset: Paper / Blueprint / Night Print). Test Play button. Save to library, export file.
- **Library** (the "workshop"): local IndexedDB library of maps, mutators and scenarios (map + mutators + difficulty). Sort: newest / name / size / favourite; search; favourite toggle; export `.rcmap.json` / import file; share code (gzip+base64url via CompressionStream) copy/paste.

### 2.9 Co-op (2 players)
Deterministic lockstep over WebRTC DataChannel with copy-paste signalling codes (no server; STUN `stun:stun.l.google.com:19302`). Host picks the map. Money and SP split evenly. Each player owns their units/zones/walls; gates only on own walls; can garrison buildings inside a partner's zone but not edit its walls. Partner cursor shown. READY needs both; any board change cancels the other player's READY.

### 2.10 Controls (rebindable, stored in settings)
Space READY / pause · `,` `.` slower/faster · L fade decks · B safe zone · N wall · G gate · Q corridor (wheel = width) · E hold · 1–7 loadout units · F1–F8 or Shift+1–8 abilities · Tab loadout · U upgrade · X refund · P paint mode · D detonate selected C4 · left drag / click select troops (no tool), right-click move them · M / H / K / Z move / hunt / hold / back to zone · V heights · C specials · R ranges · Ctrl+Z undo · Enter close zone / next stage · Esc cancel / pause menu · WASD/arrows pan · drag middle or right mouse to pan · wheel zoom · Home fit stage.

---------------------------------------------------------------------------------------------------
## 3. Architecture

### 3.1 Files and owners (each builder writes ONLY its files)
```
index.html                    SHELL
css/base.css                  SHELL (tokens, typography, generic components: .card, .btn, .tab, .stamp, .table, .field)
css/game.css                  CLIENT (in-game HUD)
js/main.js                    SHELL (boot + screen manager)
js/util/rng.js geom.js        (exists) ; js/util/events.js, compress.js  -> SIM writes events.js, MAP writes compress.js
js/data/config.js             (exists; SIM may add missing keys it needs, never rename)
js/map/format.js              MAP   (constants, validate/normalize/serialize MapData)
js/map/citygen.js             MAP
js/map/osm.js osmlevels.js    MAP   (osmlevels.js: bridge / tunnel heights and ramps)
js/map/campaign.js            MAP   (6 cities + unlock table)
js/map/library.js             MAP   (IndexedDB store + export/import/share codes)
js/sim/raster.js              SIM   (MapData -> Grid)
js/sim/decks.js               SIM   (deck and tunnel nodes, portals, deck structures, tier lookups)
js/sim/world.js               SIM   (World class, command bus, step loop, snapshot/restore, hash)
js/sim/agents.js nav.js zones.js fire.js structures.js level.js economy.js   SIM
js/sim/units.js combat.js abilities.js vehicles.js mutants.js?                 COMBAT (mutants.js stays SIM)
js/render/*.js                CLIENT (palette.js, camera.js, maprender.js, deckrender.js, worldrender.js, fx.js)
js/game/*.js                  CLIENT (session.js, tools.js, hud.js, infocard.js, results.js, refundpanel.js, sfx.js, input.js)
js/ui/*.js                    SHELL (menus, campaign screen, freeplay setup, loadout screen, settings, library UI, import UI, mutator editor, achievements, editor.js)
js/meta/*.js                  SHELL (progress.js, achievements.js, settings.js)
js/net/*.js                   NET   (coop.js: signalling, lockstep)
test/*.mjs                    each builder its own node tests (sim/map/combat are DOM-free and must run in node)
```

### 3.2 Conventions
- ES modules, relative imports with `.js` extensions. No globals except `window.__rc` debug handle (CLIENT sets it to the live session).
- **The sim is DOM-free and deterministic**: only `world.rng` (Rng from util/rng.js) — never Math.random / Date / performance.now inside `js/sim/**`. Fixed tick `cfg.sim.dt`. Every state change from a player goes through `world.exec(cmd)`. Iteration order deterministic. `world.hash()` returns a checksum of agent positions/types + placements for desync checks.
- Coordinates: meters, origin top-left, x east, y south. Grid cell index `i = cy * gw + cx`, cell size `grid.cell` (4 m).
- Performance targets: 40k agents at 60 fps on a desktop at 1×; typed arrays (SoA) for agents, spatial hash rebuilt per tick, fields via bucket-queue Dijkstra on typed arrays, staggered updates (each agent re-plans every N ticks by `i % N`). No per-agent object allocation in hot loops.

### 3.3 MapData (`js/map/format.js`)
```js
{
  format: 'rcmap', v: 1,
  name, author, desc, welcome,            // welcome = message shown when the map starts
  source: 'gen'|'osm'|'editor', seed,      // seed used for outbreaks etc.
  geo: { lat, lon } | null,                // centre for imported maps (attribution shown if set)
  palette: 'paper'|'blueprint'|'night',
  w, h,                                    // meters
  roads:     [{ p: [x0,y0,x1,y1,...], w: widthM, k: 'major'|'minor'|'path'|'rail'|'bridge', name?, z? }],
                                           // z: one height per vertex in tiers (-2..3, steps of 0.1; ramps interpolate);
                                           // dropped when all 0 or bad. A map with z saves as v: 2, one without as v: 1
  water:     [{ p: [...] }],               // polygons
  parks:     [{ p: [...] }],               // polygons
  buildings: [{ p: [...], h: heightM, k: 'res'|'com'|'ind'|'civic'|'trade'|'armory'|'rescue'|'hazard'|'landmark', use: 'Police Station', name? }],
  levels:    [{ p: [...], label? }],       // stage boundaries, nested, 3..7
  spawns:    [[x,y], ...]                  // optional outbreak hint points
}
```
Exports: `T` terrain codes `{OPEN:0, ROAD:1, BLDG:2, WATER:3, BRIDGE:4, PARK:5, RUBBLE:6, RAIL:7, RAMP:8}` (RAMP: the ground under a ramp's first deck cells, unwalkable), `zAt(road, s)`, `clipLineRect(p, ..., z?)`, `hasZ(m)`, `BUILDING_KINDS`, `SPECIAL_KINDS = ['civic','trade','armory','rescue']`, `validateMap(m) -> {ok, errors[]}`, `normalizeMap(m) -> m` (fills defaults, rounds coords to 0.1 m, drops degenerate polys), `serializeMap(m) -> string`, `parseMap(str) -> m`, `mapStats(m) -> {buildings, roads, areaKm2, nominalPop}`, `emptyMap(w,h,name)`.

### 3.4 Grid (`js/sim/raster.js`: `buildGrid(map, cell=4) -> Grid`)
```js
{ cell, gw, gh,
  terrain: Uint8Array,        // T codes. Order: open < park < water < road/rail < bridge(road over water) < building
  bldg: Int32Array,           // building index + 1, else 0
  bridgeId: Int16Array,       // bridge index + 1 on bridge cells
  bInfo: [{ cx, cy, area, h, k, cells: Int32Array, big: bool }],    // per map building
  bridges: [{ cells: Int32Array, len, width, cx, cy, hpMax }],
  waterBodies: { id: Int32Array per cell (0 none), area: [m2 per id] },
  levelMask(idx) -> Uint8Array (1 = inside stage idx boundary), memoised
  deck: null | { N, D, cell, tier, sid, over, road, nb (8 per node: field ids in nav's compass order, -1 none),
                 lvf (per ground cell: 1 deck above, 2 tunnel below, 4 portal, 8 ramp, 16 shadow), portals, pnb, tix/tstore (tile lookup) }
}
// Field ids: ground cell c < N, node k = N + k. Every nav array and field covers N + D ids on maps with decks.
// decks.js: nodeAt(deck, tier, cx, cy), portalOf, stepField, fieldOf(world, i), surfaceAt(world, x, y), deckAt(world, x, y),
//   windowGraph(deck, ox, oy, lw, lh) (local graph of a window: ground ids y * lw + x, nodes after), localOf, orderTier, nearestOnTier.
// bridges[] after the water bridges: { deck: true, road, tier, nodes, cells, len, width, cx, cy, hpMax, bb, s0, s1 }.
```

### 3.5 World (`js/sim/world.js`) — the contract other modules rely on
```js
import { World } from './sim/world.js'
const world = new World(map, { cfg, seed, stage: 0, owners: 1|2, sandbox, difficulty })
world.cfg, world.map, world.grid, world.rng, world.tick, world.t (s since READY; 0 in planning)
world.phase            // 'planning' | 'battle' | 'won' | 'lost'
world.stage, world.stageCount, world.region {poly, bbox, mask}
world.events           // Emitter: on(name, fn) / off / emit. Events: 'log' {msg, kind:'info'|'warn'|'alert', x?, y?},
                       // 'sound' {name, x, y, vol}, 'outbreak' {sites:[[x,y]]}, 'breach' {zoneId}, 'mutation' {x,y,kind},
                       // 'pit' {x,y,endsAt}, 'collapse' {b}, 'bridgeDown' {id}, 'nuke' {x,y,at}, 'stageEnd' {result}, 'changed' {what}
// Agents (SoA). TYPE: FREE 0, CIV 1, ZOMBIE 2, TURNING 3, POLICE 4, MILITIA 5, SOLDIER 6
world.A = { n, cap, x, y, vx, vy: Float32Array, type, sub, state: Uint8Array, hp, timer, panic: Float32Array,
            ammo: Int16Array, owner: Uint8Array, group: Int32Array /*squad / building id / -1*/, home: Float32Array(x2) }
//   sub for ZOMBIE: 0 normal, 1 explosive, 2 shielded, 3 swimmer, 4 giant. For SOLDIER/POLICE stance: state 0 hold/guard, 1 pursue/hunt
//   CIV state: 0 calm, 1 panic, 2 safe, 3 held, 4 corridor, 5 boarding, 6 evacuated(removed, counted saved)
world.spawn(type, x, y, sub=0, tier=0) -> index | -1     world.remove(i)     world.infect(i)    world.damageAgent(i, dmg, src)
world.query(x, y, r, typeMask, fn(i, d2), tier?) world.nearest(x, y, r, typeMask, tier?) -> i|-1   // typeMask = 1<<TYPE
//   tier: TIER_SURFACE (default: ground + decks), TIER_ALL (adds tunnels) or one tier -2..3; all the same on flat maps
world.surfaceAt(x, y) -> top tier at a point      A.tier Int8 (0 ground; always 0 without decks)
world.zombieHp(sub) -> current max hp for that kind (time curve × mutant mul × difficulty)
// Map state
world.buildings[]  { idx, cx, cy, h, area, k, use, name, hp, hpMax, alive, zone (component id or -1), func: null|'police'|..., funcState{}, unitId: -1, burning }
world.bridges[]    { idx, cx, cy, len, width, hp, hpMax, alive }
world.zones        // { polys:[{id, p, owner, paid}], comps:[{id, cells, wallCells, interiorCells, breached, wallLevel, owner, bldgs:[]}], gates:[{id, x, y, comp, cells, hp, hpMax, owner, paid}] }
world.walls[]      { id, p, cells, owner, paid }   // standalone
world.wallHp       Float32Array per cell (0 = no wall / destroyed)
world.block        Uint8Array per cell: 0 none, 1 zone wall, 2 standalone wall, 3 gate
world.zoneId       Int16Array per cell: component id + 1 for interior cells
world.corridors[]  { id, x0, y0, x1, y1, w, owner, paid }      world.holds[] { id, x, y, R, r, owner, paid }
world.fire         Float32Array coarse grid (cfg.sim.coarse) intensity 0..1
world.units[]      // owned by COMBAT: { id, type, x, y, b (building idx|-1), bridge, owner, level, paid, hp, hpMax, mag, ammo, reloads, reloadT, cd, kills, alive, … }
world.projectiles[] // COMBAT pushes { kind: 'tracer'|'shell'|'rocket'|'rail'|'bomb'|'missile', x0,y0, x1,y1, t0, dur } (t in world.t seconds); render interpolates
world.effects[]    // anyone pushes { kind: 'boom'|'flash'|'gas'|'fireburst'|'collapse'|'splash'|'nuke'|'plane'|'heli'|'drop', x, y, r, t0, dur, x2?, y2? }
world.vehicles[]   // COMBAT: { id, kind: 'apc'|'bus'|'medevac'|'bulldozer'|'tank'|'heli'|'gunship'|'plane'|<boat unit type>, x, y, heading, hp, hpMax, alive,
                   //   tier (0 ground, 1..3 deck, -1/-2 tunnel), commandable?, order?: { kind, x, y, t, done, tier? }, … }
world.budget { cap, spent }  world.sp { cap, spent }  world.charges { [abilityId]: n }  world.loadout { units:[7 ids], abilities:{id:n} }
world.stats { civStart, civAlive, civSafe, civEvac, civDead, zombies, turning, killed, killsBy: {key: n}, spentBy: {key: $} }
// Commands — ALL player actions:
world.exec({ t: 'zone.add', p, owner }) -> { ok, reason?, id? }    // reasons are short human strings shown in the HUD
//   built-in (SIM): zone.add, zone.remove, zone.move (id, p), zone.upgrade (compId), gate.add (x,y), gate.remove, wall.add (p), wall.remove,
//   corridor.add (x0,y0,x1,y1,w), corridor.remove, hold.add (x,y,R), hold.remove, func.set (b, func), stance.set (group|b, stance),
//   ready, speed (s), refund.many ({kind:[ids]}), loadout.set ({units, abilities})
//   COMBAT registers: unit.place (type,x,y), unit.paint (type, cells or path), unit.upgrade (id), unit.refund (id), unit.detonate (id),
//   ability.use (id, x, y, x2?, y2?), squad.mode (group, mode)
//   ORDERS (sim/orders.js): order (refs: ['s<group>', 'v<vehicle id>'], kind: 'move'|'hunt'|'hold'|'return', x?, y?, low?)
world.registerCommand(name, handler(world, cmd) -> result)
world.registerSystem({ name, update(world, dt), order })  // COMBAT registers its systems; SIM's own run in fixed order
world.quote(cmd) -> { cost, ok, reason }    // price/validity preview without applying (tools use it for the cursor label)
world.step()            // one tick (dt = cfg.sim.dt); no-op unless phase === 'battle'
world.beginStage(idx)   // spawn civilians, recompute caps, keep placements; phase = 'planning'
world.snapshot() -> obj / world.restore(obj)  // placements + loadout + funcs (+ COMBAT units via registered serializer)
world.registerSerializer(name, {save(world), load(world, data)})
world.hash() -> uint32
world.costMul(x, y, owner) -> multiplier (zone / outside / budget / reducedCost auras) for unit pricing
world.inZone(x, y) -> compId|-1 (non-breached interior)     world.buildingInZone(bIdx) -> compId|-1
world.damageArea(x, y, r, dmg, { src, friendly:bool, bldgDmg, bridgeDmg, wallDmg, stunSec, fire, falloff:true })
world.damageBuilding(bIdx, dmg, src, dir?)   world.damageBridge(id, dmg)   world.damageWallsArea(x, y, r, dmg)   world.ignite(x, y, r, intensity)
world.collapseBuilding(bIdx, dirX, dirY)
world.addKill(srcKey, n=1)   // srcKey like 'garrison', 'ability:airstrike', 'police', 'militia', 'fire'
```

### 3.6 COMBAT module API (`js/sim/units.js`, `abilities.js`, …)
```js
import { installCombat } from './sim/units.js'   // installCombat(world): registers commands, systems, serializer
unitCost(world, type, x, y, owner) -> $          canPlace(world, type, x, y, owner) -> { ok, reason, b?, bridge? }
unitRange(world, unit) -> m                      unitStats(world, unit) -> { dmg, rof, range, mag, reloads, reloadSec, … with auras }
upgradeCost(world, unit) -> $ | null (max / locked)       nextUpgradeStat(unit) -> ['range', 1.2] | null
abilityState(world, id) -> { charges, unlockIn, ready }   ABILITY_INFO / UNIT_INFO: display names + one-line descriptions
```
Squads (paratroopers etc.) are SOLDIER agents sharing `group`; SIM's armed-agent behaviour handles moving/shooting (guard = hold near home, hunt = pursue within leash). Vehicles/aircraft are COMBAT objects in `world.vehicles`.

### 3.7 CLIENT API (`js/game/session.js`)
```js
import { Session } from './game/session.js'
const s = new Session(containerEl, { map, mode: 'campaign'|'free'|'daily'|'sandbox'|'test'|'coop', difficulty, mutators: [lines],
                                     loadout, campaign: {cityId}?, startStage: 0, net?: CoopLink,
                                     onExit(summary), onStageResult(result), openLoadout(world, done) })
s.start(); s.destroy();
```
The session owns: World + combat install, rAF loop (fixed-step accumulator × speed × `sim.baseSpeed`; a per-frame sim time budget keeps frames near 50 fps (the top step about 45 fps, so it never runs fewer ticks than the step below), an even tick count per frame chosen from the tick cost averaged over about ten frames, and owed time that does not fit is dropped; the HUD shows the speed reached when it falls short), renderer, input/tools, HUD, info card, result card, pause menu (Resume / Retry stage / Settings / Quit). It emits results to the shell via callbacks; the shell records progress. `maprender.drawStatic(ctx, map, grid, camera, opts)` and `Camera` are reused by the editor.

### 3.8 SHELL
`main.js` screens: Title → Campaign (city list on a desk map, stage stamps) / Free Play (Generated · Real place · Library tabs + mutators + difficulty) / Daily / Sandbox / Co-op lobby / Library / Editor / Settings / Achievements / Credits (OSM attribution). Loadout screen (`ui/loadout.js`, also opened in-game via Tab through `openLoadout`): 7 unit slots from unlocked units, ability charges with SP counter, locked items show what unlocks them.
`meta/progress.js`: `getProgress()`, `recordResult({mapKey, stage, difficulty, pct, badge, lost})`, `isUnlocked(id)`, `unlockAll(flag)`, `getLoadout()/setLoadout()`. `meta/settings.js`: keybinds, volume, popScale (feeds `population.scale`), autoPauseOnOutbreak, showTips, uiScale.

### 3.9 NET (`js/net/coop.js`)
`createHost()` / `joinWithCode(code)` → `CoopLink { role, offerCode, acceptAnswer(code), send(msg), onMessage, close }`. Lockstep: commands stamped `tick + INPUT_DELAY(4)`; each tick both peers wait for the other's (possibly empty) command batch; speed/pause are commands; each turn runs speed × `sim.baseSpeed` ticks, spread over the turn's real time within the frame budget; the peer that gets ahead slows its clock, so the slower machine sets the pace; `world.hash()` exchanged every 60 turns → desync banner.
