// Credits and sources (colophon).
import { OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL } from '../map/osm.js';
import { h } from './dom.js';
import { screenFrame } from './screen.js';

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

export function mount(root, app) {
  const frame = screenFrame({ form: 'OCP-0', title: 'Credits', sub: 'Colophon and sources', onBack: () => app.go('title') });
  root.appendChild(frame.el);
  const sec = (no, title, ...kids) => h('section.cred-sec', h('div.cred-head', h('span.cred-no', no), h('h2.h3', title)), ...kids);
  frame.body.appendChild(h('div.credits',
    h('div.cred-col',
      sec('01', 'Remain Calm',
        h('p', 'Municipal Outbreak Response. A city outbreak planning game written in plain JavaScript modules: no libraries, no build step, no image or sound files. Every map, stamp and sound is drawn or synthesised in the browser.'),
        h('p.small.muted', 'Cities, residents and incidents are fictional. Any resemblance to a real municipal office is coincidental.')),
      sec('02', 'Map data',
        h('p', 'Real-place maps are built from ', link(OSM_ATTRIBUTION_URL, OSM_ATTRIBUTION), ', available under the Open Database Licence.'),
        h('p.small', 'Place search uses the ', link('https://nominatim.org/', 'Nominatim'), ' service; map data is fetched from the ', link('https://overpass-api.de/', 'Overpass API'), ' and its public mirrors, one request at a time and only when you ask.'),
        h('p.small.muted', 'Imported maps keep the attribution wherever they are shown, shared or exported.')),
      sec('03', 'Type',
        h('p', link('https://fonts.google.com/specimen/IBM+Plex+Mono', 'IBM Plex Mono'), ' by Mike Abbink and Bold Monday for IBM, and ', link('https://fonts.google.com/specimen/Archivo+Narrow', 'Archivo Narrow'), ' by Omnibus-Type. Both under the SIL Open Font Licence, served by Google Fonts with system fallbacks when offline.'))),
    h('div.cred-col',
      sec('04', 'Co-operative play',
        h('p.small', 'Two offices connect browser to browser over WebRTC. Connection codes are exchanged by hand; a public STUN server (stun.l.google.com) helps the browsers find each other. No game server sees your session.')),
      sec('05', 'Storage',
        h('p.small', 'Progress and settings live in this browser’s local storage; the library uses IndexedDB. Nothing is uploaded. Export files or share codes to move items between machines.')),
      sec('06', 'Controls',
        h('p.small', 'Every battle key can be changed in Settings. Esc returns to the directory from any menu screen.')),
      h('div.cred-seal', h('div.seal', { style: { '--size': '8rem', '--tier': 'var(--stamp)', '--rot': '-10deg' } }, h('small', 'Printed by'), 'O.C.P.', h('small', 'Varrow'))))));
  return {};
}
