/**
 * Fonctions de normalisation pures (aucune dépendance, testables isolément).
 *
 * AutoScout24 renvoie ces valeurs en texte *localisé* : « 23 899 km » en fr-BE,
 * « 23.899 km » en de-DE, « 09-2023 » ou « new » pour la mise en circulation.
 * Tout le pipeline passe donc par ces helpers plutôt que par `Number()`.
 */

const NARROW_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const DIACRITICS = /[\u0300-\u036F]/g;

/** Majuscules, sans accents, espaces normalisés : forme canonique pour le matching. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(NARROW_SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** « Toyota Yaris 1.3 VVT-i » → « toyota-yaris-1-3-vvt-i » (segment d'URL AutoScout24). */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convertit un nombre éventuellement formaté en texte.
 *
 * Heuristique : pour des prix et des kilométrages (toujours entiers dans ce
 * domaine), un séparateur unique suivi d'exactement 3 chiffres est un séparateur
 * de milliers. « 2.750 » → 2750 (de-DE), « 23 899 » → 23899, « 12.5 » → 12.5.
 */
export function parseLocalizedNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;

  let value = input.replace(NARROW_SPACES, ' ').replace(/[^\d.,\s-]/g, '').trim();
  if (value === '') return null;
  value = value.replace(/\s/g, '');

  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');
  const occurrences = (char: string): number => value.split(char).length - 1;
  const digitsAfter = (index: number): number => value.length - index - 1;

  if (lastDot >= 0 && lastComma >= 0) {
    // Le dernier séparateur rencontré est le séparateur décimal.
    value =
      lastDot > lastComma
        ? value.replace(/,/g, '')
        : value.replace(/\./g, '').replace(/,/g, '.');
  } else if (lastComma >= 0) {
    value =
      occurrences(',') === 1 && digitsAfter(lastComma) === 3
        ? value.replace(/,/g, '')
        : value.replace(/,/g, '.');
  } else if (lastDot >= 0) {
    const isThousands = occurrences('.') > 1 || digitsAfter(lastDot) === 3;
    if (isThousands) value = value.replace(/\./g, '');
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Extrait l'année de première mise en circulation.
 * Gère « 09-2023 », « 09/2023 », « 2023 », et renvoie `null` pour « new ».
 */
export function parseYear(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= 1900 && input <= 2100 ? input : null;
  }
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (/^(new|neuf|neu|nuevo|nouveau)$/i.test(trimmed)) return null;

  const match = /(19\d{2}|20\d{2})/.exec(trimmed);
  if (!match?.[1]) return null;

  const year = Number(match[1]);
  return year >= 1900 && year <= 2100 ? year : null;
}

/**
 * Vrai si `keyword` apparaît comme un mot dans `searchText` (déjà normalisé).
 *
 * Un mot-clé contenant un chiffre (« 1.3 ») exige des bornes strictes pour ne
 * pas matcher « 1.33 » ni « 11.3 » ; un mot-clé alphabétique n'exige qu'une
 * borne à gauche, pour que « hybrid » matche « hybride ».
 */
export function matchesKeyword(searchText: string, keyword: string): boolean {
  // « 1,4 » et « 1.4 » sont la même cylindrée : en Belgique les annonces
  // utilisent la virgule décimale, un mot-clé saisi avec un point ne
  // correspondrait sinon à rien.
  const decimals = (input: string): string => input.replace(/(\d),(\d)/g, '$1.$2');

  const key = decimals(normalizeText(keyword));
  if (key === '') return false;

  const haystack = decimals(searchText);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return /[0-9]/.test(key)
    ? new RegExp(`(?<![0-9.])${escaped}(?![0-9])`).test(haystack)
    : new RegExp(`(?<![A-Z0-9])${escaped}`).test(haystack);
}

/** Arrondit à la centaine d'euros : une cote à 9 237 € n'a aucun sens. */
export function roundToHundreds(value: number): number {
  return Math.round(value / 100) * 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
