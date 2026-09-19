import { z } from 'zod'

export const POLICY_VECTOR_UNITS = [
  'rad',
  'deg',
  'm',
  'mm',
  'm/s',
  'mm/s',
  'rad/s',
  'deg/s',
  'N',
  'N*m',
  'kg',
  's',
  'normalized',
  'boolean',
  'pixel',
  'unitless',
] as const

export const POLICY_VALUE_SEMANTICS = [
  'absolute',
  'delta',
  'velocity',
  'effort',
  'binary',
  'encoded',
] as const

export const policyVectorFieldSchema = z.object({
  /** Stabilny klucz sygnału; pozycja w tablicy jest pozycją w wektorze. */
  key: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** Liczba kolejnych skalarów zajmowanych przez pole. */
  size: z.number().int().positive().max(100_000),
  unit: z.enum(POLICY_VECTOR_UNITS),
  /** Jawny układ, również dla stawów (`joint_space`) i wartości bez układu (`none`). */
  frame: z.string().trim().min(1).max(120),
  semantics: z.enum(POLICY_VALUE_SEMANTICS),
}).strict()

export const policyVectorSpecSchema = z.object({
  fields: z.array(policyVectorFieldSchema).min(1).max(512),
}).strict().superRefine((spec, ctx) => {
  const seen = new Set<string>()
  for (const [index, field] of spec.fields.entries()) {
    if (seen.has(field.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'key'], message: `Powtórzony klucz pola: ${field.key}.` })
    }
    seen.add(field.key)
  }
})

export type PolicyVectorSpec = z.infer<typeof policyVectorSpecSchema>

export function vectorDimension(spec: PolicyVectorSpec): number {
  return spec.fields.reduce((sum, field) => sum + field.size, 0)
}

export function sameVectorSpec(left: PolicyVectorSpec | null | undefined, right: PolicyVectorSpec): boolean {
  if (!left || left.fields.length !== right.fields.length) return false
  return left.fields.every((field, index) => {
    const candidate = right.fields[index]
    return candidate != null &&
      field.key === candidate.key &&
      field.size === candidate.size &&
      field.unit === candidate.unit &&
      field.frame === candidate.frame &&
      field.semantics === candidate.semantics
  })
}

export function demoJointContract(dofCount: number) {
  return {
    observationDim: dofCount,
    actionDim: dofCount,
    trainedDofCount: dofCount,
    controlFrequencyHz: 20,
    observationSpec: {
      fields: [{ key: 'joint.position', size: dofCount, unit: 'rad' as const, frame: 'joint_space', semantics: 'absolute' as const }],
    },
    actionSpec: {
      fields: [{ key: 'joint.target', size: dofCount, unit: 'rad' as const, frame: 'joint_space', semantics: 'absolute' as const }],
    },
  }
}
