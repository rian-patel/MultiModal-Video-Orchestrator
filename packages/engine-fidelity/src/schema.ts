/** What Claude returns per clip audit. */
export interface FidelityVerdict {
  verdict: 'faithful' | 'drift';
  /** Concrete fabrications spotted; empty when faithful. */
  problems: string[];
}

/**
 * JSON schema for structured outputs (output_config.format). Guarantees the
 * response parses into FidelityVerdict. Structured outputs require
 * additionalProperties:false and full `required`.
 */
export const FIDELITY_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['faithful', 'drift'],
      description:
        "'drift' when the clip materially misrepresents the property; 'faithful' otherwise",
    },
    problems: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Each concrete fabrication observed (what appeared/changed and in which frame). Empty when faithful.',
    },
  },
  required: ['verdict', 'problems'],
  additionalProperties: false,
} as const;
