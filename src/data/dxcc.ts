import ctyRaw from "../../data/cty.dat?raw";
import { parseCty } from "./cty.js";

export interface DxccEntity {
  dxcc: string;
  lat: number;
  lon: number;
  prefixes: string[];
  continent: string;
  /**
   * CQ zone (1–40), straight from `cty.dat`. It is the only field of a station's
   * location that is ever *sent* — the CQWW exchange — so unlike the country
   * name it is kept. See `qso/contest`.
   */
  cqZone: number;
}

export interface DxccData {
  entities: Record<string, DxccEntity>;
}

/**
 * DXCC dataset access. Builds an in-memory prefix -> DXCC-marker index and
 * answers "is this letter prefix valid?" queries used by callsign validation.
 *
 * The dataset is `data/cty.dat` parsed at module load. Its prefix entries are
 * callsign *starts*: the United States is listed as `AA`–`AK`, `K`, `N`, `W`
 * and nothing else, because `KA`/`WA`/`N6` are already covered by `K`/`W`/`N`.
 * So a letter prefix is valid when it equals a token, when a token extends it
 * (`B` → `BA`), or when it extends a token (`KA` → `K`). Checking only the
 * first direction would reject real callsigns such as KA1ABC.
 *
 * We only validate format — we never record or expose which country or region
 * a prefix belongs to.
 */
export class DxccDatabase {
  private readonly entities: Record<string, DxccEntity>;
  private readonly prefixToMarker = new Map<string, string>();

  constructor(data: DxccData) {
    this.entities = data.entities;
    for (const [marker, entity] of Object.entries(this.entities)) {
      for (const prefix of entity.prefixes) {
        // First marker wins: the format expects a top-to-bottom scan and says a
        // duplicate callsign encountered later is simply ignored.
        if (!this.prefixToMarker.has(prefix)) {
          this.prefixToMarker.set(prefix, marker);
        }
      }
    }
  }

  /** All known prefix tokens (for prefix matching). */
  get allPrefixes(): readonly string[] {
    return [...this.prefixToMarker.keys()];
  }

  /**
   * Resolve a letter prefix to a DXCC marker, or null if it matches nothing:
   * exact token, then a token that starts with it, then a token it starts with.
   */
  resolvePrefix(letterPrefix: string): string | null {
    const lp = letterPrefix.toUpperCase();
    if (!lp) return null;

    const exact = this.prefixToMarker.get(lp);
    if (exact !== undefined) return exact;

    for (const [token, marker] of this.prefixToMarker) {
      if (token.startsWith(lp)) return marker;
    }
    for (const [token, marker] of this.prefixToMarker) {
      if (lp.startsWith(token)) return marker;
    }
    return null;
  }

  /** Whether a letter prefix is a valid (known) prefix. */
  isValidPrefix(letterPrefix: string): boolean {
    return this.resolvePrefix(letterPrefix) !== null;
  }

  entity(marker: string): DxccEntity | undefined {
    return this.entities[marker];
  }

  /** All DXCC entities (for weighted generation / distance & continent pools). */
  listEntities(): DxccEntity[] {
    return Object.values(this.entities);
  }
}

// Singleton built from the bundled dataset (data/cty.dat).
export const dxccDatabase = new DxccDatabase(parseCty(ctyRaw));
