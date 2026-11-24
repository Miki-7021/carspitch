/**
 * Étape 4 du pipeline — Evaluator.
 *
 * Deux décisions distinctes, qui partagent les mêmes filtres de base :
 *
 *  - `evaluateAd`      : une annonce *nouvelle* est-elle une pépite ?
 *                        (prix très en dessous de la cote) → « première minute ».
 *  - `evaluatePriceDrop` : une annonce *déjà suivie* vient-elle de baisser ?
 *                        → « baisse de prix ».
 *
 * La seconde ne regarde pas la décote par rapport au marché : un vendeur qui
 * baisse son prix est un signal en soi. On vérifie seulement qu'il baisse
 * vraiment (seuil en % ET en euros), que l'annonce n'est pas devenue une épave
 * invraisemblable, et qu'elle n'est pas encore très au-dessus du marché.
 */

import { clamp, matchesKeyword, roundToHundreds } from './normalize.ts';
import type {
  CarTargetProfile,
  EvaluationOutcome,
  EvaluatedAd,
  MarketCountry,
  PriceDropAlert,
  PriceDropOutcome,
  RawAd,
  RejectionReason,
  TrackedAd,
} from './types.ts';

export const EVALUATION_DEFAULTS = {
  minDiscountPercentage: 15,
  expectedAnnualKm: 15_000,
  /** Élasticité prix/kilométrage : +100 % de km ⇒ −35 % de valeur. */
  kmElasticity: 0.35,
  minValueFactor: 0.7,
  maxValueFactor: 1.2,
  /** En dessous de ce ratio prix/cote, l'annonce est jugée invraisemblable. */
  minPlausibleRatio: 0.4,
} as const;

export const PRICE_DROP_DEFAULTS = {
  /** Baisse minimale, en % du prix de référence. */
  minDropPercentage: 4,
  /** Baisse minimale en euros : évite d'alerter sur « −300 € » d'une voiture à 25 000 €. */
  minDropAmount: 250,
  /** Au-delà de cote × 1,15, la voiture reste trop chère : une baisse n'en fait pas une affaire. */
  maxOverpriceRatio: 1.15,
} as const;

/** Ce dont le calcul de cote a besoin : `RawAd` comme `TrackedAd` y répondent. */
export interface ValuationInput {
  year: number | null;
  mileage: number | null;
  country: MarketCountry;
}

/**
 * Cote de référence applicable au pays de l'annonce.
 *
 * Comparer un prix allemand à une cote belge fabrique des « décotes » de 50 %
 * qui n'existent pas : chaque marché a son niveau de prix.
 */
export function resolveReferencePrice(
  profile: CarTargetProfile,
  country: MarketCountry,
): number {
  return profile.referencePriceByCountry?.[country] ?? profile.referencePrice;
}

/**
 * Cote de marché corrigée du kilométrage.
 *
 * Valeur de référence pour un kilométrage « normal » (âge × km annuels). Chaque
 * écart relatif de kilométrage déplace la valeur de `kmElasticity`, borné pour
 * éviter qu'une annonce à 20 000 km ne triple la cote.
 *
 * @returns `null` si l'année est inconnue (véhicule neuf).
 */
export function estimateMarketValue(
  ad: ValuationInput,
  profile: CarTargetProfile,
  now: Date = new Date(),
): number | null {
  if (ad.year === null) return null;

  const annualKm = profile.expectedAnnualKm ?? EVALUATION_DEFAULTS.expectedAnnualKm;
  // +0.5 an : une voiture immatriculée en décembre de l'année N a ~6 mois de plus.
  const ageYears = Math.max(1, now.getFullYear() - ad.year + 0.5);
  const expectedKm = ageYears * annualKm;
  const actualKm = ad.mileage ?? expectedKm;

  const relativeGap = (actualKm - expectedKm) / expectedKm;
  const factor = clamp(
    1 - relativeGap * EVALUATION_DEFAULTS.kmElasticity,
    EVALUATION_DEFAULTS.minValueFactor,
    EVALUATION_DEFAULTS.maxValueFactor,
  );

  return roundToHundreds(resolveReferencePrice(profile, ad.country) * factor);
}

/**
 * Filtres « durs » : le véhicule correspond-il au profil, indépendamment du prix ?
 *
 * Sert deux fois : à qualifier une nouvelle annonce, et à décider ce qui mérite
 * d'entrer en surveillance. Une annonce hors fenêtre d'années n'a aucune raison
 * d'être suivie : elle ne deviendra jamais éligible.
 */
export function checkProfileFit(
  ad: RawAd,
  profile: CarTargetProfile,
): RejectionReason | null {
  if (ad.price <= 0) return 'price_missing';
  if (ad.year === null) return 'year_missing';
  if (ad.year < profile.minYear || ad.year > profile.maxYear) return 'year_out_of_range';
  if (ad.mileage === null) return 'mileage_missing';
  if (ad.mileage > profile.maxMileageKm) return 'mileage_too_high';
  if (
    profile.engineKeywords.length > 0 &&
    !profile.engineKeywords.some((keyword) => matchesKeyword(ad.searchText, keyword))
  ) {
    return 'engine_mismatch';
  }
  if (ad.isDamaged) return 'damaged';
  return null;
}

/**
 * Évalue une annonce nouvelle contre un profil.
 *
 * `matched` ⇒ pépite (décote suffisante, prix sous le plafond, fiabilité et
 * kilométrage acceptables). `rejected` ⇒ raison du rejet.
 */
export function evaluateAd(
  ad: RawAd,
  profile: CarTargetProfile,
  now: Date = new Date(),
): EvaluationOutcome {
  const reject = (reason: RejectionReason): EvaluationOutcome => ({
    status: 'rejected',
    reason,
    ad,
  });

  const misfit = checkProfileFit(ad, profile);
  if (misfit) return reject(misfit);

  // Le plafond « coup de fusil » ne disqualifie pas l'annonce du suivi :
  // elle peut très bien baisser et repasser sous le plafond plus tard.
  if (ad.price > profile.targetMaxPrice) return reject('above_target_price');

  const estimatedValue = estimateMarketValue(ad, profile, now);
  if (estimatedValue === null || estimatedValue <= 0) return reject('year_missing');

  const discountAmount = estimatedValue - ad.price;
  const discountPercentage = Math.round((discountAmount / estimatedValue) * 100);
  const minDiscount = profile.minDiscountPercentage ?? EVALUATION_DEFAULTS.minDiscountPercentage;

  // Une décote de 70 % sur une voiture roulante n'existe pas : véhicule
  // accidenté, moteur HS, ou annonce d'appât. On préfère ne pas alerter.
  if (ad.price / estimatedValue < EVALUATION_DEFAULTS.minPlausibleRatio) {
    return reject('implausible_discount');
  }

  if (discountPercentage < minDiscount) return reject('discount_too_low');

  const evaluated: EvaluatedAd = {
    ...ad,
    profileId: profile.id,
    reliabilityScore: profile.reliabilityScore,
    estimatedValue,
    discountAmount,
    discountPercentage,
    isPepite: true,
  };

  return { status: 'matched', ad: evaluated };
}

export interface PriceDropOptions {
  minDropPercentage?: number;
  minDropAmount?: number;
  maxOverpriceRatio?: number;
}

/**
 * Évalue une baisse de prix sur une annonce déjà suivie.
 *
 * @param price Prix constaté (page liste ou page détail).
 */
export function evaluatePriceDrop(
  tracked: TrackedAd,
  price: number,
  profile: CarTargetProfile,
  now: Date = new Date(),
  options: PriceDropOptions = {},
): PriceDropOutcome {
  const reject = (reason: RejectionReason): PriceDropOutcome => ({
    status: 'rejected',
    reason,
    tracked,
  });

  if (tracked.status === 'removed') return reject('removed');
  if (!Number.isFinite(price) || price <= 0) return reject('price_missing');

  const minDropPercentage = options.minDropPercentage ?? PRICE_DROP_DEFAULTS.minDropPercentage;
  const minDropAmount = options.minDropAmount ?? PRICE_DROP_DEFAULTS.minDropAmount;
  const maxOverpriceRatio = options.maxOverpriceRatio ?? PRICE_DROP_DEFAULTS.maxOverpriceRatio;

  const referencePrice = tracked.alertReferencePrice;
  if (price >= referencePrice) return reject('no_price_change');

  const dropAmount = referencePrice - price;
  const dropPercentage = Math.round((dropAmount / referencePrice) * 100);

  if (dropPercentage < minDropPercentage || dropAmount < minDropAmount) {
    return reject('drop_too_small');
  }

  const estimatedValue = estimateMarketValue(tracked, profile, now);
  if (estimatedValue === null || estimatedValue <= 0) return reject('year_missing');

  // Véhicule bradé au tiers de sa valeur : épave, moteur HS ou arnaque.
  if (price / estimatedValue < EVALUATION_DEFAULTS.minPlausibleRatio) {
    return reject('implausible_discount');
  }

  // Une baisse de 10 % sur une voiture encore 30 % au-dessus du marché reste
  // une mauvaise affaire : le vendeur corrige simplement son prix de départ.
  if (price > estimatedValue * maxOverpriceRatio) return reject('still_overpriced');

  const discountPercentage = Math.round(((estimatedValue - price) / estimatedValue) * 100);
  const totalDropAmount = tracked.initialPrice - price;
  const totalDropPercentage = Math.round((totalDropAmount / tracked.initialPrice) * 100);

  const alert: PriceDropAlert = {
    tracked,
    newPrice: price,
    referencePrice,
    previousPrice: tracked.lastPrice,
    dropAmount,
    dropPercentage,
    totalDropAmount,
    totalDropPercentage,
    estimatedValue,
    discountPercentage,
    isPepite:
      discountPercentage >=
      (profile.minDiscountPercentage ?? EVALUATION_DEFAULTS.minDiscountPercentage),
  };

  return { status: 'matched', alert };
}
