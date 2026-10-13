import dxccJson from "../../data/dxcc.json";

export interface DxccEntity {
  dxcc: string;
  lat: number;
  lon: number;
  prefixes: string[];
  /** Continent approximated from lat/lon (coarse; for the trainer's weighting). */
  continent: string;
}

export interface DxccData {
  source: string;
  coordinate_note: string;
  count: number;
  entities: Record<string, DxccEntity>;
}

/**
 * DXCC dataset access. Builds an in-memory prefix -> DXCC-marker index and
 * answers "is this letter prefix valid?" queries used by callsign validation.
 *
 * Matching rule (per MESSAGE-PARSING.md / QSO-PROTOCOL.md): a callsign's letter
 * prefix (letters before the first digit, operation suffix `/...` removed) is
 * valid if it equals some known prefix token exactly, OR is a head substring of
 * one (e.g. `B` is the head of `BA`/`BD`/`BG`/...). We only validate format —
 * we never record or expose which country/region a prefix belongs to.
 */
export class DxccDatabase {
  private readonly entities: Record<string, DxccEntity>;
  private readonly prefixToMarker = new Map<string, string>();

  constructor(data: DxccData) {
    this.entities = data.entities;
    for (const [marker, entity] of Object.entries(this.entities)) {
      for (const prefix of entity.prefixes) {
        // First marker wins; all real prefixes map unambiguously for validation.
        if (!this.prefixToMarker.has(prefix)) {
          this.prefixToMarker.set(prefix, marker);
        }
      }
    }
  }

  /** All known prefix tokens (for head-substring matching). */
  get allPrefixes(): readonly string[] {
    return [...this.prefixToMarker.keys()];
  }

  /**
   * Resolve a letter prefix to a DXCC marker, or null if it matches nothing.
   * Exact match first, then head-substring (some known prefix starts with it).
   */
  resolvePrefix(letterPrefix: string): string | null {
    const lp = letterPrefix.toUpperCase();
    const exact = this.prefixToMarker.get(lp);
    if (exact !== undefined) return exact;
    for (const token of this.prefixToMarker.keys()) {
      if (token.startsWith(lp)) return this.prefixToMarker.get(token)!;
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

// Singleton built from the bundled dataset (data/dxcc.json).
export const dxccDatabase = new DxccDatabase(dxccJson as unknown as DxccData);
