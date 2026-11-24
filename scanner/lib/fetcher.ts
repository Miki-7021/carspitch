/**
 * Étape 1 du pipeline — Ingestion / Fetcher.
 *
 * Deux implémentations derrière la même signature :
 *  - `fetch` natif (Node ≥ 22, zéro dépendance) — suffisant, vérifié sur les
 *    4 marchés BE/DE/FR/NL ;
 *  - `got-scraping` si l'on veut un fingerprint TLS/HTTP2 de navigateur
 *    (`npm i got-scraping` + `USE_GOT_SCRAPING=1`), utile derrière un VPS.
 *
 * Sécurité opérationnelle intégrée : throttle global (une requête à la fois,
 * espacement mini), backoff exponentiel avec jitter, timeout, détection 403.
 * Ces garde-fous ne sont pas cosmétiques : c'est ce qui évite le ban d'IP.
 */

import { slugify } from './normalize.ts';
import type { MarketCountry } from './types.ts';

export interface MarketplaceConfig {
  origin: string;
  locale: string;
}

/** Domaine + locale à utiliser comme « marché d'entrée » de la requête. */
export const MARKETPLACES: Readonly<Record<MarketCountry, MarketplaceConfig>> = {
  BE: { origin: 'https://www.autoscout24.be', locale: 'fr' },
  FR: { origin: 'https://www.autoscout24.fr', locale: 'fr' },
  DE: { origin: 'https://www.autoscout24.de', locale: 'de' },
  NL: { origin: 'https://www.autoscout24.nl', locale: 'nl' },
  LU: { origin: 'https://www.autoscout24.lu', locale: 'fr' },
  IT: { origin: 'https://www.autoscout24.it', locale: 'it' },
  ES: { origin: 'https://www.autoscout24.es', locale: 'es' },
  AT: { origin: 'https://www.autoscout24.at', locale: 'de' },
};

/**
 * AutoScout24 n'utilise PAS l'ISO-2 dans le paramètre `cy` mais ses codes
 * historiques. Un code invalide ne produit ni 400 ni 404 : le site répond 200
 * avec 0 résultat — un échec silencieux si l'on passe `cy=BE` au lieu de `cy=B`.
 */
export const COUNTRY_CODES: Readonly<Record<MarketCountry, string>> = {
  BE: 'B',
  FR: 'F',
  DE: 'D',
  NL: 'NL',
  LU: 'L',
  IT: 'I',
  ES: 'E',
  AT: 'A',
};

export interface SearchTarget {
  brand: string;
  model: string;
  /** Pays inclus dans la recherche. AutoScout24 accepte plusieurs codes : `cy=B,DE,FR,NL`. */
  countries: readonly MarketCountry[];
  page?: number;
  /** Première mise en circulation (année). Paramètre `fregfrom` du site. */
  yearFrom?: number;
  /** Dernière mise en circulation (année). Paramètre `fregto`. */
  yearTo?: number;
  /** Kilométrage maximum. Paramètre `kmto`. */
  maxKm?: number;
}

export interface FetchedPage {
  html: string;
  status: number;
  /** URL finale (après redirections) : sert de `baseUrl` au parser. */
  finalUrl: string;
}

export type FetchErrorCode = 'http' | 'network' | 'blocked' | 'timeout';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status: number | null;

  constructor(code: FetchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Nombre de *retry* (donc jusqu'à retries + 1 tentatives). */
  retries?: number;
  /** Espacement minimum entre deux requêtes, en ms. */
  minIntervalMs?: number;
  useGotScraping?: boolean;
  userAgent?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Horloge globale du throttle : un seul scan à la fois, espacement garanti. */
let nextAllowedRequestAt = 0;

async function throttle(minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const wait = nextAllowedRequestAt - now;
  nextAllowedRequestAt = Math.max(now, nextAllowedRequestAt) + minIntervalMs + Math.random() * 750;
  if (wait > 0) await sleep(wait);
}

/**
 * Construit l'URL de recherche triée par nouveauté.
 *
 * `sort=age&desc=1` est une clé de tri officielle du site (« Annonces les plus
 * récentes d'abord ») : c'est elle qui permet de s'arrêter dès qu'une page ne
 * contient plus que des annonces déjà vues.
 */
export function buildSearchUrl(target: SearchTarget, market: MarketCountry = 'BE'): string {
  const marketplace = MARKETPLACES[market];
  const url = new URL(
    `/${marketplace.locale}/lst/${slugify(target.brand)}/${slugify(target.model)}`,
    marketplace.origin,
  );

  url.searchParams.set('atype', 'C');
  url.searchParams.set('cy', target.countries.map((country) => COUNTRY_CODES[country]).join(','));
  url.searchParams.set('sort', 'age');
  url.searchParams.set('desc', '1');
  url.searchParams.set('ustate', 'N,U');

  // Filtres du site (vérifiés) : `fregfrom`/`fregto` = année de première mise
  // en circulation, `kmto` = kilométrage maximum. Sans eux, la liste triée par
  // nouveauté ne contient que des voitures récentes : inutile pour un profil
  // qui cherche un modèle de 2008 à 2017.
  if (target.yearFrom !== undefined) url.searchParams.set('fregfrom', String(target.yearFrom));
  if (target.yearTo !== undefined) url.searchParams.set('fregto', String(target.yearTo));
  if (target.maxKm !== undefined) url.searchParams.set('kmto', String(target.maxKm));

  url.searchParams.set('page', String(target.page ?? 1));

  return url.toString();
}

interface RawResponse {
  html: string;
  status: number;
  finalUrl: string;
}

async function viaFetch(url: string, timeoutMs: number, userAgent: string): Promise<RawResponse> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: 'https://www.autoscout24.be/',
    },
  });

  return {
    status: response.status,
    finalUrl: response.url || url,
    html: await response.text(),
  };
}

async function viaGotScraping(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<RawResponse> {
  // Import dynamique : la dépendance reste optionnelle.
  const specifier = 'got-scraping';
  const module = (await import(specifier)) as {
    gotScraping: (options: Record<string, unknown>) => Promise<{
      body: string;
      statusCode: number;
      url: string;
    }>;
  };

  const response = await module.gotScraping({
    url,
    timeout: { request: timeoutMs },
    headers: { 'user-agent': userAgent },
    // 404/410 doivent revenir comme des statuts, pas comme des exceptions :
    // c'est ainsi qu'on détecte une annonce vendue.
    throwHttpErrors: false,
  });

  return { html: response.body, status: response.statusCode, finalUrl: response.url || url };
}

/**
 * Récupère une page (liste ou fiche véhicule), avec retry et throttle.
 *
 * Contrairement à `fetchSearchPage`, un 404/410 est renvoyé tel quel : c'est le
 * signal qu'une annonce surveillée a été vendue ou retirée.
 *
 * @throws {FetchError} `blocked` (403), `http`, `network` ou `timeout`.
 */
export async function fetchPage(
  url: string,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  const {
    timeoutMs = 30_000,
    retries = 3,
    minIntervalMs = 3_000,
    useGotScraping = false,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  let lastError: FetchError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle(minIntervalMs);

    try {
      let response: RawResponse;
      if (useGotScraping) {
        try {
          response = await viaGotScraping(url, timeoutMs, userAgent);
        } catch (error) {
          if (error instanceof FetchError) throw error;
          console.warn('[fetcher] got-scraping indisponible, repli sur fetch natif :', error);
          response = await viaFetch(url, timeoutMs, userAgent);
        }
      } else {
        response = await viaFetch(url, timeoutMs, userAgent);
      }

      if (response.status === 200 || response.status === 404 || response.status === 410) {
        return { html: response.html, status: response.status, finalUrl: response.finalUrl };
      }

      if (response.status === 403) {
        throw new FetchError(
          'blocked',
          `403 sur ${url} : IP probablement filtrée. Espacer les scans ou passer par un proxy résidentiel.`,
          403,
        );
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new FetchError('http', `HTTP ${response.status} sur ${url}`, response.status);
      if (!retryable) throw lastError;
    } catch (error) {
      if (error instanceof FetchError) {
        if (error.code === 'blocked') throw error;
        lastError = error;
      } else {
        const isTimeout =
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError');
        lastError = new FetchError(
          isTimeout ? 'timeout' : 'network',
          `${isTimeout ? 'Timeout' : 'Erreur réseau'} sur ${url} : ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (attempt < retries) {
      const backoff = 800 * 2 ** attempt + Math.random() * 500;
      console.warn(
        `[fetcher] tentative ${attempt + 1}/${retries + 1} échouée (${lastError?.message}) — retry dans ${Math.round(backoff)} ms`,
      );
      await sleep(backoff);
    }
  }

  throw lastError ?? new FetchError('network', `Échec de la collecte de ${url}`);
}

/** Variante stricte pour les pages de résultats : seul un 200 est exploitable. */
export async function fetchSearchPage(
  url: string,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  const page = await fetchPage(url, options);

  if (page.status === 200) return page;

  throw new FetchError(
    'http',
    page.status === 404
      ? `404 sur ${url} : slug marque/modèle inconnu. Vérifier ${new URL(url).pathname}.`
      : `HTTP ${page.status} inattendu sur ${url}`,
    page.status,
  );
}
