/**
 * Cotation de marché : transformer un échantillon d'annonces en un prix de
 * référence **défendable**.
 *
 * Le principe : pour un modèle et une fenêtre d'années, on observe des couples
 * (kilométrage, prix). Le prix baisse avec le kilométrage — on modélise donc
 * cette relation, puis on lit la valeur au kilométrage « attendu » (âge × km
 * annuels). Une voiture de 10 ans à 60 000 km doit valoir plus que la médiane
 * brute des annonces, qui mélange des véhicules à 40 000 et à 180 000 km.
 *
 * Trois exigences de fiabilité :
 *  - **robustesse** : les valeurs aberrantes sont écartées avant tout calcul ;
 *  - **honnêteté** : on ne rend jamais une cote sans dire sur combien
 *    d'annonces elle repose, ni à quel point elle est dispersée ;
 *  - **repli explicite** : sous 6 annonces, on retombe sur une médiane ajustée
 *    à la main et on l'annonce comme « faible » plutôt que de faire semblant.
 */

export interface PriceSample {
  price: number;
  km: number;
  year: number;
}

export type ValuationConfidence = 'solide' | 'indicative' | 'faible';
export type ValuationMethod = 'regression' | 'mediane-ajustee';

/** Pourquoi la régression a été écartée, quand c'est le cas. */
export type FallbackReason =
  | 'modele-indisponible'
  | 'echantillon-insuffisant'
  | 'r2-faible'
  | 'pente-positive';

export interface MarketValuation {
  /** Cote au kilométrage attendu, arrondie à la centaine d'euros. */
  value: number;
  sampleSize: number;
  /** Écart interquartile observé : la fourchette « normale » du marché. */
  range: { low: number; high: number };
  confidence: ValuationConfidence;
  method: ValuationMethod;
  /** Renseigné uniquement quand `method` vaut `mediane-ajustee`. */
  fallbackReason?: FallbackReason;
  /** Précision de l'ajustement linéaire, entre 0 et 1. */
  r2: number;
  /** Kilométrage auquel la cote est exprimée. */
  expectedKm: number;
  /** Année médiane de l'échantillon. */
  medianYear: number;
  computedAt: string;
}

export interface ValuationOptions {
  /** Année de référence pour calculer l'âge. */
  now?: Date;
  /** Fenêtre d'années acceptée. */
  yearFrom: number;
  yearTo: number;
  /** Kilométrage annuel « normal » du modèle. */
  expectedAnnualKm?: number;
  /** Nombre minimum d'annonces pour produire une cote. */
  minSamples?: number;
}

const DEFAULTS = {
  expectedAnnualKm: 15_000,
  minSamples: 3,
  /** En dessous, on ne tente pas de régression : trop peu de points. */
  regressionMinSamples: 8,
  /** En dessous de ce R², la régression n'explique pas les prix : on l'ignore. */
  minR2: 0.3,
  kmElasticity: 0.35,
  /** Bornes du repli « médiane ajustée » : au-delà de ±15 %, on extrapole. */
  minFactor: 0.85,
  maxFactor: 1.15,
} as const;

const roundToHundreds = (value: number): number => Math.round(value / 100) * 100;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Médiane d'une liste non vide. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Quantile par interpolation linéaire (0 ≤ p ≤ 1). */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;

  const position = clamp(p, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;

  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/** Kilométrage attendu pour une année donnée (âge × km annuels). */
export function expectedKmForYear(
  year: number,
  annualKm: number = DEFAULTS.expectedAnnualKm,
  now: Date = new Date(),
): number {
  const age = Math.max(1, now.getFullYear() - year + 0.5);
  return Math.round(age * annualKm);
}

/**
 * Écarte les prix aberrants : hors de la médiane ± 1,5 écart interquartile.
 * C'est ce qui protège la cote des annonces « pièces détachées » ou des
 * véhicules de collection surcôtés.
 */
export function trimOutliers(samples: readonly PriceSample[]): PriceSample[] {
  if (samples.length < 4) return [...samples];

  const prices = samples.map((sample) => sample.price);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;

  return samples.filter((sample) => sample.price >= low && sample.price <= high);
}

interface Fit {
  slope: number;
  intercept: number;
  r2: number;
}

/** Moindres carrés sur (km, prix). */
export function fitLinear(samples: readonly PriceSample[]): Fit {
  const n = samples.length;
  if (n < 2) return { slope: 0, intercept: samples[0]?.price ?? 0, r2: 0 };

  const meanKm = samples.reduce((sum, sample) => sum + sample.km, 0) / n;
  const meanPrice = samples.reduce((sum, sample) => sum + sample.price, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;

  for (const sample of samples) {
    const dx = sample.km - meanKm;
    const dy = sample.price - meanPrice;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanPrice - slope * meanKm;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

  return { slope, intercept, r2 };
}

// ─── Régression multiple (kilométrage + année) ──────────────────────────────

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Résolution d'un système linéaire (Gauss-Jordan, pivot partiel). */
function solve(matrix: readonly number[][], rhs: readonly number[]): number[] | null {
  const size = rhs.length;
  const a = matrix.map((row, index) => [...row, rhs[index] as number]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row]?.[column] ?? 0) > Math.abs(a[pivot]?.[column] ?? 0)) pivot = row;
    }

    if (Math.abs(a[pivot]?.[column] ?? 0) < 1e-12) return null;

    const pivotRow = a[pivot] as number[];
    const currentRow = a[column] as number[];
    a[pivot] = currentRow;
    a[column] = pivotRow;

    const divisor = pivotRow[column] as number;
    for (let index = column; index <= size; index += 1) {
      pivotRow[index] = (pivotRow[index] as number) / divisor;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const rowArray = a[row] as number[];
      const factor = rowArray[column] as number;
      if (factor === 0) continue;
      for (let index = column; index <= size; index += 1) {
        rowArray[index] = (rowArray[index] as number) - factor * (pivotRow[index] as number);
      }
    }
  }

  return a.map((row) => row[size] as number);
}

interface MultipleFit {
  /** Prédiction pour l'année et le kilométrage médians (référence). */
  predict(km: number, year: number): number;
  r2: number;
  /** Coefficient du kilométrage, en €/km (doit être négatif). */
  kmSlope: number;
}

/**
 * Ajuste `prix = a + b·km + c·année`.
 *
 * Les prédicteurs sont centrés-réduits : sans cela, la colinéarité entre l'âge
 * et le kilométrage rend le système instable. Une très légère pénalité (ridge)
 * garantit une solution unique même si l'échantillon ne varie que sur un axe.
 */
export function fitMultiple(samples: readonly PriceSample[]): MultipleFit | null {
  const n = samples.length;
  if (n < 4) return null;

  const kms = samples.map((sample) => sample.km);
  const years = samples.map((sample) => sample.year);
  const prices = samples.map((sample) => sample.price);

  const meanKm = mean(kms);
  const meanYear = mean(years);
  const meanPrice = mean(prices);
  const sdKm = standardDeviation(kms) || 1;
  const sdYear = standardDeviation(years) || 1;

  const design = samples.map((sample) => [
    1,
    (sample.km - meanKm) / sdKm,
    (sample.year - meanYear) / sdYear,
  ]);

  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];

  for (let i = 0; i < n; i += 1) {
    const row = design[i] as number[];
    const centered = (prices[i] as number) - meanPrice;

    for (let r = 0; r < 3; r += 1) {
      rhs[r] = (rhs[r] as number) + (row[r] as number) * centered;
      for (let c = 0; c < 3; c += 1) {
        const target = matrix[r] as number[];
        target[c] = (target[c] as number) + (row[r] as number) * (row[c] as number);
      }
    }
  }

  // Ridge : stabilise le système quand un prédicteur ne varie pas.
  for (let r = 1; r < 3; r += 1) {
    const row = matrix[r] as number[];
    row[r] = (row[r] as number) + 1e-6 * n;
  }

  const coefficients = solve(matrix, rhs);
  if (!coefficients) return null;

  const [intercept = 0, kmCoef = 0, yearCoef = 0] = coefficients;
  const predict = (km: number, year: number): number =>
    meanPrice +
    intercept +
    kmCoef * ((km - meanKm) / sdKm) +
    yearCoef * ((year - meanYear) / sdYear);

  let residualSum = 0;
  let totalSum = 0;
  for (const sample of samples) {
    const predicted = predict(sample.km, sample.year);
    residualSum += (sample.price - predicted) ** 2;
    totalSum += (sample.price - meanPrice) ** 2;
  }

  return {
    predict,
    r2: totalSum === 0 ? 0 : 1 - residualSum / totalSum,
    kmSlope: kmCoef / sdKm,
  };
}

/**
 * Calcule la cote d'un modèle à partir d'annonces comparables.
 *
 * @returns `null` si l'échantillon est trop maigre pour dire quoi que ce soit.
 */
export function computeMarketValue(
  samples: readonly PriceSample[],
  options: ValuationOptions,
): MarketValuation | null {
  const now = options.now ?? new Date();
  const annualKm = options.expectedAnnualKm ?? DEFAULTS.expectedAnnualKm;
  const minSamples = options.minSamples ?? DEFAULTS.minSamples;

  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.price) &&
      sample.price > 0 &&
      Number.isFinite(sample.km) &&
      sample.km >= 0 &&
      sample.year >= options.yearFrom &&
      sample.year <= options.yearTo,
  );

  if (usable.length < minSamples) return null;

  const cleaned = trimOutliers(usable);
  const prices = cleaned.map((sample) => sample.price);
  const medianYear = Math.round(median(cleaned.map((sample) => sample.year)));
  const expectedKm = expectedKmForYear(medianYear, annualKm, now);

  const kms = cleaned.map((sample) => sample.km);
  const minKm = Math.min(...kms);
  const maxKm = Math.max(...kms);
  // On n'extrapole jamais au-delà de ce qu'on a observé : à 30 000 km du
  // dernier point, une droite n'a plus aucune valeur prédictive.
  const targetKm = clamp(expectedKm, minKm, maxKm);

  let value: number;
  let method: ValuationMethod;

  const fit = fitMultiple(cleaned);
  // On conserve le R² même quand la régression est rejetée : c'est
  // l'information qui explique *pourquoi* on est retombé sur la médiane.
  const r2 = fit?.r2 ?? 0;

  // La régression n'est retenue que si elle explique réellement les prix.
  // Sans ce garde-fou, douze annonces hétérogènes produisent une droite à
  // R² = 0,12 qui sous-estime la cote de 15 % sans que rien ne le signale.
  const useRegression =
    cleaned.length >= DEFAULTS.regressionMinSamples &&
    fit !== null &&
    fit.r2 >= DEFAULTS.minR2 &&
    fit.kmSlope < 0;

  if (useRegression && fit) {
    value = fit.predict(targetKm, medianYear);
    method = 'regression';
  } else {
    const medianPrice = median(prices);
    const medianKm = median(kms);
    const gap = medianKm === 0 ? 0 : (targetKm - medianKm) / medianKm;
    const factor = clamp(1 - gap * DEFAULTS.kmElasticity, DEFAULTS.minFactor, DEFAULTS.maxFactor);
    value = medianPrice * factor;
    method = 'mediane-ajustee';
  }

  const fallbackReason: FallbackReason | undefined =
    method === 'regression'
      ? undefined
      : fit === null
        ? 'modele-indisponible'
        : cleaned.length < DEFAULTS.regressionMinSamples
          ? 'echantillon-insuffisant'
          : fit.r2 < DEFAULTS.minR2
            ? 'r2-faible'
            : 'pente-positive';

  if (!Number.isFinite(value) || value <= 0) return null;

  // Garde-fou final : une cote hors de la fourchette observée (à 40 % près)
  // signale un modèle instable — on la ramène dans le domaine du réel.
  value = clamp(value, quantile(prices, 0.1) * 0.6, quantile(prices, 0.9) * 1.4);

  const confidence: ValuationConfidence =
    cleaned.length >= 15 && method === 'regression' && r2 >= 0.55
      ? 'solide'
      : cleaned.length >= DEFAULTS.regressionMinSamples
        ? 'indicative'
        : 'faible';

  return {
    value: roundToHundreds(value),
    sampleSize: cleaned.length,
    range: {
      low: roundToHundreds(quantile(prices, 0.25)),
      high: roundToHundreds(quantile(prices, 0.75)),
    },
    confidence,
    method,
    ...(fallbackReason ? { fallbackReason } : {}),
    r2: Number(r2.toFixed(3)),
    expectedKm,
    medianYear,
    computedAt: now.toISOString(),
  };
}
