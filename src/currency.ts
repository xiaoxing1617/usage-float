export type Currency = "USD" | "CNY" | "JPY" | "SGD" | "EUR";
export const CURRENCIES: Currency[] = ["USD", "CNY", "JPY", "SGD", "EUR"];

export interface Rates {
  /** Units of each currency per 1 USD. */
  rates: Record<Currency, number>;
  /** Date the rates are for (YYYY-MM-DD), from the provider. */
  date: string;
  fetchedAt: number;
  fallback: boolean;
}

/** Rough values used only when offline and nothing is cached. */
const FALLBACK: Rates = {
  rates: { USD: 1, CNY: 7.1, JPY: 150, SGD: 1.3, EUR: 0.92 },
  date: "",
  fetchedAt: 0,
  fallback: true,
};

const KEY = "uf.rates";
const MAX_AGE = 12 * 60 * 60 * 1000;

function cached(): Rates | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || "null");
    return r && r.rates ? r : null;
  } catch {
    return null;
  }
}

/** ECB reference rates via Frankfurter (free, no key). Cached for 12 hours. */
export async function loadRates(force = false): Promise<Rates> {
  const c = cached();
  if (c && !force && Date.now() - c.fetchedAt < MAX_AGE) return c;
  const urls = [
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,JPY,SGD,EUR",
    "https://api.frankfurter.app/latest?from=USD&to=CNY,JPY,SGD,EUR",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      const r: Rates = {
        rates: { USD: 1, ...j.rates },
        date: j.date ?? "",
        fetchedAt: Date.now(),
        fallback: false,
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(r));
      } catch {
        /* storage unavailable */
      }
      return r;
    } catch {
      /* try next */
    }
  }
  return c ?? FALLBACK;
}

export function formatMoney(usd: number, cur: Currency, rates: Rates, locale: string): string {
  const v = usd * (rates.rates[cur] ?? 1);
  const digits = cur === "JPY" ? 0 : v !== 0 && Math.abs(v) < 1 ? 3 : 2;
  const num = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    Math.abs(v),
  );
  return (v < 0 ? "-" : "") + SYMBOL[cur] + num;
}

/** Unambiguous symbols: in Singapore "$" alone means SGD, and "¥" alone could be CNY or JPY. */
const SYMBOL: Record<Currency, string> = { USD: "US$", SGD: "S$", CNY: "¥", JPY: "JP¥", EUR: "€" };
