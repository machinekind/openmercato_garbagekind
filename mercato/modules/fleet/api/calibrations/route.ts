import { calibrationRecordSchema } from '../../commands/robots'
import { executeCommandRoute } from '../../lib/commandRoute'

/**
 * Zapis pomiaru kalibracyjnego.
 *
 * Data ważności jest w schemacie obowiązkowa i taka zostaje także tutaj.
 * Formularz bez tego pola dałby kalibrację, o której nikt nigdy nie
 * przypomni - a robot z przeterminowanym pomiarem wygląda w każdym
 * zestawieniu identycznie jak sprawny.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['fleet.calibrate'] },
}

export async function POST(request: Request): Promise<Response> {
  return executeCommandRoute({
    request,
    routePath: 'fleet/calibrations',
    inputSchema: calibrationRecordSchema,
    commandId: 'fleet.calibrations.record',
    describeResource: (input) => ({ resourceKind: 'fleet.calibration', resourceId: input.robotId }),
    mapSuccess: (result: { calibrationId: string }) => ({ calibrationId: result.calibrationId }),
  })
}
