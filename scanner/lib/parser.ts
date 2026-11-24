/**
 * Étape 2 du pipeline — Parser & Normalizer.
 *
 * AutoScout24 est une application Next.js (Pages Router) : la liste complète
 * des annonces de la page est sérialisée dans
 * `<script id="__NEXT_DATA__" type="application/json">`.
 *
 * → On parse ce JSON, on ne touche pas au DOM. C'est stable (indépendant du
 *   CSS / du rendu conditionnel), locale-proof (on lit `tracking.*`, pas les
 *   libellés traduits) et ~100× plus rapide qu'un querySelector par champ.
 *
 * Champs réellement disponibles (vérifiés sur les marchés BE/DE/FR/NL) :
 *   id                    → externalId
 *   price.priceRaw        → price (number, pas de virgule)
 *   tracking.mileage      → mileage (« 23899 », indépendant de la locale)
 *   tracking.firstRegistration → year (« 09-2023 », « new » pour un neuf)
 *   location.countryCode  → country (ISO-2)
 *   vehicle.*             → texte de matching (motorisation, version, carburant)
 *   vehicleDetails[]      → puissance (vignette « speedometer »)
 *
 * Aucune date de publication n'est exposée dans les listes : `scrapedAt` la
 * remplace, et le tri `sort=age` garantit que les plus récentes arrivent d'abord.
 * La page détail, elle, expose `createdTimestampWithOffset` (voir plus bas).
 */

import { normalizeText, parseLocalizedNumber, parseYear } from './normalize.ts';
import type {
  MarketCountry,
  OfferType,
  ParseRejectionReason,
  Platform,
  RawAd,
  SellerType,
} from './types.ts';

const PLATFORM: Platform = 'autoscout24';

/** Le script Next.js est le premier bloc `__NEXT_DATA__` de la page. */
const NEXT_DATA_PATTERN =
  /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

/** Signatures d'une page de blocage (captcha / WAF) au lieu d'une page de résultats. */
const BLOCK_MARKERS =
  /captcha|are you a robot|access denied|request blocked|unusual traffic|cloudflare|incapsula/i;

const SUPPORTED_COUNTRIES: ReadonlySet<string> = new Set<string>([
  'BE',
  'FR',
  'DE',
  'NL',
  'LU',
  'IT',
  'ES',
  'AT',
]);

export type ParserErrorCode =
  | 'blocked'
  | 'next_data_missing'
  | 'next_data_invalid'
  | 'page_props_missing'
  | 'detail_missing';

export class ParserError extends Error {
  readonly code: ParserErrorCode;

  constructor(code: ParserErrorCode, message: string) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
  }
}

export interface ParseContext {
  /** Origine de la marketplace, pour reconstruire les URLs relatives. */
  baseUrl: string;
  /** Heure du scan ; injectable pour rendre les tests déterministes. */
  scrapedAt?: Date;
}

export interface ParseRejection {
  externalId: string | null;
  reason: ParseRejectionReason;
}

export interface ParsedSearchPage {
  platform: Platform;
  ads: RawAd[];
  /** Annonces présentes dans la page mais inexploitables (télémétrie). */
  rejected: ParseRejection[];
  totalResults: number | null;
  totalPages: number | null;
  page: number;
  scrapedAt: Date;
}

// ─── Accès sûrs au JSON non typé ─────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return asRecord(record[key]);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

// ─── Extraction des champs d'une annonce ─────────────────────────────────────

function readPrice(listing: Record<string, unknown>): number | null {
  const price = readRecord(listing, 'price');
  if (!price) return null;

  // `priceRaw` est la seule valeur fiable (pas de séparateur, pas de devise).
  const raw = readNumber(price, 'priceRaw');
  if (raw !== null && raw > 0) return raw;

  const formatted = readString(price, 'priceFormatted');
  const parsed = formatted ? parseLocalizedNumber(formatted) : null;
  return parsed !== null && parsed > 0 ? parsed : null;
}

function readUrl(
  listing: Record<string, unknown>,
  baseUrl: string,
): string | null {
  const raw = readString(listing, 'url');
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function readCountry(listing: Record<string, unknown>): MarketCountry | null {
  const location = readRecord(listing, 'location');
  const code = location ? readString(location, 'countryCode')?.toUpperCase() : null;
  if (!code || !SUPPORTED_COUNTRIES.has(code)) return null;
  return code as MarketCountry;
}

function readMileage(
  listing: Record<string, unknown>,
  vehicle: Record<string, unknown>,
  tracking: Record<string, unknown>,
): number | null {
  // 1. `tracking.mileage` : chiffres bruts, identique dans toutes les langues.
  const tracked = parseLocalizedNumber(readString(tracking, 'mileage'));
  if (tracked !== null) return Math.trunc(tracked);

  // 2. Libellé localisé « 23 899 km » / « 23.899 km ».
  const labelled = parseLocalizedNumber(readString(vehicle, 'mileageInKm'));
  if (labelled !== null) return Math.trunc(labelled);

  // 3. Dernier recours : la vignette « kilométrage » de la carte.
  for (const detail of readArray(listing, 'vehicleDetails')) {
    const record = asRecord(detail);
    if (!record || readString(record, 'iconName') !== 'mileage_odometer') continue;
    const value = parseLocalizedNumber(readString(record, 'data'));
    if (value !== null) return Math.trunc(value);
  }
  return null;
}

function readYear(
  listing: Record<string, unknown>,
  tracking: Record<string, unknown>,
): number | null {
  // « 09-2023 » → 2023 ; « new » → null (véhicule neuf, hors périmètre).
  const tracked = parseYear(readString(tracking, 'firstRegistration'));
  if (tracked !== null) return tracked;

  // Repli : vignette calendrier au format « 09/2023 ».
  for (const detail of readArray(listing, 'vehicleDetails')) {
    const record = asRecord(detail);
    if (!record) continue;
    const label = readString(record, 'data');
    if (!label || !/^\d{2}\/\d{4}$/.test(label)) continue;
    const parsed = parseYear(label);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readPowerKw(listing: Record<string, unknown>): number | null {
  for (const detail of readArray(listing, 'vehicleDetails')) {
    const record = asRecord(detail);
    if (!record || readString(record, 'iconName') !== 'speedometer') continue;
    const match = /(\d+)\s*kW/i.exec(readString(record, 'data') ?? '');
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function readIsSponsored(listing: Record<string, unknown>): boolean {
  for (const parameter of readArray(listing, 'trackingParameters')) {
    const record = asRecord(parameter);
    if (!record) continue;
    if (
      readString(record, 'key') === 'relevance_adjustment' &&
      readString(record, 'value') === 'sponsored'
    ) {
      return true;
    }
  }
  return false;
}

function readSellerType(listing: Record<string, unknown>): SellerType {
  const seller = readRecord(listing, 'seller');
  const type = seller ? readString(seller, 'type') : null;
  if (type === 'Dealer') return 'dealer';
  if (type === 'Private') return 'private';
  return 'unknown';
}

function readSellerName(listing: Record<string, unknown>): string | null {
  const seller = readRecord(listing, 'seller');
  if (!seller) return null;
  return readString(seller, 'companyName') ?? readString(seller, 'contactName');
}

function readOfferType(vehicle: Record<string, unknown>): OfferType {
  const value = readString(vehicle, 'offerType');
  if (value === 'N') return 'new';
  if (value === 'U') return 'used';
  return 'unknown';
}

function readImageUrl(listing: Record<string, unknown>): string | null {
  const first = readArray(listing, 'images')[0];
  return typeof first === 'string' && first.startsWith('http') ? first : null;
}

/**
 * Texte de recherche : tout ce qui peut porter la motorisation, la version ou
 * la finition. C'est là que le mot-clé du profil (« 1.3 », « hybrid »…) est cherché.
 */
function buildSearchText(
  listing: Record<string, unknown>,
  vehicle: Record<string, unknown>,
): string {
  const parts = [
    readString(listing, 'title'),
    readString(vehicle, 'modelVersionInput'),
    readString(vehicle, 'modelVersionCustom'),
    readString(vehicle, 'variant'),
    readString(vehicle, 'motorTypeName'),
    readString(vehicle, 'engineDisplacementInCCM'),
    readString(vehicle, 'subtitle'),
  ].filter((part): part is string => part !== null);

  return normalizeText(parts.join(' '));
}

// ─── Mapping d'une annonce ───────────────────────────────────────────────────

function mapListing(
  entry: unknown,
  baseUrl: string,
  scrapedAt: Date,
): RawAd | ParseRejection {
  const listing = asRecord(entry);
  if (!listing) return { externalId: null, reason: 'not_an_object' };

  const externalId = readString(listing, 'id');
  if (!externalId) return { externalId: null, reason: 'missing_id' };

  const price = readPrice(listing);
  if (price === null) return { externalId, reason: 'missing_price' };

  const url = readUrl(listing, baseUrl);
  if (!url) return { externalId, reason: 'missing_url' };

  const country = readCountry(listing);
  if (!country) return { externalId, reason: 'unsupported_country' };

  const vehicle = readRecord(listing, 'vehicle') ?? {};
  const tracking = readRecord(listing, 'tracking') ?? {};

  return {
    externalId,
    platform: PLATFORM,
    title: readString(listing, 'title') ?? 'Annonce sans titre',
    version: readString(vehicle, 'modelVersionInput'),
    price,
    year: readYear(listing, tracking),
    mileage: readMileage(listing, vehicle, tracking),
    country,
    url,
    scrapedAt,
    searchText: buildSearchText(listing, vehicle),
    fuel: readString(vehicle, 'fuel'),
    gearbox: readString(vehicle, 'transmission'),
    powerKw: readPowerKw(listing),
    sellerType: readSellerType(listing),
    sellerName: readSellerName(listing),
    imageUrl: readImageUrl(listing),
    isSponsored: readIsSponsored(listing),
    isDamaged: vehicle['isCurrentlyDamaged'] === true,
    offerType: readOfferType(vehicle),
  };
}

// ─── Extraction de la charge utile Next.js ───────────────────────────────────

function readNextData(html: string): unknown {
  const match = NEXT_DATA_PATTERN.exec(html);

  if (!match?.[1]) {
    const head = html.slice(0, 20_000);
    if (BLOCK_MARKERS.test(head)) {
      throw new ParserError(
        'blocked',
        'Page de blocage / captcha renvoyée par AutoScout24 au lieu de résultats.',
      );
    }
    throw new ParserError(
      'next_data_missing',
      `Aucun bloc __NEXT_DATA__ dans la page (${html.length} octets) : structure changée, page vide ou page de consentement.`,
    );
  }

  try {
    return JSON.parse(match[1].trim()) as unknown;
  } catch (error) {
    throw new ParserError(
      'next_data_invalid',
      `__NEXT_DATA__ illisible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Convertit le HTML d'une page de résultats en annonces exploitables.
 *
 * @throws {ParserError} si la page n'est pas une page de résultats parsable.
 */
export function parseSearchPage(
  html: string,
  context: ParseContext,
): ParsedSearchPage {
  const scrapedAt = context.scrapedAt ?? new Date();
  const root = asRecord(readNextData(html));
  const props = root ? readRecord(root, 'props') : null;
  const pageProps = props ? readRecord(props, 'pageProps') : null;

  if (!pageProps) {
    throw new ParserError(
      'page_props_missing',
      '__NEXT_DATA__.props.pageProps absent : la page n’est pas une liste de résultats.',
    );
  }

  const ads: RawAd[] = [];
  const rejected: ParseRejection[] = [];

  for (const entry of readArray(pageProps, 'listings')) {
    const mapped = mapListing(entry, context.baseUrl, scrapedAt);
    if ('reason' in mapped) rejected.push(mapped);
    else ads.push(mapped);
  }

  const pageQuery = readRecord(pageProps, 'pageQuery');
  const pageFromQuery = pageQuery
    ? parseLocalizedNumber(readString(pageQuery, 'page'))
    : null;

  return {
    platform: PLATFORM,
    ads,
    rejected,
    totalResults: readNumber(pageProps, 'numberOfResults'),
    totalPages: readNumber(pageProps, 'numberOfPages'),
    page: pageFromQuery !== null ? Math.trunc(pageFromQuery) : 1,
    scrapedAt,
  };
}

// ─── Page détail : surveillance d'une annonce précise ────────────────────────

export interface ParsedDetailPage {
  externalId: string | null;
  price: number | null;
  /** `removed` = vendue ou retirée (HTTP 404/410, ou `status: "Inactive"`). */
  status: 'active' | 'removed';
  /** Vraie date de mise en ligne, absente des pages de liste. */
  publishedAt: Date | null;
  /** Médiane AutoScout24 des véhicules comparables. */
  marketMedian: number | null;
  title: string | null;
}

const EMPTY_REMOVED: ParsedDetailPage = {
  externalId: null,
  price: null,
  status: 'removed',
  publishedAt: null,
  marketMedian: null,
  title: null,
};

function firstNumber(...candidates: (number | null)[]): number | null {
  for (const candidate of candidates) {
    if (candidate !== null && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return null;
}

/**
 * Lit une page détail (`/fr/offres/…`) pour connaître le prix courant.
 *
 * C'est le seul moyen fiable de suivre une annonce dans le temps : les pages de
 * résultats sont triées par nouveauté, donc une annonce qui baisse de prix au
 * bout de trois semaines a disparu des premières pages.
 *
 * @param httpStatus Statut HTTP de la réponse (404/410 ⇒ annonce retirée).
 * @throws {ParserError} si la page n'est pas exploitable (blocage, structure).
 */
export function parseDetailPage(html: string, httpStatus = 200): ParsedDetailPage {
  const removedByStatus = httpStatus === 404 || httpStatus === 410;
  if (removedByStatus && !NEXT_DATA_PATTERN.test(html)) return EMPTY_REMOVED;

  const root = asRecord(readNextData(html));
  const props = root ? readRecord(root, 'props') : null;
  const pageProps = props ? readRecord(props, 'pageProps') : null;
  const details = pageProps ? readRecord(pageProps, 'listingDetails') : null;

  if (!details) {
    if (removedByStatus) return EMPTY_REMOVED;
    throw new ParserError(
      'detail_missing',
      '__NEXT_DATA__.props.pageProps.listingDetails absent : la page n’est pas une fiche véhicule.',
    );
  }

  const publicPrices = (() => {
    const prices = readRecord(details, 'prices');
    return prices ? readRecord(prices, 'public') : null;
  })();
  const trackingParams = readRecord(details, 'trackingParams');
  const priceBlock = readRecord(details, 'price');

  const price = firstNumber(
    publicPrices ? readNumber(publicPrices, 'priceRaw') : null,
    trackingParams ? readNumber(trackingParams, 'classified_price') : null,
    trackingParams ? parseLocalizedNumber(readString(trackingParams, 'classified_price')) : null,
    priceBlock ? parseLocalizedNumber(readString(priceBlock, 'priceFormatted')) : null,
    publicPrices ? parseLocalizedNumber(readString(publicPrices, 'price')) : null,
  );

  const statusField = readString(details, 'status');
  const isInactive = statusField !== null && statusField.toLowerCase() !== 'active';

  return {
    externalId: readString(details, 'id'),
    price,
    status: removedByStatus || isInactive ? 'removed' : 'active',
    publishedAt: (() => {
      const raw = readString(details, 'createdTimestampWithOffset');
      if (!raw) return null;
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? null : date;
    })(),
    marketMedian: publicPrices ? readNumber(publicPrices, 'median') : null,
    title: readString(details, 'title'),
  };
}
