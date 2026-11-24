/**
 * Scan des pépites — version autonome, sans base de données.
 *
 *   node scanner/scan.ts            (scan réel)
 *   DRY_RUN=1 node scanner/scan.ts  (aucun envoi, affichage seulement)
 *
 * Pour chaque modèle ciblé :
 *   1. lit les annonces AutoScout24 et 2ememain ;
 *   2. calcule une cote à partir de l'échantillon lui-même (régression
 *      prix ~ kilométrage + année, repli médiane) ;
 *   3. retient les annonces nettement sous la cote ;
 *   4. envoie une alerte Telegram et prévient la fonction `alert-match`,
 *      qui écrit aux personnes ayant demandé ce véhicule.
 *
 * Aucune dépendance externe : Node ≥ 22 suffit.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildSearchUrl, fetchSearchPage } from './lib/fetcher.ts';
import { parseSearchPage } from './lib/parser.ts';
import { buildTwoEmemainUrl, parseTwoEmemainSearchPage } from './lib/twoEmemain.ts';
import type { MarketCountry, RawAd } from './lib/types.ts';

// ─── Réglages ───────────────────────────────────────────────────────────────

const DRY_RUN = process.env['DRY_RUN'] === '1';
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? '';
const ALERT_MATCH_URL = process.env['ALERT_MATCH_URL'] ?? '';
const MATCH_SECRET = process.env['MATCH_SECRET'] ?? '';

const SITE = 'https://carspitch.app';
const MIN_DISCOUNT = 0.18;      // 18 % sous la cote
const MAX_ALERTS = 3;           // par passage
const MIN_SAMPLES = 6;          // annonces nécessaires pour une cote
const SEEN_FILE = new URL('./seen.json', import.meta.url);

interface Target {
  brand: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  maxPrice: number;
}

/** Modèles populaires en occasion : volume d'annonces suffisant pour coter. */
const TARGETS: Target[] = [
  { brand: 'Toyota', model: 'Yaris', yearFrom: 2010, yearTo: 2019, maxPrice: 11000 },
  { brand: 'Honda', model: 'Jazz', yearFrom: 2009, yearTo: 2018, maxPrice: 10000 },
  { brand: 'Renault', model: 'Clio', yearFrom: 2012, yearTo: 2019, maxPrice: 10000 },
  { brand: 'Peugeot', model: '208', yearFrom: 2012, yearTo: 2019, maxPrice: 10000 },
  { brand: 'Volkswagen', model: 'Polo', yearFrom: 2010, yearTo: 2018, maxPrice: 11000 },
  { brand: 'Volkswagen', model: 'Golf', yearFrom: 2010, yearTo: 2018, maxPrice: 13000 },
  { brand: 'Mazda', model: 'Mazda3', yearFrom: 2010, yearTo: 2018, maxPrice: 12000 },
  { brand: 'Suzuki', model: 'Swift', yearFrom: 2011, yearTo: 2019, maxPrice: 9000 },
];

const COUNTRIES: MarketCountry[] = ['BE', 'FR', 'NL', 'DE'];

// ─── Fiches carspitch ───────────────────────────────────────────────────────

interface Generation {
  slug: string;
  from: number;
  to: number;
}

const models: Record<string, Generation[]> = existsSync(new URL('./models.json', import.meta.url))
  ? JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'))
  : {};

/**
 * Fiche carspitch la plus proche de l'année de l'annonce.
 * On privilégie une génération qui contient l'année, puis la plus proche.
 */
const slugFor = (brand: string, model: string, year: number | null, fuel: string | null): string | null => {
  const list = models[`${brand}|${model}`.toLowerCase()];
  if (!list || list.length === 0) return null;
  if (!year) return list[0].slug;

  const wanted = String(fuel ?? '').toLowerCase();
  let best = list[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const generation of list) {
    const inside = year >= generation.from && year <= generation.to;
    const distance = inside
      ? 0
      : Math.min(Math.abs(year - generation.from), Math.abs(year - generation.to));
    let score = (inside ? 1000 : 0) - distance * 10 + generation.to / 100;

    // Le carburant départage deux générations de la même période : une fiche
    // diesel ne dit rien d'une voiture essence.
    if (wanted && generation.slug.includes(wanted)) score += 200;

    if (score > bestScore) {
      bestScore = score;
      best = generation;
    }
  }

  return best.slug;
};

// ─── Mémoire des annonces déjà vues ─────────────────────────────────────────

type Seen = Record<string, string>;

function loadSeen(): Seen {
  try {
    return JSON.parse(readFileSync(SEEN_FILE, 'utf8')) as Seen;
  } catch {
    return {};
  }
}

function saveSeen(seen: Seen): void {
  const entries = Object.entries(seen).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 3000);
  writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries(entries)), 'utf8');
}

// ─── Telegram ───────────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<boolean> {
  if (DRY_RUN) {
    console.log('\n--- message (simulation) ---\n' + text + '\n');
    return true;
  }
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents');
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: false }),
  });

  if (response.status === 429) {
    const body = await response.json().catch(() => null);
    const wait = Number(body?.parameters?.retry_after ?? 5);
    console.warn(`limite Telegram : nouvelle tentative dans ${wait} s`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000));
    return sendTelegram(text);
  }

  if (!response.ok) {
    console.error('telegram', response.status, await response.text());
    return false;
  }
  return true;
}

async function notifyMatcher(ad: RawAd, target: Target): Promise<void> {
  if (DRY_RUN || !ALERT_MATCH_URL) return;
  try {
    await fetch(ALERT_MATCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(MATCH_SECRET ? { 'x-match-secret': MATCH_SECRET } : {}),
      },
      body: JSON.stringify({
        title: ad.title,
        brand: target.brand,
        model: target.model,
        price: ad.price,
        year: ad.year,
        country: ad.country,
        url: ad.url,
        source: ad.platform,
        external_id: ad.externalId,
      }),
    });
  } catch (error) {
    console.error('alert-match', error);
  }
}

// ─── Collecte ───────────────────────────────────────────────────────────────

async function collectAutoscout(target: Target): Promise<RawAd[]> {
  const url = buildSearchUrl({
    brand: target.brand,
    model: target.model,
    countries: COUNTRIES,
    yearFrom: target.yearFrom,
    yearTo: target.yearTo,
    maxKm: 250000,
  });
  const page = await fetchSearchPage(url);
  return parseSearchPage(page.html, { baseUrl: page.finalUrl }).ads;
}

async function collectTwoEmemain(target: Target): Promise<RawAd[]> {
  try {
    const url = buildTwoEmemainUrl({ brand: target.brand, model: target.model });
    const page = await fetchSearchPage(url);
    return parseTwoEmemainSearchPage(page.html).ads;
  } catch (error) {
    console.warn('2ememain indisponible :', (error as Error).message);
    return [];
  }
}

// ─── Cote locale, par cohorte ───────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

interface Reference {
  expected: number;
  samples: number;
}

/**
 * Valeur de référence pour une annonce précise.
 *
 * On compare ce qui est comparable : même millésime (± 1 an) et kilométrage
 * voisin (± 60 000 km). Une cote calculée sur toute la production d'un modèle
 * mélange une 2010 et une 2019, et fabrique des remises de 60 % qui n'existent
 * pas. Les 10 % extrêmes sont écartés de part et d'autre.
 */
function referenceFor(ad: RawAd, ads: readonly RawAd[]): Reference | null {
  if (!ad.year || !ad.mileage) return null;

  const sameYear = ads.filter(
    (other) => other !== ad && other.year && Math.abs(other.year - ad.year!) <= 1 && other.price > 0,
  );
  const closeKm = sameYear.filter(
    (other) => other.mileage && Math.abs(other.mileage - ad.mileage!) <= 60_000,
  );

  const cohort = closeKm.length >= 5 ? closeKm : sameYear;
  const needed = closeKm.length >= 5 ? 5 : 8;
  if (cohort.length < needed) return null;

  const prices = cohort.map((other) => other.price).sort((a, b) => a - b);
  const from = Math.floor(prices.length * 0.1);
  const to = Math.ceil(prices.length * 0.9);
  const trimmed = prices.slice(from, Math.max(from + 1, to));

  return { expected: median(trimmed), samples: cohort.length };
}

function formatEuro(value: number): string {
  return new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
}

function buildMessage(ad: RawAd, target: Target, expected: number, discount: number, slug: string | null, samples: number): string {
  const lines = [
    '🔥 <b>Pépite</b>',
    `${ad.title}`,
    '',
    `💶 ${formatEuro(ad.price)} · médiane ${formatEuro(expected)} (${samples} annonces) → <b>-${Math.round(discount * 100)} %</b>`,
    ad.year ? `📅 ${ad.year}${ad.mileage ? ` · ${new Intl.NumberFormat('fr-BE').format(ad.mileage)} km` : ''}` : '',
    `📍 ${ad.country} · ${ad.sellerType === 'dealer' ? 'professionnel' : 'particulier'}`,
    '',
    `🔗 ${ad.url}`,
  ];

  if (slug) lines.push(`📘 Fiche fiabilité : ${SITE}/fr/voiture/${slug}/`);

  return lines.filter(Boolean).join('\n');
}

// ─── Programme principal ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const seen = loadSeen();
  const startedAt = new Date();
  let alerts = 0;
  let scanned = 0;

  for (const target of TARGETS) {
    if (alerts >= MAX_ALERTS) break;

    let ads: RawAd[] = [];
    try {
      ads = await collectAutoscout(target);
    } catch (error) {
      console.warn(`${target.brand} ${target.model} — AutoScout24 : ${(error as Error).message}`);
    }

    // 2ememain complète l'échantillon belge.
    const belgian = await collectTwoEmemain(target);
    ads = [...ads, ...belgian].filter((ad) => ad.price > 0 && ad.year && ad.mileage);

    scanned += ads.length;
    if (ads.length < MIN_SAMPLES) {
      console.log(`${target.brand} ${target.model} : ${ads.length} annonces, échantillon trop faible`);
      continue;
    }

    let found = 0;
    let compared = 0;

    for (const ad of ads) {
      if (alerts >= MAX_ALERTS) break;
      if (ad.price < 1500 || ad.price > target.maxPrice) continue;
      if (seen[`${ad.platform}:${ad.externalId}`]) continue;

      const reference = referenceFor(ad, ads);
      if (!reference) continue;
      compared += 1;

      const discount = (reference.expected - ad.price) / reference.expected;
      // Au-delà de 55 %, c'est presque toujours une annonce incomplète,
      // un véhicule accidenté ou une erreur de saisie : on ne l'annonce pas.
      if (discount < MIN_DISCOUNT || discount > 0.55) continue;

      seen[`${ad.platform}:${ad.externalId}`] = startedAt.toISOString();
      const slug = slugFor(target.brand, target.model, ad.year, ad.fuel);
      const sent = await sendTelegram(
        buildMessage(ad, target, reference.expected, discount, slug, reference.samples),
      );
      if (sent) {
        alerts += 1;
        found += 1;
        await notifyMatcher(ad, target);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    console.log(
      `${target.brand} ${target.model} : ${ads.length} annonces · ${compared} comparables · ${found} pépite(s)`,
    );
  }

  saveSeen(seen);
  console.log(`\nterminé : ${scanned} annonces lues, ${alerts} alerte(s)${DRY_RUN ? ' (simulation)' : ''}`);
}

await main();
