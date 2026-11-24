/**
 * 2ememain.be — second site d'annonces, belge, très orienté particuliers.
 *
 * La page de résultats expose ses données en JSON dans `__NEXT_DATA__`, comme
 * AutoScout24, mais sous une autre forme :
 *
 *   props.pageProps.searchRequestAndResponse.listings[]
 *
 * Chaque annonce porte son identifiant (`m2466680135`), un prix **en centimes**,
 * et ses caractéristiques dans un tableau `attributes` (`constructionYear`,
 * `mileage`…). Il n'y a pas de champ « version » : le titre en tient lieu.
 *
 * Limite connue : la page de détail n'expose aucun JSON exploitable. 2ememain
 * est donc une plateforme **sans suivi de prix par fiche** — les annonces sont
 * revérifiées à chaque passage dans les résultats de recherche, ce qui suffit
 * tant qu'elles restent visibles sur les premières pages.
 */

import type {
  MarketCountry,
  ParseRejection,
  ParsedSearchPage,
  Platform,
  RawAd,
} from './types.ts';
import { normalizeText } from './normalize.ts';

export const PLATFORM: Platform = '2ememain';

const ORIGIN = 'https://www.2ememain.be';

export interface TwoEmemainTarget {
  brand: string;
  model: string;
  page?: number;
}

/**
 * URL de recherche.
 *
 * La pagination de 2ememain ne s'obtient pas avec `?page=` : le site attend un
 * décalage (`offset`), et la valeur limite déjà appliquée est de 30 annonces
 * par page. On s'en tient à la première page : les annonces suivies y
 * réapparaissent à chaque passage, et la découverte se fait par tri par date.
 */
export function buildTwoEmemainUrl(target: TwoEmemainTarget): string {
  const query = `${target.brand} ${target.model}`.trim().toLowerCase().replace(/\s+/g, '+');
  const offset = ((target.page ?? 1) - 1) * 30;
  return offset > 0 ? `${ORIGIN}/q/${query}/?offset=${offset}` : `${ORIGIN}/q/${query}/`;
}

// ─── Accès sûrs au JSON non typé ─────────────────────────────────────────────

type Unknown = Record<string, unknown>;

const asRecord = (value: unknown): Unknown | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Unknown)
    : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (record: Unknown | null, key: string): string | null => {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

const readNumber = (record: Unknown | null, key: string): number | null => {
  if (!record) return null;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const digits = value.replace(/[^\d]/g, '');
    return digits === '' ? null : Number(digits);
  }
  return null;
};

/** Récupère `__NEXT_DATA__` — l'attribut `crossorigin` interdit un motif rigide. */
export function readNextData(html: string): unknown {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) return null;

  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
}

// ─── Lecture d'une annonce ───────────────────────────────────────────────────

interface Attribute {
  key: string;
  value: string | number | null;
}

function readAttributes(listing: Unknown): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const raw of asArray(listing['attributes'])) {
    const attribute = asRecord(raw) as unknown as Attribute | null;
    if (!attribute?.key) continue;
    const value = attribute.value;
    if (value === null || value === undefined) continue;
    attributes.set(attribute.key, String(value).trim());
  }

  return attributes;
}

export interface TwoEmemainParseContext {
  market?: MarketCountry;
  scrapedAt?: Date;
  page?: number;
}

/**
 * Convertit une annonce brute en `RawAd`.
 *
 * Le prix est en centimes (`425000` = 4 250 €). Les annonces « à donner » ou
 * sans prix (`priceType` autre que FIXED/ NEGOTIABLE sans montant) sont
 * écartées : on ne peut pas comparer ce qui n'a pas de prix.
 */
export function mapTwoEmemainListing(
  raw: unknown,
  context: TwoEmemainParseContext = {},
): { ad: RawAd } | { rejection: ParseRejection } {
  const listing = asRecord(raw);
  if (!listing) return { rejection: { externalId: null, reason: 'not_an_object' } };

  const externalId = readString(listing, 'itemId');
  if (!externalId) return { rejection: { externalId: null, reason: 'missing_id' } };

  const title = readString(listing, 'title') ?? readString(listing, 'displayTitle') ?? '';

  const priceInfo = asRecord(listing['priceInfo']);
  const cents = readNumber(priceInfo, 'priceCents');
  const price = cents !== null && cents > 0 ? Math.round(cents / 100) : null;

  if (price === null) return { rejection: { externalId, reason: 'missing_price' } };

  const vipUrl = readString(listing, 'vipUrl');

  // Une recherche texte ramène aussi les pièces détachées (« phare droit Honda
  // Jazz », 40 €). Les véhicules vivent sous /v/autos/, les pièces sous
  // /v/autos-pieces-accessoires/ : sans ce filtre, une ampoule passerait pour
  // une pépite.
  if (vipUrl && !vipUrl.startsWith('/v/autos/')) {
    return { rejection: { externalId, reason: 'not_a_vehicle' } };
  }

  const url = vipUrl ? `${ORIGIN}${vipUrl.startsWith('/') ? '' : '/'}${vipUrl}` : null;
  if (!url) return { rejection: { externalId, reason: 'missing_url' } };

  const attributes = readAttributes(listing);
  const year = Number(attributes.get('constructionYear') ?? '') || null;
  const mileage = Number((attributes.get('mileage') ?? '').replace(/[^\d]/g, '')) || null;
  const description = readString(listing, 'description') ?? '';
  const fuel = attributes.get('fuel') ?? null;

  const seller = asRecord(listing['sellerInformation']);
  const sellerName = readString(seller, 'sellerName');
  const searchType = readString(listing, 'searchType');
  const sellerType = searchType === 'private' ? 'private' : searchType ? 'dealer' : 'unknown';

  const firstImage = asArray(listing['imageUrls'])[0];
  const imageUrl =
    typeof firstImage === 'string'
      ? firstImage.startsWith('//')
        ? `https:${firstImage}`
        : firstImage
      : null;

  const priority = readString(listing, 'priorityProduct');
  const isSponsored = priority !== null && priority !== 'NONE';

  // Le texte de recherche sert au filtrage par mots-clés du profil : il doit
  // contenir le titre **et** la description, où figure souvent la cylindrée.
  const searchText = `${title} ${description} ${attributes.get('version') ?? ''}`;
  const isDamaged = /damaged|accident|pour pi[eè]ces|pi[eè]ces d[eé]tach/i.test(
    `${title} ${description}`,
  );

  return {
    ad: {
      externalId,
      platform: PLATFORM,
      title: title || 'Annonce 2ememain',
      version: attributes.get('version') ?? null,
      price,
      year,
      mileage,
      country: context.market ?? 'BE',
      url,
      scrapedAt: context.scrapedAt ?? new Date(),
      searchText: normalizeText(searchText),
      fuel,
      gearbox: null,
      powerKw: null,
      sellerType,
      sellerName,
      imageUrl,
      isSponsored,
      isDamaged,
      offerType: 'used',
    },
  };
}

/** Parse une page de résultats 2ememain. */
export function parseTwoEmemainSearchPage(
  html: string,
  context: TwoEmemainParseContext = {},
): ParsedSearchPage {
  const scrapedAt = context.scrapedAt ?? new Date();
  const root = asRecord(readNextData(html));
  const props = asRecord(root?.['props']);
  const pageProps = asRecord(props?.['pageProps']);
  const search = asRecord(pageProps?.['searchRequestAndResponse']);
  const listings = asArray(search?.['listings']);

  const ads: RawAd[] = [];
  const rejected: ParseRejection[] = [];

  for (const raw of listings) {
    const result = mapTwoEmemainListing(raw, { ...context, scrapedAt });
    if ('ad' in result) ads.push(result.ad);
    else rejected.push(result.rejection);
  }

  const total = readNumber(search, 'totalResultCount');

  return {
    platform: PLATFORM,
    ads,
    rejected,
    totalResults: total,
    totalPages: null,
    page: context.page ?? 1,
    scrapedAt,
  };
}
