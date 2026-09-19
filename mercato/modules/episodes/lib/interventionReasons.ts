import { z } from 'zod'

/**
 * Wspólny słownik przyczyn interwencji operatora.
 *
 * To jest kontrakt raportowy, nie lista komunikatów UI. `reason` przechowuje
 * szczegół w języku człowieka, a kategoria ma pozostać stabilna między
 * robotami, politykami i wersjami oprogramowania edge.
 */
export const INTERVENTION_REASON_CATEGORIES = [
  'grasp_failure',
  'object_not_detected',
  'workspace_obstruction',
  'person_in_safety_zone',
  'policy_stall',
  'unsafe_motion',
  'joint_limit',
  'camera_fault',
  'tracking_loss',
  'material_jam',
  'power_fault',
  'hardware_fault',
  'communications_loss',
  'calibration_error',
  'operator_request',
  'other',
] as const

export const interventionReasonCategorySchema = z.enum(INTERVENTION_REASON_CATEGORIES)
export type InterventionReasonCategory = z.infer<typeof interventionReasonCategorySchema>
