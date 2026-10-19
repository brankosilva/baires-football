/* Weekly match alert — builds a markdown report of this week's Buenos Aires
   matches that Pibe de Barrio sells, with live prices, and writes it to the
   file given as argv[2] (or stdout). Run every Monday by
   .github/workflows/weekly-matches.yml, which posts it as a GitHub issue
   (GitHub then emails it).

   The ESPN / Shopify / FX logic mirrors index.html (isBAVenue, priceForFixture)
   so the alert and the website always agree. Prices are always fetched live. */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TZ = 'America/Argentina/Buenos_Aires';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const LEAGUES = {
  'arg.1':                 { name: 'Liga Profesional',  domestic: true  },
  'conmebol.libertadores': { name: 'Copa Libertadores', domestic: false },
  'conmebol.sudamericana': { name: 'Copa Sudamericana', domestic: false },
};
const PIBE_PRODUCTS_URL = 'https://pibedebarrio.com/products.json?limit=250';
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';
const SITE_URL = 'https://baires-football.com/';
const DAYS_AHEAD = 7;

const BA_VENUE_KEYS = [
  'bombonera','monumental','bidegain','cilindro','libertadores de am',
  'duco','palacio','amalfitani','fortín','fortin','hirschi','estadio uno',
  'nestor diaz','néstor díaz','maradona','zerillo','bosque',
  'tomaghello','florencio sol','dellagiovanna','coloso','bielsa',
  'gigante','arroyito','gasometro','chiqui tapia',
];
const BA_CITIES = [
  'buenos aires','avellaneda','lanus','lanús','la plata',
  'quilmes','banfield','florencio varela','tigre','hurlingham',
  'lomas de zamora','san justo','morón','moron',
];
const NON_BA_DOMESTIC_CITIES = [
  'rosario','córdoba','cordoba','mendoza','tucumán','tucuman',
  'salta','santa fe','santiago del estero','san juan','mar del plata',
  'neuquén','neuquen','resistencia','corrientes','posadas','paraná','parana',
];
const PRICE_EXCLUDE_RE = /wagon|trip|tour|magazine|guide|waitlist|matchpack|weekend|copa argentina|ascenso|private/i;
const NAME_STOPWORDS = new Set(['de','del','la','los','las','y','club','atletico','deportivo']);

function isBAVenue(venue, isDomestic) {
  const name = (venue?.fullName || '').toLowerCase();
  const city = (venue?.address?.city || '').toLowerCase();
  if (BA_CITIES.some(c => city.includes(c))) return true;
  if (BA_VENUE_KEYS.some(k => name.includes(k))) return true;
  if (isDomestic && (venue?.address?.country || '') === 'Argentina') {
    return !NON_BA_DOMESTIC_CITIES.some(c => city.includes(c));
  }
  return false;
}

const normTeam = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const teamTokens = name => normTeam(name).split(' ').filter(w => w.length >= 4 && !NAME_STOPWORDS.has(w));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/* "YYYY-MM-DD" of an instant as seen in Buenos Aires */
const baDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

function monthsToQuery(from, to) {
  const out = new Set();
  for (const d of [from, to]) {
    const [y, m] = baDay(d).split('-');
    out.add(`${y}${m}`);
  }
  return [...out];
}

async function loadFixtures(from, to) {
  const months = monthsToQuery(from, to);
  const fromDay = baDay(from), toDay = baDay(to);
  const fixtures = [];
  for (const [slug, meta] of Object.entries(LEAGUES)) {
    for (const m of months) {
      const json = await getJson(`${ESPN}/${slug}/scoreboard?dates=${m}&limit=200`);
      for (const e of json.events || []) {
        const comp = e.competitions?.[0];
        if (!comp || !isBAVenue(comp.venue, meta.domestic)) continue;
        if (comp.status?.type?.state !== 'pre') continue;
        const day = baDay(new Date(e.date));
        if (day < fromDay || day > toDay) continue;
        const home = comp.competitors.find(c => c.homeAway === 'home') || comp.competitors[0];
        const away = comp.competitors.find(c => c.homeAway === 'away') || comp.competitors[1];
        fixtures.push({
          league: meta.name, date: new Date(e.date),
          home: home?.team?.displayName || '—', away: away?.team?.displayName || '—',
          homeLogo: home?.team?.logo || '', awayLogo: away?.team?.logo || '',
          venue: comp.venue?.fullName || '',
          city: comp.venue?.address?.city || '',
        });
      }
    }
  }
  return fixtures.sort((a, b) => a.date - b.date);
}

/* Pibe de Barrio lists what each experience includes under an "Includes"
   heading (a <ul>), and it differs per product (standing section, public
   transport, return transport...). Read it live instead of hardcoding it. */
function parseIncludes(html) {
  const strip = s => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const items = [];
  const m = html.match(/Includes<\/[^>]+>(?:\s*<\/[^>]+>)*\s*<ul>([\s\S]*?)<\/ul>/i);
  if (m) for (const li of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) { const t = strip(li[1]); if (t) items.push(t); }
  if (!items.length) {
    /* Fallback for pages whose markup differs (e.g. River's): take every list
       item between the "Includes" heading and "What you need". */
    const block = html.match(/Includes[\s\S]*?What you need/i);
    if (block) for (const li of block[0].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) { const t = strip(li[1]); if (t) items.push(t); }
  }
  const text = strip(html);
  if (/includes public transport/i.test(text) && !items.some(i => /transport/i.test(i))) items.push('Public transportation included');
  if (/includes return transport/i.test(text) && !items.some(i => /return transport/i.test(i))) items.push('Return transport with the group');
  return items;
}

const INCLUDE_I18N = [
  [/beer\/soft drink/i,        '🍺🍔 Cerveza o gaseosa + hamburguesa o choripán', '🍺🍔 Beer or soft drink + a burger or choripán'],
  [/match ticket.*standing/i,   '🎟️ Entrada al partido, sección de pie: el mejor ambiente', '🎟️ Match ticket, standing section for maximum atmosphere'],
  [/match ticket/i,             '🎟️ Entrada al partido', '🎟️ Match ticket'],
  [/bilingual guide/i,          '🗣️ Guía bilingüe: traduce, responde tus preguntas y cuida que todos estén seguros', '🗣️ Bilingual guide: translates, answers your questions and keeps everyone safe'],
  [/return transport/i,         '🚌 Traslado de ida y vuelta con el grupo', '🚌 Return transport with the group'],
  [/public transport/i,         '🚇 Transporte público incluido', '🚇 Public transportation included'],
];
function includeLines(includes) {
  const es = [], en = [];
  for (const raw of includes) {
    const clean = raw.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, '').replace(/\s+/g, ' ').trim();
    const hit = INCLUDE_I18N.find(([re]) => re.test(clean));
    es.push(hit ? hit[1] : `• ${clean} (sin traducir)`);
    en.push(hit ? hit[2] : `• ${clean}`);
  }
  return { es, en };
}

/* Conditions that live in the product page text: minimum group size, ID
   requirement and where the group meets. Read live, like the Includes list. */
function parseMeta(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;nbsp;|&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const min = text.match(/minimum of (\d+) guests/i);
  const meet = text.match(/Our group will meet ([^.]*)\./i);
  return {
    minGuests: min ? +min[1] : null,
    needsId: /national photo id/i.test(text),
    meeting: meet ? meet[1].trim() : null,
  };
}

async function loadProducts() {
  const json = await getJson(PIBE_PRODUCTS_URL);
  return (json.products || [])
    .filter(p => !PRICE_EXCLUDE_RE.test(p.title))
    .map(p => ({
      title: p.title,
      includes: parseIncludes(p.body_html || ''),
      meta: parseMeta(p.body_html || ''),
      variants: (p.variants || [])
        .map(v => ({ title: v.title, price: parseFloat(v.price) || null, available: !!v.available }))
        .filter(v => v.price),
    }))
    .filter(p => p.variants.length);
}

/* Every variant of the home team's product that belongs to this opponent,
   plus that product's "Includes" list */
function variantsForFixture(products, home, away) {
  const nt = normTeam(home);
  const out = { variants: [], includes: [], meta: {} };
  if (!nt) return out;
  const tokens = teamTokens(away);
  for (const p of products.filter(p => normTeam(p.title).startsWith(nt))) {
    for (const v of p.variants) {
      const matches = tokens.length
        ? tokens.some(tok => normTeam(v.title).includes(tok))
        : p.variants.length === 1;
      if (matches) { out.variants.push(v); if (!out.includes.length) { out.includes = p.includes; out.meta = p.meta; } }
    }
  }
  return out;
}

const fmtDate = (d, locale, opts) => new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).format(d);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const priceLine = (eur, fx) => `€${Math.round(eur)} · ${Math.round(eur * fx)} USD`;

const variantLabel = (v, lang) => {
  const raw = v.title.split(' / ').pop();
  if (/seated/i.test(raw)) return lang === 'es' ? 'La entrada numerada' : 'Seated tickets';
  if (/standing/i.test(raw)) return lang === 'es' ? 'La entrada de pie' : 'Standing tickets';
  return raw;
};

function copyFor(f, cheapest, soldOutOthers, includes, meta, fx) {
  const inc = includeLines(includes);
  const hasList = inc.es.length > 0;
  const isSeated = /seated/i.test(cheapest.title);
  const dayEs = cap(fmtDate(f.date, 'es-AR', { weekday: 'long', day: 'numeric', month: 'long' })).replace(',', '');
  const timeEs = fmtDate(f.date, 'es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayEn = fmtDate(f.date, 'en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const timeEn = fmtDate(f.date, 'en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const price = priceLine(cheapest.price, fx);
  const warn = (!hasList || isSeated)
    ? `> ⚠️ Revisá en pibedebarrio.com qué incluye esta variante (${isSeated ? 'es la entrada numerada' : 'no pude leer la lista de "Includes"'}) antes de usar la lista de abajo.\n\n`
    : '';
  const soldEs = soldOutOthers.length ? `\n(${soldOutOthers.map(v => variantLabel(v, 'es')).join(', ')}: agotada.)` : '';
  const soldEn = soldOutOthers.length ? `\n(${soldOutOthers.map(v => variantLabel(v, 'en')).join(', ')}: sold out.)` : '';
  const listEs = hasList ? inc.es.join('\n') : '(completar a mano)';
  const listEn = hasList ? inc.en.join('\n') : '(fill in by hand)';
  const condEs = [meta?.needsId && '🪪 Llevá tu documento de identidad con foto (original, no copia ni captura).',
                  meta?.minGuests && `⚠️ La salida se hace con un mínimo de ${meta.minGuests} personas.`].filter(Boolean).join('\n');
  const condEn = [meta?.needsId && '🪪 Bring your photo ID (original, not a copy or screenshot).',
                  meta?.minGuests && `⚠️ The trip goes ahead with a minimum of ${meta.minGuests} guests.`].filter(Boolean).join('\n');
  const meetNote = meta?.meeting ? `\n> 📍 Punto de encuentro (de la ficha, en inglés): _our group will meet ${meta.meeting}_ — sumalo al copy.` : '';
  return `${warn}\`\`\`
⚽ ${f.home.toUpperCase()} vs ${f.away.toUpperCase()}
🏆 ${f.league}
📅 ${dayEs} · ${timeEs} hs
🏟️ ${f.venue}, ${f.city || "Buenos Aires"}

✅ INCLUYE:
${listEs}${condEs ? '\n\n' + condEs : ''}

💶 ${price}${soldEs}

📲 Reservá tu lugar en ${SITE_URL}

🇬🇧 EN
⚽ ${f.home} vs ${f.away}
🏆 ${f.league}
📅 ${dayEn} · ${timeEn}
🏟️ ${f.venue}, ${f.city || "Buenos Aires"}

✅ INCLUDES:
${listEn}${condEn ? '\n\n' + condEn : ''}

💶 ${price}${soldEn}

📲 Book now: ${SITE_URL}
\`\`\`${meetNote}`;
}

async function main() {
  const from = new Date();
  const to = new Date(from.getTime() + (DAYS_AHEAD - 1) * 86400000);
  const [fixtures, products, fxJson] = await Promise.all([
    loadFixtures(from, to), loadProducts(), getJson(FX_URL),
  ]);
  const fx = fxJson.rates?.USD;
  if (!fx) throw new Error('No EUR/USD rate available');

  const onSale = [], soldOut = [];
  for (const f of fixtures) {
    const { variants, includes, meta } = variantsForFixture(products, f.home, f.away);
    const avail = variants.filter(v => v.available).sort((a, b) => a.price - b.price);
    if (avail.length) onSale.push({ f, variants, includes, meta, cheapest: avail[0] });
    else if (variants.length) soldOut.push({ f, variants });
  }
  const notOffered = fixtures.length - onSale.length - soldOut.length;

  const range = `${fmtDate(from, 'es-AR', { day: 'numeric', month: 'long' })} – ${fmtDate(to, 'es-AR', { day: 'numeric', month: 'long' })}`;
  let md = `# ⚽ Partidos de la semana en Buenos Aires (${range})\n\n`;
  md += `Precios en vivo de Pibe de Barrio · 1 EUR = ${fx} USD (${fxJson.date}).\n\n`;

  if (!onSale.length) {
    md += '**Esta semana no hay partidos con entradas disponibles.**\n\n';
  } else {
    md += `## ✅ Con entradas disponibles (${onSale.length})\n\n`;
    md += '| Partido | Torneo | Cuándo | Estadio | Precio | Variante |\n|---|---|---|---|---|---|\n';
    for (const { f, cheapest } of onSale) {
      const when = `${cap(fmtDate(f.date, 'es-AR', { weekday: 'short', day: 'numeric', month: 'short' }))} ${fmtDate(f.date, 'es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
      md += `| **${f.home} vs ${f.away}** | ${f.league} | ${when} | ${f.venue} | **${priceLine(cheapest.price, fx)}** | ${cheapest.title.split(' / ').pop()} |\n`;
    }
    md += '\n## 📋 Copy para WhatsApp\n\n';
    for (const { f, variants, includes, meta, cheapest } of onSale) {
      const soldOthers = variants.filter(v => !v.available);
      md += `<details><summary><b>${f.home} vs ${f.away}</b></summary>\n\n${copyFor(f, cheapest, soldOthers, includes, meta, fx)}\n\n</details>\n\n`;
    }
  }
  if (soldOut.length) {
    md += `## ❌ Agotados (${soldOut.length})\n\n`;
    for (const { f } of soldOut) md += `- ${f.home} vs ${f.away} (${fmtDate(f.date, 'es-AR', { weekday: 'short', day: 'numeric', month: 'short' })})\n`;
    md += '\n';
  }
  if (notOffered) md += `_${notOffered} partido(s) de la semana en Buenos Aires no los ofrecemos._\n\n`;
  md += '---\nPara los flyers: pedíselos a Claude ("armame los flyers de esta semana").\n';

  const out = process.argv[2];
  if (out) writeFileSync(out, md, 'utf8'); else process.stdout.write(md);
  console.error(`Fixtures: ${fixtures.length} · on sale: ${onSale.length} · sold out: ${soldOut.length} · not offered: ${notOffered}`);
}

export { loadFixtures, loadProducts, variantsForFixture, includeLines, priceLine, fmtDate, getJson, FX_URL, SITE_URL, TZ };

/* Only run when executed directly (the helpers above are reused by other scripts) */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
