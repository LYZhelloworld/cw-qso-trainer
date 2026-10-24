import type { QsbOptions, QrmOptions, QrnOptions } from "./render.js";

/**
 * Difficulty → electromagnetic environment mapping.
 *
 * Per AUDIO-ENVIRONMENT.md:
 *
 * | 等级   | 底噪 | QSB      | QRM/QRN | 接收不全 |
 * | 新手   | 无   | 无       | 无      | 0%       |
 * | 进阶   | 低   | 慢衰落   | 偶发    | 1%       |
 * | 硬核   | 高   | 快衰落   | 较多    | 5%       |
 * | 自定义 | 可调 | 可调     | 可调    | 可调     |
 *
 * The "接收不全" probability itself lives in the VirtualHam / state-machine
 * layer (it drives `?`/`AGN?`); here we only map the *audio* environment
 * (signal fading + interference + noise floor).
 */
export type Difficulty = "novice" | "intermediate" | "hardcore" | "custom";

export interface Environment {
  qsb: QsbOptions;
  qrm: QrmOptions;
  qrn: QrnOptions;
}

const TABLE: Record<Exclude<Difficulty, "custom">, Environment> = {
  novice: {
    qsb: { enabled: false, periodSec: 10, depth: 0 },
    qrm: { enabled: false, interferers: 0, level: 0 },
    qrn: { enabled: false, level: 0 },
  },
  intermediate: {
    qsb: { enabled: true, periodSec: 10, depth: 0.3 }, // slow fade
    qrm: { enabled: true, interferers: 1, level: 0.03 }, // occasional
    qrn: { enabled: true, level: 0.02 }, // low noise floor
  },
  hardcore: {
    qsb: { enabled: true, periodSec: 2, depth: 0.6 }, // fast fade
    qrm: { enabled: true, interferers: 2, level: 0.08 }, // more interference
    qrn: { enabled: true, level: 0.06 }, // high noise floor
  },
};

export function difficultyToEnvironment(
  difficulty: Difficulty,
  custom?: Partial<Environment>,
): Environment {
  const base: Environment =
    difficulty === "custom"
      ? { qsb: { enabled: false, periodSec: 10, depth: 0 }, qrm: { enabled: false, interferers: 0, level: 0 }, qrn: { enabled: false, level: 0 } }
      : TABLE[difficulty];

  if (!custom) return base;
  return {
    qsb: { ...base.qsb, ...filterDefined(custom.qsb) },
    qrm: { ...base.qrm, ...filterDefined(custom.qrm) },
    qrn: { ...base.qrn, ...filterDefined(custom.qrn) },
  };
}

function filterDefined<T extends object>(o?: Partial<T>): Partial<T> {
  if (!o) return {};
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k] as T[keyof T];
  }
  return out;
}
