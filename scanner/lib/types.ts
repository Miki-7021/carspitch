/**
 * Modèles de données du pipeline.
 *
 * Deux niveaux :
 *  - `RawAd` : ce qu'une page de résultats expose à un instant donné ;
 *  - `TrackedAd` : la fiche persistée d'une annonce qu'on garde sous
 *    surveillance, avec son historique de prix.
 *
 * Corrections imposées par les données réelles (cf. README, « Écarts constatés ») :
 * `publishedAt` n'existe que sur la page détail, `country` est un ISO-2 là où
 * l'URL attend `B/D/F`, et kilométrage/année arrivent en texte localisé.
 */

export type Platform = 'autoscout24' | '2ememain' | 'gocar' | 'paruvendu' | 'leboncoin' | 'lacentrale';

/** Codes pays ISO 3166-1 alpha-2 réellement renvoyés par AutoScout24. */
export type MarketCountry = 'BE' | 'FR' | 'DE' | 'NL' | 'LU' | 'IT' | 'ES' | 'AT';

export type OfferType = 'new' | 'used' | 'unknown';

export type SellerType = 'dealer' | 'private' | 'unknown';

/**
 * `active`  : annonce suivie (prix comparé à chaque relevé) ;
 * `removed` : vendue / retirée ;
 * `ignored` : vue mais hors périmètre du profil (année, motorisation, km…).
 *             Mémorisée pour ne pas être réévaluée et pour arrêter la pagination.
 */
export type TrackedStatus = 'active' | 'removed' | 'ignored';

export interface CarTargetProfile {
  /** Identifiant stable : sert de clé de logs et de colonne en base. */
  id: string;
  brand: string;
  model: string;
  /** Au moins un de ces mots-clés doit apparaître dans le texte de l'annonce. */
  engineKeywords: readonly string[];
  minYear: number;
  maxYear: number;
  maxMileageKm: number;
  /** Plafond « coup de fusil » : au-delà, on ne considère pas l'annonce comme une affaire. */
  targetMaxPrice: number;
  /** Cote marché d'un exemplaire au kilométrage « normal » (CarReliabilityReport). */
  referencePrice: number;
  /**
   * Cote par pays quand les marchés ne se valent pas (une Yaris allemande se
   * négocie structurellement moins cher qu'une belge). À défaut, `referencePrice`.
   */
  referencePriceByCountry?: Partial<Record<MarketCountry, number>>;
  /** Score de fiabilité sur 10 (CarReliabilityReport). */
  reliabilityScore: number;
  /** Décote minimale pour déclencher une alerte « première minute », en %. Défaut : 15. */
  minDiscountPercentage?: number;
  /** Kilométrage annuel « normal » pour ce modèle, base du calcul de décote. Défaut : 15 000. */
  expectedAnnualKm?: number;
}

/**
 * Annonce brute, telle qu'extraite d'une page de résultats.
 * Aucun champ n'est « deviné » : ce qui n'est pas publié est `null`.
 */
export interface RawAd {
  externalId: string;
  platform: Platform;
  title: string;
  /** Version / finition renvoyée par le site (« Yaris 1.3 VVT-i Dynamic »). */
  version: string | null;
  price: number;
  /** Année de 1re mise en circulation ; `null` si le véhicule est neuf. */
  year: number | null;
  mileage: number | null;
  country: MarketCountry;
  url: string;
  /** AutoScout24 ne publie pas la date de mise en ligne dans les listes. */
  scrapedAt: Date;
  /** Titre + version + motorisation, normalisé : sert au matching. */
  searchText: string;
  fuel: string | null;
  gearbox: string | null;
  powerKw: number | null;
  sellerType: SellerType;
  sellerName: string | null;
  imageUrl: string | null;
  /** Annonce « boostée » par le vendeur (doublon payant en tête de liste). */
  isSponsored: boolean;
  /** Le vendeur signale un véhicule endommagé. */
  isDamaged: boolean;
  offerType: OfferType;
}

/**
 * Fiche persistée d'une annonce surveillée.
 *
 * Les dates sont des chaînes ISO : ces fiches traversent JSON et PostgreSQL,
 * et une `Date` sérialisée en texte est plus simple à comparer qu'un objet
 * reconstruit à chaque lecture.
 */
export interface TrackedAd {
  platform: Platform;
  externalId: string;
  /**
   * Sélections (donc personnes) intéressées par cette annonce. Une même voiture
   * peut concerner plusieurs utilisateurs : toutes leurs alertes partent d'ici.
   */
  selectionIds: string[];
  /** Sélections déjà alertées « première minute » : le dédoublonnage est par personne. */
  notifiedPepite: string[];
  /** Sélections déjà alertées d'une baisse, avec le prix de l'alerte. */
  notifiedDrop: Record<string, number>;
  title: string;
  version: string | null;
  url: string;
  country: MarketCountry;
  year: number | null;
  mileage: number | null;
  fuel: string | null;
  /** Prix lors de la toute première découverte. */
  initialPrice: number;
  /** Prix constaté au dernier relevé. */
  lastPrice: number;
  /**
   * Prix de référence des alertes : dernier prix ayant déclenché une alerte
   * (ou prix initial). Une baisse est mesurée par rapport à cette valeur, pas
   * au dernier relevé — sinon deux baisses de 3 % ne déclencheraient jamais rien.
   */
  alertReferencePrice: number;
  /** Plus bas prix jamais constaté. */
  lowestPrice: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Dernier contrôle (liste ou page détail). Pilote la file de surveillance. */
  lastCheckedAt: string;
  lastAlertAt: string | null;
  alertCount: number;
  status: TrackedStatus;
  /** Médiane AutoScout24 des véhicules comparables, si la page détail a été lue. */
  marketMedian: number | null;
  /** Date de mise en ligne réelle, lue sur la page détail (`createdTimestampWithOffset`). */
  publishedAt: string | null;
}

/** Alerte envoyée quand le prix d'une annonce surveillée baisse. */
export interface PriceDropAlert {
  tracked: TrackedAd;
  newPrice: number;
  /** Prix de référence de l'alerte (dernier prix alerté / prix initial). */
  referencePrice: number;
  /** Prix du relevé précédent, pour distinguer « depuis le dernier scan » et « depuis le départ ». */
  previousPrice: number;
  dropAmount: number;
  dropPercentage: number;
  totalDropAmount: number;
  totalDropPercentage: number;
  estimatedValue: number;
  discountPercentage: number;
  isPepite: boolean;
}

export interface EvaluatedAd extends RawAd {
  profileId: string;
  reliabilityScore: number;
  /** Cote de référence corrigée du kilométrage réel. */
  estimatedValue: number;
  discountAmount: number;
  discountPercentage: number;
  isPepite: boolean;
}

export type RejectionReason =
  | 'price_missing'
  | 'year_missing'
  | 'year_out_of_range'
  | 'mileage_missing'
  | 'mileage_too_high'
  | 'engine_mismatch'
  | 'damaged'
  | 'above_target_price'
  | 'implausible_discount'
  | 'discount_too_low'
  | 'no_price_change'
  | 'drop_too_small'
  | 'still_overpriced'
  | 'removed';

export type EvaluationOutcome =
  | { status: 'matched'; ad: EvaluatedAd }
  | { status: 'rejected'; reason: RejectionReason; ad: RawAd };

export type PriceDropOutcome =
  | { status: 'matched'; alert: PriceDropAlert }
  | { status: 'rejected'; reason: RejectionReason; tracked: TrackedAd };

/** Raison pour laquelle une annonce de la page n'a pas pu être convertie en `RawAd`. */
export type ParseRejectionReason =
  | 'not_an_object'
  | 'missing_id'
  | 'missing_url'
  | 'missing_price'
  | 'unsupported_country'
  /** Annonce de pièces détachées ou d'accessoires, pas un véhicule. */
  | 'not_a_vehicle';
